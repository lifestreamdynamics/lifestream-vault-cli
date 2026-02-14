/**
 * Conflict detection and resolution for bidirectional sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FileState, ConflictStrategy } from './types.js';

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
 * A conflict exists when both local and remote have changed since last sync.
 */
export function detectConflict(
  local: FileState,
  remote: FileState,
  lastLocal: FileState | undefined,
  lastRemote: FileState | undefined,
): boolean {
  if (!lastLocal || !lastRemote) {
    // First sync — conflict if hashes differ
    return local.hash !== remote.hash;
  }
  const localChanged = local.hash !== lastLocal.hash;
  const remoteChanged = remote.hash !== lastRemote.hash;
  return localChanged && remoteChanged;
}

/**
 * Resolve a conflict using the specified strategy.
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
      // 'ask' cannot be resolved automatically — caller must handle interactively.
      // Default to 'newer' as fallback when non-interactive.
      return new Date(local.mtime) >= new Date(remote.mtime) ? 'local' : 'remote';
  }
}

/**
 * Create a conflict backup file with a timestamped name.
 * Returns the path of the created conflict file.
 */
export function createConflictFile(
  localPath: string,
  docPath: string,
  content: string,
  source: 'local' | 'remote',
): string {
  const ext = path.extname(docPath);
  const base = docPath.slice(0, -ext.length);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const conflictPath = `${base}.conflicted.${source}.${timestamp}${ext}`;
  const absPath = path.join(localPath, conflictPath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(absPath, content, 'utf-8');
  return conflictPath;
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
