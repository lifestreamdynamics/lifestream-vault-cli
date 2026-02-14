/**
 * Diff generation for sync operations.
 * Compares local and remote file states to determine what actions are needed.
 */
import type { FileState, SyncState, SyncMode } from './types.js';

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
}

/**
 * Compute the diff between local and remote state for a pull operation.
 * Pull = download remote changes to local.
 */
export function computePullDiff(
  localFiles: Record<string, FileState>,
  remoteFiles: Record<string, FileState>,
  lastState: SyncState,
): SyncDiff {
  const downloads: SyncDiffEntry[] = [];
  const deletes: SyncDiffEntry[] = [];

  // Files on remote that need to be downloaded
  for (const [docPath, remote] of Object.entries(remoteFiles)) {
    const local = localFiles[docPath];
    const lastRemote = lastState.remote[docPath];

    if (!local) {
      // File exists remotely but not locally
      if (lastState.local[docPath]) {
        // Was previously synced but deleted locally — remote wins on pull
        downloads.push({
          path: docPath,
          action: 'create',
          direction: 'download',
          sizeBytes: remote.size,
          reason: 'Deleted locally, exists remotely (pull restores)',
        });
      } else {
        // New remote file
        downloads.push({
          path: docPath,
          action: 'create',
          direction: 'download',
          sizeBytes: remote.size,
          reason: 'New remote file',
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
      });
    } else if (!lastRemote && remote.hash !== local.hash) {
      // First sync, files differ — remote wins on pull
      downloads.push({
        path: docPath,
        action: 'update',
        direction: 'download',
        sizeBytes: remote.size,
        reason: 'Content differs (first sync, pull prefers remote)',
      });
    }
  }

  // Files deleted from remote since last sync
  for (const docPath of Object.keys(lastState.remote)) {
    if (!remoteFiles[docPath] && localFiles[docPath]) {
      deletes.push({
        path: docPath,
        action: 'delete',
        direction: 'download',
        sizeBytes: 0,
        reason: 'Deleted from remote',
      });
    }
  }

  const totalBytes = downloads.reduce((sum, d) => sum + d.sizeBytes, 0);
  return { uploads: [], downloads, deletes, totalBytes };
}

/**
 * Compute the diff between local and remote state for a push operation.
 * Push = upload local changes to remote.
 */
export function computePushDiff(
  localFiles: Record<string, FileState>,
  remoteFiles: Record<string, FileState>,
  lastState: SyncState,
): SyncDiff {
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
      });
    } else if (!lastLocal && local.hash !== remote.hash) {
      // First sync, files differ — local wins on push
      uploads.push({
        path: docPath,
        action: 'update',
        direction: 'upload',
        sizeBytes: local.size,
        reason: 'Content differs (first sync, push prefers local)',
      });
    }
  }

  // Files deleted locally since last sync
  for (const docPath of Object.keys(lastState.local)) {
    if (!localFiles[docPath] && remoteFiles[docPath]) {
      deletes.push({
        path: docPath,
        action: 'delete',
        direction: 'upload',
        sizeBytes: 0,
        reason: 'Deleted locally',
      });
    }
  }

  const totalBytes = uploads.reduce((sum, u) => sum + u.sizeBytes, 0);
  return { uploads, downloads: [], deletes, totalBytes };
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
