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
import { isThrottleError } from './engine.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { assertSyncRoot } from './root-marker.js';
import type { SyncOperationSerializer } from './watcher.js';
import { getHttpTimeoutMs } from '../client.js';
import { resolveWithinSyncRoot } from './safe-path.js';

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
  /** Shared watcher/poller operation queue for one sync state file. */
  serialize?: SyncOperationSerializer;
  /** Maximum time to wait for an in-flight poll during shutdown. */
  shutdownTimeoutMs?: number;
}

/**
 * Creates and starts a remote poller for a sync configuration.
 * Returns a stop function.
 */
export function createRemotePoller(
  client: LifestreamVaultClient,
  config: SyncConfig,
  options: PollerOptions,
): { stop: () => Promise<void> } {
  const {
    ignorePatterns,
    intervalMs = 30000,
    onLog,
    onConflictLog,
    onError,
    onLocalWrite,
    serialize,
    shutdownTimeoutMs = getHttpTimeoutMs() + 5_000,
  } = options;

  const log = (msg: string) => onLog?.(`[poll:${config.id.slice(0, 8)}] ${msg}`);
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let stopping = false;
  let activePoll: Promise<void> | null = null;

  async function pollOnce(): Promise<void> {
    try {
      assertSyncRoot(config);
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

      assertSyncRoot(config);
      const sync = await client.documents.syncList(config.vaultId, known);

      // Steady-state: server confirmed nothing changed — skip all per-doc work.
      if (sync.vaultUnchanged) return;

      // Persist the new list ETag so the next poll can 304.
      state.remoteListEtag = sync.listEtag;
      stateMutated = true;

      // Process added/changed documents.
      for (const change of sync.changes) {
        if (shouldIgnore(change.path, ignorePatterns)) continue;
        const localFile = resolveWithinSyncRoot(config.localPath, change.path);

        const lastRemote = state.remote[change.path];

        let content: string;
        let remoteHash: string;

        if (lastRemote) {
          // Conditional GET — server can still 304 us if our hash is current
          // (rare: syncList classified this as 'changed' but the GET hash matches
          // our last-known hash — possible race between list and get).
          assertSyncRoot(config);
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
          assertSyncRoot(config);
          const fetched = await client.documents.get(config.vaultId, change.path);
          content = fetched.content;
          remoteHash = hashFileContent(content);
        }

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
              assertSyncRoot(config);
              conflictFile = createConflictFile(config.localPath, change.path, localContent, 'local');
              assertSyncRoot(config);
              const mutationTarget = resolveWithinSyncRoot(config.localPath, change.path);
              onLocalWrite?.(change.path);
              atomicWriteFileSync(mutationTarget, content, 'utf-8');
              log(`Conflict: ${change.path} — used remote, saved local as ${conflictFile}`);
            } else {
              assertSyncRoot(config);
              conflictFile = createConflictFile(config.localPath, change.path, content, 'remote');
              assertSyncRoot(config);
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
        assertSyncRoot(config);
        const mutationTarget = resolveWithinSyncRoot(config.localPath, change.path);
        const dir = path.dirname(mutationTarget);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        onLocalWrite?.(change.path);
        atomicWriteFileSync(mutationTarget, content, 'utf-8');
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
        assertSyncRoot(config);
        const localFile = resolveWithinSyncRoot(config.localPath, removedPath);
        if (fs.existsSync(localFile)) {
          const localContent = fs.readFileSync(localFile, 'utf-8');
          const localHash = hashFileContent(localContent);
          const lastLocal = state.local[removedPath];
          const localChanged = !lastLocal || localHash !== lastLocal.hash;

          if (localChanged) {
            // A remote tombstone and a local edit are a real conflict. Treat
            // deletion as the remote side's latest state and preserve the
            // losing content before applying the configured policy.
            const localMtime = fs.statSync(localFile).mtime.toISOString();
            const localState = {
              path: removedPath,
              hash: localHash,
              mtime: localMtime,
              size: Buffer.byteLength(localContent),
            };
            const remoteDeletionState = {
              path: removedPath,
              hash: '',
              mtime: new Date().toISOString(),
              size: 0,
            };
            const resolution = resolveConflict(config.onConflict, localState, remoteDeletionState);
            let conflictFile: string | null = null;

            if (resolution === 'local') {
              assertSyncRoot(config);
              await client.documents.put(config.vaultId, removedPath, localContent);
              state.local[removedPath] = localState;
              state.remote[removedPath] = buildRemoteFileState(
                removedPath,
                localContent,
                new Date().toISOString(),
              );
              // The PUT invalidates the list ETag returned by this poll.
              state.remoteListEtag = undefined;
              log(`Conflict: ${removedPath} — restored local edit to remote`);
            } else {
              assertSyncRoot(config);
              conflictFile = createConflictFile(config.localPath, removedPath, localContent, 'local');
              assertSyncRoot(config);
              const mutationTarget = resolveWithinSyncRoot(config.localPath, removedPath);
              onLocalWrite?.(removedPath);
              fs.unlinkSync(mutationTarget);
              delete state.local[removedPath];
              delete state.remote[removedPath];
              log(`Conflict: ${removedPath} — accepted remote deletion, saved local as ${conflictFile}`);
            }
            onConflictLog?.(formatConflictLog(removedPath, resolution, conflictFile));
            stateMutated = true;
            changes++;
            continue;
          }

          onLocalWrite?.(removedPath);
          fs.unlinkSync(resolveWithinSyncRoot(config.localPath, removedPath));
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
      if (isThrottleError(err)) {
        // The SDK already retried the request with Retry-After backoff and
        // exhausted its retry budget. Log a warning rather than invoking
        // onError so the daemon loop does NOT immediately re-poll on top of
        // the backoff that the SDK already applied.  The next scheduled poll
        // (after intervalMs) will pick up the changes.
        log('Rate limited by server — will retry on next scheduled poll');
      } else {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async function poll(): Promise<void> {
    if (polling || stopping) return; // Skip if previous poll is running or shutdown began
    polling = true;
    try {
      if (serialize) {
        await serialize(pollOnce);
      } else {
        await pollOnce();
      }
    } finally {
      polling = false;
    }
  }

  function startPoll(): void {
    const running = poll();
    activePoll = running;
    running
      .catch(err => onError?.(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        if (activePoll === running) activePoll = null;
      });
  }

  // Initial poll
  startPoll();

  // Start interval
  timer = setInterval(() => {
    startPoll();
  }, intervalMs);

  log(`Polling every ${intervalMs / 1000}s`);

  return {
    stop: async () => {
      stopping = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const running = activePoll;
      if (running) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const completed = await Promise.race([
          running.then(() => true),
          new Promise<false>(resolve => {
            timeout = setTimeout(() => resolve(false), shutdownTimeoutMs);
            timeout.unref?.();
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!completed) {
          throw new Error(`Poller shutdown drain timed out after ${shutdownTimeoutMs}ms`);
        }
      }
      log('Stopped polling');
    },
  };
}
