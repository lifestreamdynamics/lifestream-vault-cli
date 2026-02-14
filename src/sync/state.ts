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

const STATE_DIR = path.join(os.homedir(), '.lsvault', 'sync-state');

function stateFilePath(syncId: string): string {
  return path.join(STATE_DIR, `${syncId}.json`);
}

/**
 * Load sync state for a given sync configuration.
 * Returns a fresh empty state if no state file exists.
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
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as SyncState;
  } catch {
    return {
      syncId,
      local: {},
      remote: {},
      updatedAt: new Date(0).toISOString(),
    };
  }
}

/**
 * Save sync state to disk.
 */
export function saveSyncState(state: SyncState): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(stateFilePath(state.syncId), JSON.stringify(state, null, 2) + '\n');
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
