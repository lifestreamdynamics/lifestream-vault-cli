/**
 * Remote change poller for continuous sync.
 * Periodically checks the remote vault for changes and pulls them down.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import type { SyncConfig } from './types.js';
import { shouldIgnore } from './ignore.js';
import { loadSyncState, saveSyncState, hashFileContent, buildRemoteFileState } from './state.js';
import { updateLastSync } from './config.js';
import { resolveConflict, detectConflict, createConflictFile, formatConflictLog } from './conflict.js';

export interface PollerOptions {
  /** Patterns to ignore */
  ignorePatterns: string[];
  /** Poll interval in ms (default: 30000) */
  intervalMs?: number;
  /** Callback for log messages */
  onLog?: (message: string) => void;
  /** Callback for conflict log messages */
  onConflictLog?: (message: string) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;
  /** Callback when a file is written locally (for watcher loop prevention) */
  onLocalWrite?: (docPath: string) => void;
}

/**
 * Creates and starts a remote poller for a sync configuration.
 * Returns a stop function.
 */
export function createRemotePoller(
  client: LifestreamVaultClient,
  config: SyncConfig,
  options: PollerOptions,
): { stop: () => void } {
  const {
    ignorePatterns,
    intervalMs = 30000,
    onLog,
    onConflictLog,
    onError,
    onLocalWrite,
  } = options;

  const log = (msg: string) => onLog?.(`[poll:${config.id.slice(0, 8)}] ${msg}`);
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  async function poll(): Promise<void> {
    if (polling) return; // Skip if previous poll still in progress
    polling = true;

    try {
      const remoteDocs = await client.documents.list(config.vaultId);
      const state = loadSyncState(config.id);
      let changes = 0;

      for (const doc of remoteDocs) {
        if (shouldIgnore(doc.path, ignorePatterns)) continue;

        const lastRemote = state.remote[doc.path];

        // Detect remote changes by comparing mtime
        const remoteChanged = !lastRemote || doc.fileModifiedAt !== lastRemote.mtime;
        if (!remoteChanged) continue;

        // Fetch the full content
        const { content } = await client.documents.get(config.vaultId, doc.path);
        const remoteHash = hashFileContent(content);

        // Skip if hash hasn't actually changed
        if (lastRemote && remoteHash === lastRemote.hash) {
          // Update mtime in state but skip file operations
          state.remote[doc.path] = buildRemoteFileState(doc.path, content, doc.fileModifiedAt);
          continue;
        }

        const localFile = path.join(config.localPath, doc.path);
        const localExists = fs.existsSync(localFile);

        if (localExists) {
          const localContent = fs.readFileSync(localFile, 'utf-8');
          const localHash = hashFileContent(localContent);

          if (localHash === remoteHash) {
            // Content is already the same — just update state
            state.local[doc.path] = { path: doc.path, hash: localHash, mtime: new Date().toISOString(), size: Buffer.byteLength(localContent) };
            state.remote[doc.path] = buildRemoteFileState(doc.path, content, doc.fileModifiedAt);
            continue;
          }

          // Check for conflict
          const lastLocal = state.local[doc.path];
          const localState = { path: doc.path, hash: localHash, mtime: fs.statSync(localFile).mtime.toISOString(), size: Buffer.byteLength(localContent) };
          const remoteState = { path: doc.path, hash: remoteHash, mtime: doc.fileModifiedAt, size: Buffer.byteLength(content) };

          if (detectConflict(localState, remoteState, lastLocal, lastRemote)) {
            const resolution = resolveConflict(config.onConflict, localState, remoteState);
            let conflictFile: string | null = null;

            if (resolution === 'remote') {
              conflictFile = createConflictFile(config.localPath, doc.path, localContent, 'local');
              onLocalWrite?.(doc.path);
              fs.writeFileSync(localFile, content, 'utf-8');
              log(`Conflict: ${doc.path} — used remote, saved local as ${conflictFile}`);
            } else {
              conflictFile = createConflictFile(config.localPath, doc.path, content, 'remote');
              await client.documents.put(config.vaultId, doc.path, localContent);
              log(`Conflict: ${doc.path} — used local, saved remote as ${conflictFile}`);
            }

            onConflictLog?.(formatConflictLog(doc.path, resolution, conflictFile));

            state.local[doc.path] = resolution === 'remote' ? remoteState : localState;
            state.remote[doc.path] = resolution === 'remote'
              ? buildRemoteFileState(doc.path, content, doc.fileModifiedAt)
              : buildRemoteFileState(doc.path, localContent, new Date().toISOString());
            changes++;
            continue;
          }
        }

        // No conflict — download the file
        const dir = path.dirname(localFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        onLocalWrite?.(doc.path);
        fs.writeFileSync(localFile, content, 'utf-8');
        log(`Pulled: ${doc.path}`);
        changes++;

        state.local[doc.path] = {
          path: doc.path,
          hash: remoteHash,
          mtime: new Date().toISOString(),
          size: Buffer.byteLength(content),
        };
        state.remote[doc.path] = buildRemoteFileState(doc.path, content, doc.fileModifiedAt);
      }

      // Check for remote deletions
      for (const docPath of Object.keys(state.remote)) {
        if (shouldIgnore(docPath, ignorePatterns)) continue;
        const stillExists = remoteDocs.some(d => d.path === docPath);
        if (!stillExists) {
          const localFile = path.join(config.localPath, docPath);
          if (fs.existsSync(localFile)) {
            fs.unlinkSync(localFile);
            log(`Deleted local: ${docPath} (removed from remote)`);
            changes++;
          }
          delete state.local[docPath];
          delete state.remote[docPath];
        }
      }

      if (changes > 0) {
        saveSyncState(state);
        updateLastSync(config.id);
        log(`Poll complete: ${changes} change(s)`);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      polling = false;
    }
  }

  // Initial poll
  poll().catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));

  // Start interval
  timer = setInterval(() => {
    poll().catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
  }, intervalMs);

  log(`Polling every ${intervalMs / 1000}s`);

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log('Stopped polling');
    },
  };
}
