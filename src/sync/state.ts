/**
 * Sync state tracking.
 * Manages per-sync state files at ~/.lsvault/sync-state/<syncId>.json.
 * Tracks file hashes and modification times for change detection.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { SyncState, FileState } from './types.js';
import { atomicWriteFileSync } from './atomic-write.js';

const STATE_DIR = path.join(os.homedir(), '.lsvault', 'sync-state');

function stateFilePath(syncId: string): string {
  return path.join(STATE_DIR, `${syncId}.json`);
}

/**
 * Load sync state for a given sync configuration.
 * Returns a fresh empty state if no state file exists.
 *
 * A state file that exists but cannot be parsed throws. An empty state is not
 * a safe substitute: it makes every remote file look new and every local file
 * look untracked, so a subsequent push/pull diff would plan spurious
 * transfers and, in the worst case, deletions.
 */
export function loadSyncState(syncId: string): SyncState {
  const filePath = stateFilePath(syncId);
  if (!fs.existsSync(filePath)) {
    return {
      syncId,
      local: {},
      remote: {},
      updatedAt: new Date(0).toISOString(),
    };
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Sync state file ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (
    parsed === null || typeof parsed !== 'object'
    || typeof (parsed as SyncState).local !== 'object' || (parsed as SyncState).local === null
    || typeof (parsed as SyncState).remote !== 'object' || (parsed as SyncState).remote === null
  ) {
    throw new Error(`Sync state file ${filePath} is malformed (expected local/remote maps).`);
  }
  return parsed as SyncState;
}

/**
 * Save sync state to disk (temp file + rename, mode 0600).
 */
export function saveSyncState(state: SyncState): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  }
  state.updatedAt = new Date().toISOString();
  atomicWriteFileSync(stateFilePath(state.syncId), JSON.stringify(state) + '\n', 'utf-8', { mode: 0o600 });
}

/**
 * Delete sync state for a given sync configuration.
 * Returns true if the state file was found and deleted.
 */
export function deleteSyncState(syncId: string): boolean {
  const filePath = stateFilePath(syncId);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Compute SHA-256 hash of a file's content.
 */
export function hashFileContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Build a FileState entry from a file path on the local filesystem.
 * The docPath should be the relative document path (forward slashes).
 */
export function buildFileState(absolutePath: string, docPath: string): FileState {
  const content = fs.readFileSync(absolutePath);
  const stat = fs.statSync(absolutePath);
  return {
    path: docPath,
    hash: hashFileContent(content),
    mtime: stat.mtime.toISOString(),
    size: stat.size,
  };
}

/**
 * Build a FileState entry from remote content (e.g., from the API).
 */
export function buildRemoteFileState(
  docPath: string,
  content: string,
  updatedAt: string,
): FileState {
  return {
    path: docPath,
    hash: hashFileContent(content),
    mtime: updatedAt,
    size: Buffer.byteLength(content, 'utf-8'),
  };
}

/**
 * Check if a file has changed compared to a known state.
 */
export function hasFileChanged(current: FileState, known: FileState): boolean {
  return current.hash !== known.hash;
}

/**
 * Drop denied-delete markers that no longer describe reality.
 *
 * A marker is stale once the remote document is gone (someone with the right
 * role deleted it) or the local file is back (the user restored it, so there is
 * nothing left to suppress). Leaving it in place would keep `computePullDiff`
 * refusing to restore a document that is now legitimately syncable.
 *
 * @returns the paths whose markers were cleared.
 */
export function pruneDeniedDeletes(
  state: SyncState,
  remoteFiles: Record<string, FileState>,
  localFiles: Record<string, FileState>,
): string[] {
  if (!state.deniedDeletes) return [];
  const cleared: string[] = [];
  for (const docPath of Object.keys(state.deniedDeletes)) {
    if (!remoteFiles[docPath] || localFiles[docPath]) {
      delete state.deniedDeletes[docPath];
      cleared.push(docPath);
    }
  }
  if (Object.keys(state.deniedDeletes).length === 0) delete state.deniedDeletes;
  return cleared;
}
