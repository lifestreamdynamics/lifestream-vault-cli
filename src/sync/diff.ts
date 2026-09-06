/**
 * Diff generation for sync operations.
 * Compares local and remote file states to determine what actions are needed.
 */
import type { FileState, SyncState, SyncMode, DeletionAnomaly, DeletionTarget } from './types.js';
import { assessDeletions } from './mass-delete-guard.js';
import { assertNoPathCollisions, type PathFoldOptions } from './path-collision.js';

export type SyncAction = 'create' | 'update' | 'delete';
export type SyncDirection = 'upload' | 'download';

export interface SyncDiffEntry {
  /** Document path (relative, forward slashes) */
  path: string;
  /** What needs to happen */
  action: SyncAction;
  /** Direction of the operation */
  direction: SyncDirection;
  /** File size in bytes (for progress reporting) */
  sizeBytes: number;
  /** Human-readable reason for this change */
  reason: string;
  /**
   * SHA-256 hash of the remote file at diff-computation time.
   * Present on download entries so executePull can issue a conditional GET
   * (If-None-Match) and skip the write when the local file is already current.
   */
  remoteHash?: string;
}

export interface SyncDiff {
  /** Files to upload (local -> remote) */
  uploads: SyncDiffEntry[];
  /** Files to download (remote -> local) */
  downloads: SyncDiffEntry[];
  /** Files to delete */
  deletes: SyncDiffEntry[];
  /** Total bytes to transfer */
  totalBytes: number;
  /**
   * Set when the mass-delete guard refused this run's deletion batch. The
   * deletions are absent from `deletes`; every create/update still applies.
   */
  deletionAnomaly?: DeletionAnomaly;
}

export interface DiffOptions {
  /**
   * Apply the deletion batch even when the mass-delete guard would refuse it
   * (`lsvault sync pull|push --allow-mass-delete`). Never set by the daemon.
   */
  allowMassDelete?: boolean;
  /**
   * How the local filesystem folds path names, from `resolvePathFold` at the
   * caller's impure boundary. A resolved value, not a dependency: these
   * functions do no I/O. Omitted, the platform default applies, which is what
   * every caller did before the probe existed.
   */
  fold?: PathFoldOptions;
}


/**
 * Apply the mass-delete guard to a batch of listing-derived deletions.
 *
 * Returns the entries to act on plus, when the guard refused, the anomaly to
 * report and persist. Shared by both directions so the pull and push halves
 * cannot drift apart — they are the same defect with different blast radii.
 */
function applyDeletionGuard(
  candidates: SyncDiffEntry[],
  knownCount: number,
  target: DeletionTarget,
  options: DiffOptions,
): { deletes: SyncDiffEntry[]; deletionAnomaly?: DeletionAnomaly } {
  const assessment = assessDeletions(candidates.length, knownCount, target);
  if (assessment.allow || options.allowMassDelete) return { deletes: candidates };
  return {
    deletes: [],
    deletionAnomaly: {
      target,
      detectedAt: new Date().toISOString(),
      removedCount: candidates.length,
      knownCount,
      reason: assessment.reason ?? 'Deletion batch refused by the mass-delete guard.',
    },
  };
}

/**
 * Compute the diff between local and remote state for a pull operation.
 * Pull = download remote changes to local.
 */
export function computePullDiff(
  localFiles: Record<string, FileState>,
  remoteFiles: Record<string, FileState>,
  lastState: SyncState,
  options: DiffOptions = {},
): SyncDiff {
  assertNoPathCollisions([...Object.keys(remoteFiles), ...Object.keys(localFiles)], options.fold);

  const downloads: SyncDiffEntry[] = [];
  const deletes: SyncDiffEntry[] = [];

  // Files on remote that need to be downloaded
  for (const [docPath, remote] of Object.entries(remoteFiles)) {
    const local = localFiles[docPath];
    const lastRemote = lastState.remote[docPath];

    if (!local) {
      // File exists remotely but not locally
      if (lastState.local[docPath]) {
        // A local delete the server refused (403, admin-only in a team vault)
        // is not a document waiting to be restored — restoring it here is what
        // turns a permanent rejection into an endless delete/restore loop. Leave
        // it absent until the marker is cleared.
        if (lastState.deniedDeletes?.[docPath]) continue;
        // Was previously synced but deleted locally — remote wins on pull
        downloads.push({
          path: docPath,
          action: 'create',
          direction: 'download',
          sizeBytes: remote.size,
          reason: 'Deleted locally, exists remotely (pull restores)',
          remoteHash: remote.hash,
        });
      } else {
        // New remote file
        downloads.push({
          path: docPath,
          action: 'create',
          direction: 'download',
          sizeBytes: remote.size,
          reason: 'New remote file',
          remoteHash: remote.hash,
        });
      }
    } else if (lastRemote && remote.hash !== lastRemote.hash) {
      // Remote file changed since last sync
      downloads.push({
        path: docPath,
        action: 'update',
        direction: 'download',
        sizeBytes: remote.size,
        reason: 'Remote file updated',
        remoteHash: remote.hash,
      });
    } else if (!lastRemote && remote.hash !== local.hash) {
      // First sync, files differ — remote wins on pull
      downloads.push({
        path: docPath,
        action: 'update',
        direction: 'download',
        sizeBytes: remote.size,
        reason: 'Content differs (first sync, pull prefers remote)',
        remoteHash: remote.hash,
      });
    }
  }

  // Files deleted from remote since last sync
  const trackedRemotePaths = Object.keys(lastState.remote);
  const candidateDeletes: SyncDiffEntry[] = [];
  for (const docPath of trackedRemotePaths) {
    if (!remoteFiles[docPath] && localFiles[docPath]) {
      candidateDeletes.push({
        path: docPath,
        action: 'delete',
        direction: 'download',
        sizeBytes: 0,
        reason: 'Deleted from remote',
      });
    }
  }

  // A short remote listing is indistinguishable from a bulk delete, and acting
  // on the wrong one is unrecoverable. Creates and updates still apply — only
  // the destructive half is withheld.
  const guarded = applyDeletionGuard(candidateDeletes, trackedRemotePaths.length, 'local', options);
  deletes.push(...guarded.deletes);
  const deletionAnomaly = guarded.deletionAnomaly;

  const totalBytes = downloads.reduce((sum, d) => sum + d.sizeBytes, 0);
  return { uploads: [], downloads, deletes, totalBytes, ...(deletionAnomaly ? { deletionAnomaly } : {}) };
}

/**
 * Compute the diff between local and remote state for a push operation.
 * Push = upload local changes to remote.
 */
export function computePushDiff(
  localFiles: Record<string, FileState>,
  remoteFiles: Record<string, FileState>,
  lastState: SyncState,
  options: DiffOptions = {},
): SyncDiff {
  assertNoPathCollisions([...Object.keys(remoteFiles), ...Object.keys(localFiles)], options.fold);

  const uploads: SyncDiffEntry[] = [];
  const deletes: SyncDiffEntry[] = [];

  // Files locally that need to be uploaded
  for (const [docPath, local] of Object.entries(localFiles)) {
    const remote = remoteFiles[docPath];
    const lastLocal = lastState.local[docPath];

    if (!remote) {
      // File exists locally but not remotely
      if (lastState.remote[docPath]) {
        // Was previously synced but deleted remotely — local wins on push
        uploads.push({
          path: docPath,
          action: 'create',
          direction: 'upload',
          sizeBytes: local.size,
          reason: 'Deleted remotely, exists locally (push restores)',
        });
      } else {
        // New local file
        uploads.push({
          path: docPath,
          action: 'create',
          direction: 'upload',
          sizeBytes: local.size,
          reason: 'New local file',
        });
      }
    } else if (lastLocal && local.hash !== lastLocal.hash) {
      // Local file changed since last sync
      uploads.push({
        path: docPath,
        action: 'update',
        direction: 'upload',
        sizeBytes: local.size,
        reason: 'Local file updated',
        // The remote hash observed while diffing. executePush sends it as an
        // If-Match precondition so a remote edit landing between this comparison
        // and the write is refused rather than silently overwritten. A 'create'
        // entry has no remote counterpart and correctly carries no hash.
        remoteHash: remote.hash,
      });
    } else if (!lastLocal && local.hash !== remote.hash) {
      // First sync, files differ — local wins on push
      uploads.push({
        path: docPath,
        action: 'update',
        direction: 'upload',
        sizeBytes: local.size,
        reason: 'Content differs (first sync, push prefers local)',
        remoteHash: remote.hash,
      });
    }
  }

  // Files deleted locally since last sync
  const trackedLocalPaths = Object.keys(lastState.local);
  const candidateDeletes: SyncDiffEntry[] = [];
  for (const docPath of trackedLocalPaths) {
    if (!localFiles[docPath] && remoteFiles[docPath]) {
      candidateDeletes.push({
        path: docPath,
        action: 'delete',
        direction: 'upload',
        sizeBytes: 0,
        reason: 'Deleted locally',
        // Guards the preflight-to-delete window; see the upload branches above.
        remoteHash: remoteFiles[docPath].hash,
      });
    }
  }

  // The mirror of the pull-side guard, and the more destructive of the two: a
  // local scan that came back short (an unmounted drive, an empty mount point)
  // deletes documents from the vault every other client syncs from, including
  // clients that were never near the fault. Uploads still apply.
  const guarded = applyDeletionGuard(candidateDeletes, trackedLocalPaths.length, 'remote', options);
  deletes.push(...guarded.deletes);

  const totalBytes = uploads.reduce((sum, u) => sum + u.sizeBytes, 0);
  return {
    uploads, downloads: [], deletes, totalBytes,
    ...(guarded.deletionAnomaly ? { deletionAnomaly: guarded.deletionAnomaly } : {}),
  };
}

/**
 * Format a diff for human-readable display.
 */
export function formatDiff(diff: SyncDiff): string {
  const lines: string[] = [];
  const allEntries = [...diff.downloads, ...diff.uploads, ...diff.deletes];

  if (allEntries.length === 0) {
    return 'Everything is up to date.';
  }

  for (const entry of diff.downloads) {
    const symbol = entry.action === 'delete' ? '-' : entry.action === 'create' ? '+' : '~';
    lines.push(`  ${symbol} ${entry.path} (${entry.reason})`);
  }
  for (const entry of diff.uploads) {
    const symbol = entry.action === 'delete' ? '-' : entry.action === 'create' ? '+' : '~';
    lines.push(`  ${symbol} ${entry.path} (${entry.reason})`);
  }
  for (const entry of diff.deletes) {
    lines.push(`  - ${entry.path} (${entry.reason})`);
  }

  const totalFiles = allEntries.length;
  const totalKB = Math.ceil(diff.totalBytes / 1024);
  lines.push('');
  lines.push(`${totalFiles} file(s), ${totalKB} KB to transfer`);

  return lines.join('\n');
}
