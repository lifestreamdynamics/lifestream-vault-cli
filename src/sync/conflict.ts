/**
 * Conflict detection and resolution for bidirectional sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FileState, ConflictStrategy } from './types.js';
import { resolveWithinSyncRoot } from './safe-path.js';

export interface ConflictInfo {
  /** Document path (relative) */
  docPath: string;
  /** Local file state */
  local: FileState;
  /** Remote file state */
  remote: FileState;
  /** Previous known state (from last sync) */
  lastKnown: FileState | undefined;
}

export type ConflictResolution = 'local' | 'remote';

/**
 * Detect if a file has a bidirectional conflict.
 * A conflict exists when both local and remote have changed since last sync
 * AND they now hold different content. Two sides that independently arrived at
 * the same bytes are already in agreement and need no resolution.
 */
export function detectConflict(
  local: FileState,
  remote: FileState,
  lastLocal: FileState | undefined,
  lastRemote: FileState | undefined,
): boolean {
  if (local.hash === remote.hash) return false;
  if (!lastLocal || !lastRemote) {
    // First sync — conflict if hashes differ
    return true;
  }
  const localChanged = local.hash !== lastLocal.hash;
  const remoteChanged = remote.hash !== lastRemote.hash;
  return localChanged && remoteChanged;
}

/**
 * Resolve a conflict using the specified strategy.
 *
 * The `ask` strategy never resolves automatically: no interactive prompt is
 * wired into the watcher, poller, or daemon, so it throws and leaves both
 * versions in place for `lsvault sync resolve`.
 */
export function resolveConflict(
  strategy: ConflictStrategy,
  local: FileState,
  remote: FileState,
): ConflictResolution {
  switch (strategy) {
    case 'local':
      return 'local';
    case 'remote':
      return 'remote';
    case 'newer':
      return new Date(local.mtime) >= new Date(remote.mtime) ? 'local' : 'remote';
    case 'ask':
      throw new Error(
        `Conflict on ${local.path}: the 'ask' strategy does not resolve conflicts automatically${process.stdin.isTTY ? '' : ' (no interactive terminal)'}. `
        + 'Run `lsvault sync resolve <syncId> <path> --use local|remote`, or configure --on-conflict newer|local|remote.',
      );
  }
}

/**
 * Create a conflict backup file with a timestamped name.
 * Returns the path of the created conflict file.
 *
 * The file is created with the `wx` flag so an existing file is never
 * overwritten; on a name collision a numeric suffix is appended.
 */
export function createConflictFile(
  localPath: string,
  docPath: string,
  content: string,
  source: 'local' | 'remote',
): string {
  resolveWithinSyncRoot(localPath, docPath);
  const ext = path.extname(docPath);
  const base = ext ? docPath.slice(0, -ext.length) : docPath;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stem = `${base}.conflicted.${source}.${timestamp}`;

  const MAX_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const conflictPath = attempt === 0 ? `${stem}${ext}` : `${stem}-${attempt}${ext}`;
    const absPath = resolveWithinSyncRoot(localPath, conflictPath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      fs.writeFileSync(absPath, content, { encoding: 'utf-8', flag: 'wx' });
      return conflictPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Could not create a unique conflict backup for ${docPath} after ${MAX_ATTEMPTS} attempts.`);
}

/**
 * Format a conflict log entry.
 */
export function formatConflictLog(
  docPath: string,
  resolution: ConflictResolution,
  conflictFilePath: string | null,
): string {
  const ts = new Date().toISOString();
  const conflictNote = conflictFilePath ? ` (backup: ${conflictFilePath})` : '';
  return `[${ts}] CONFLICT ${docPath}: resolved=${resolution}${conflictNote}`;
}
