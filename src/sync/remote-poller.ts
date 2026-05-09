/**
 * Remote change poller for continuous sync.
 * Periodically checks the remote vault for changes and pulls them down.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LifestreamVaultClient, SyncListKnownState } from '@lifestreamdynamics/vault-sdk';
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
      const state = loadSyncState(config.id);
      let changes = 0;
      let stateMutated = false;

      // Build the known state from persisted remote hashes + stored list ETag.
      const known: SyncListKnownState = {
        hashes: Object.fromEntries(
          Object.entries(state.remote).map(([k, v]) => [k, v.hash]),
        ),
        listEtag: state.remoteListEtag,
      };

      const sync = await client.documents.syncList(config.vaultId, known);

      // Steady-state: server confirmed nothing changed — skip all per-doc work.
      if (sync.vaultUnchanged) return;

      // Persist the new list ETag so the next poll can 304.
      state.remoteListEtag = sync.listEtag;
      stateMutated = true;

      // Process added/changed documents.
      for (const change of sync.changes) {
        if (shouldIgnore(change.path, ignorePatterns)) continue;

        const lastRemote = state.remote[change.path];

        let content: string;
        let remoteHash: string;

        if (lastRemote) {
          // Conditional GET — server can still 304 us if our hash is current
          // (rare: syncList classified this as 'changed' but the GET hash matches
          // our last-known hash — possible race between list and get).
          const result = await client.documents.get(config.vaultId, change.path, {
            ifNoneMatch: `"${lastRemote.hash}"`,
          });
          if (result.notModified) {
            // Server confirmed our copy is current despite differing list hash.
            // Update mtime only; no file write needed.
            if (lastRemote.mtime !== change.fileModifiedAt) {
              state.remote[change.path] = { ...lastRemote, mtime: change.fileModifiedAt };
              stateMutated = true;
            }
            continue;
          }
          content = result.content;
          remoteHash = hashFileContent(content);
        } else {
          // First-time entry: unconditional GET.
          const fetched = await client.documents.get(config.vaultId, change.path);
          content = fetched.content;
          remoteHash = hashFileContent(content);
        }

        const localFile = path.join(config.localPath, change.path);
        const localExists = fs.existsSync(localFile);

        if (localExists) {
          const localContent = fs.readFileSync(localFile, 'utf-8');
          const localHash = hashFileContent(localContent);

          if (localHash === remoteHash) {
            // Content is already the same — just update state
            state.local[change.path] = { path: change.path, hash: localHash, mtime: new Date().toISOString(), size: Buffer.byteLength(localContent) };
            state.remote[change.path] = buildRemoteFileState(change.path, content, change.fileModifiedAt);
            stateMutated = true;
            continue;
          }

          // Check for conflict
          const lastLocal = state.local[change.path];
          const localState = { path: change.path, hash: localHash, mtime: fs.statSync(localFile).mtime.toISOString(), size: Buffer.byteLength(localContent) };
          const remoteState = { path: change.path, hash: remoteHash, mtime: change.fileModifiedAt, size: Buffer.byteLength(content) };

          if (detectConflict(localState, remoteState, lastLocal, lastRemote)) {
            const resolution = resolveConflict(config.onConflict, localState, remoteState);
            let conflictFile: string | null = null;

            if (resolution === 'remote') {
              conflictFile = createConflictFile(config.localPath, change.path, localContent, 'local');
              onLocalWrite?.(change.path);
              const tmpConflict = localFile + '.tmp';
              fs.writeFileSync(tmpConflict, content, 'utf-8');
              fs.renameSync(tmpConflict, localFile);
              log(`Conflict: ${change.path} — used remote, saved local as ${conflictFile}`);
            } else {
              conflictFile = createConflictFile(config.localPath, change.path, content, 'remote');
              await client.documents.put(config.vaultId, change.path, localContent);
              log(`Conflict: ${change.path} — used local, saved remote as ${conflictFile}`);
            }

            onConflictLog?.(formatConflictLog(change.path, resolution, conflictFile));

            state.local[change.path] = resolution === 'remote' ? remoteState : localState;
            state.remote[change.path] = resolution === 'remote'
              ? buildRemoteFileState(change.path, content, change.fileModifiedAt)
              : buildRemoteFileState(change.path, localContent, new Date().toISOString());
            stateMutated = true;
            changes++;
            continue;
          }
        }

        // No conflict — download the file atomically
        const dir = path.dirname(localFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        onLocalWrite?.(change.path);
        const tmpFile = localFile + '.tmp';
        fs.writeFileSync(tmpFile, content, 'utf-8');
        fs.renameSync(tmpFile, localFile);
        log(`Pulled: ${change.path}`);
        changes++;

        state.local[change.path] = {
          path: change.path,
          hash: remoteHash,
          mtime: new Date().toISOString(),
          size: Buffer.byteLength(content),
        };
        state.remote[change.path] = buildRemoteFileState(change.path, content, change.fileModifiedAt);
        stateMutated = true;
      }

      // Process remote deletions.
      for (const removedPath of sync.removed) {
        if (shouldIgnore(removedPath, ignorePatterns)) continue;
        const localFile = path.join(config.localPath, removedPath);
        if (fs.existsSync(localFile)) {
          fs.unlinkSync(localFile);
          log(`Deleted local: ${removedPath} (removed from remote)`);
          changes++;
        }
        delete state.local[removedPath];
        delete state.remote[removedPath];
        stateMutated = true;
      }

      if (changes > 0 || stateMutated) {
        saveSyncState(state);
        if (changes > 0) {
          updateLastSync(config.id);
          log(`Poll complete: ${changes} change(s)`);
        }
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
