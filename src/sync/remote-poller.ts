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
import { resolveWithinSyncRoot, SyncPathError } from './safe-path.js';
import { assertNoPathCollisions } from './path-collision.js';
import { assessDeletions, MASS_DELETE_OVERRIDE_HINT } from './mass-delete-guard.js';
import { awaitWithTimeout, defaultShutdownTimeoutMs } from './shutdown.js';

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Below this the poller would hammer the list endpoint faster than one HTTP round trip. */
export const MIN_POLL_INTERVAL_MS = 1_000;
/** One day: anything longer is almost certainly a unit mistake (e.g. seconds passed as ms). */
export const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Clamp a caller-supplied poll interval into a sane range; non-finite values fall back to the default. */
export function clampPollIntervalMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.floor(value)));
}

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
  /**
   * Callback when the poller mutates a local file, so the watcher can tell its
   * own echo from a user edit. `contentHash` is the SHA-256 of the bytes just
   * written, or null for a deletion — the watcher requires a content match, not
   * just a recent timestamp, before discarding an event.
   */
  onLocalWrite?: (docPath: string, contentHash: string | null) => void;
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
    onLog,
    onConflictLog,
    onError,
    onLocalWrite,
    serialize,
    shutdownTimeoutMs = defaultShutdownTimeoutMs(),
  } = options;
  const intervalMs = clampPollIntervalMs(options.intervalMs);
  // Pull-only configurations are one-way: the poller must never write to the
  // remote, even to "win" a conflict for a locally edited file.
  const canPush = config.mode !== 'pull';

  const log = (msg: string) => onLog?.(`[poll:${config.id.slice(0, 8)}] ${msg}`);
  if (options.intervalMs !== undefined && options.intervalMs !== intervalMs) {
    log(`Poll interval ${String(options.intervalMs)}ms is out of range; using ${intervalMs}ms`);
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  /** The poll currently running, or null. Only ever set by poll() itself. */
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

      // Two vault paths that name one local file make every pass overwrite the
      // other and mint another `.conflicted.*` copy. Refuse the whole poll and
      // say which pair, rather than burning disk on the loop.
      assertNoPathCollisions([...sync.changes.map(c => c.path), ...sync.unchanged]);

      // Paths that failed this pass. Held back rather than thrown, so one
      // permanently-unsyncable document cannot discard every other document's
      // progress and wedge the vault forever.
      const failedPaths: string[] = [];
      // Set when this poll writes to the remote, which invalidates the list ETag the
      // server returned for the pre-write state.
      let listEtagInvalidated = false;

      // Process added/changed documents.
      for (const change of sync.changes) {
        if (shouldIgnore(change.path, ignorePatterns)) continue;
        try {
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
                onLocalWrite?.(change.path, remoteHash);
                atomicWriteFileSync(mutationTarget, content, 'utf-8');
                log(`Conflict: ${change.path} — used remote, saved local as ${conflictFile}`);
              } else {
                assertSyncRoot(config);
                conflictFile = createConflictFile(config.localPath, change.path, content, 'remote');
                if (canPush) {
                  assertSyncRoot(config);
                  // Conditional on the bytes this poll just read: a third client
                  // writing between that GET and this PUT is refused rather than
                  // silently overwritten. An empty hash is never a usable
                  // precondition (`If-Match: ""` matches nothing).
                  await client.documents.put(config.vaultId, change.path, localContent,
                    remoteHash ? { ifMatch: remoteHash } : undefined);
                  // This poll just wrote to the remote, so the list ETag it was handed
                  // describes the pre-write state — same reasoning as the delete-conflict
                  // branch below.
                  state.remoteListEtag = undefined;
                  listEtagInvalidated = true;
                  log(`Conflict: ${change.path} — used local, saved remote as ${conflictFile}`);
                } else {
                  log(`Conflict: ${change.path} — kept local edit (pull-only, remote not updated), saved remote as ${conflictFile}`);
                }
              }

              onConflictLog?.(formatConflictLog(change.path, resolution, conflictFile));

              state.local[change.path] = resolution === 'remote' ? remoteState : localState;
              // In pull-only mode the remote was not rewritten, so record the
              // server's actual content as the last-known remote state; the next
              // poll then sees it as unchanged instead of re-raising the conflict.
              state.remote[change.path] = resolution === 'remote' || !canPush
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
          onLocalWrite?.(change.path, remoteHash);
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
        } catch (err) {
          // A throttle applies to the whole poll, not one document — let it out so the
          // outer handler can back off instead of marking every path as failed.
          if (isThrottleError(err)) throw err;
          // A containment failure is never "just this document" — let it abort the
          // poll and reach onError rather than being recorded as a skipped path.
          if (err instanceof SyncPathError) throw err;
          failedPaths.push(change.path);
          log(`Failed to pull ${change.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Process remote deletions.
      //
      // `sync.removed` is derived by subtracting the current listing from our
      // known hashes, so a listing that came back short — a scope change on the
      // API key, a lagging replica, a server-side path migration — is
      // indistinguishable from a real bulk delete. The guard refuses the whole
      // batch in that case; the creates and updates above have already applied.
      const deletionAssessment = assessDeletions(sync.removed.length, Object.keys(known.hashes).length);
      let deletionsRefused = false;
      if (!deletionAssessment.allow) {
        deletionsRefused = true;
        const reason = deletionAssessment.reason ?? 'Deletion batch refused by the mass-delete guard.';
        log(`Refusing ${sync.removed.length} remote deletion(s): ${reason} ${MASS_DELETE_OVERRIDE_HINT}`);
        state.deletionAnomaly = {
          detectedAt: new Date().toISOString(),
          removedCount: sync.removed.length,
          knownCount: Object.keys(known.hashes).length,
          reason,
        };
        stateMutated = true;
      } else if (state.deletionAnomaly) {
        // The listing looks sane again — stop reporting a resolved anomaly.
        delete state.deletionAnomaly;
        stateMutated = true;
      }
      for (const removedPath of deletionsRefused ? [] : sync.removed) {
        if (shouldIgnore(removedPath, ignorePatterns)) continue;
        try {
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

              if (resolution === 'local' && !canPush) {
                // Pull-only: keep the local edit on disk but do not resurrect
                // the remote document. It is no longer tracked on either side.
                delete state.local[removedPath];
                delete state.remote[removedPath];
                log(`Conflict: ${removedPath} — remote deleted; kept local edit (pull-only, not re-uploaded)`);
              } else if (resolution === 'local') {
                assertSyncRoot(config);
                // Deliberately unconditional: the document is gone from the
                // server, so there is no ETag to match against. The SDK has no
                // "create only if absent" precondition, and sending the stale
                // pre-deletion hash would fail every time.
                await client.documents.put(config.vaultId, removedPath, localContent);
                state.local[removedPath] = localState;
                state.remote[removedPath] = buildRemoteFileState(
                  removedPath,
                  localContent,
                  new Date().toISOString(),
                );
                // The PUT invalidates the list ETag returned by this poll.
                state.remoteListEtag = undefined;
                listEtagInvalidated = true;
                log(`Conflict: ${removedPath} — restored local edit to remote`);
              } else {
                assertSyncRoot(config);
                conflictFile = createConflictFile(config.localPath, removedPath, localContent, 'local');
                assertSyncRoot(config);
                const mutationTarget = resolveWithinSyncRoot(config.localPath, removedPath);
                onLocalWrite?.(removedPath, null);
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

            onLocalWrite?.(removedPath, null);
            fs.unlinkSync(resolveWithinSyncRoot(config.localPath, removedPath));
            log(`Deleted local: ${removedPath} (removed from remote)`);
            changes++;
          }
          delete state.local[removedPath];
          delete state.remote[removedPath];
          stateMutated = true;
        } catch (err) {
          if (isThrottleError(err)) throw err;
          if (err instanceof SyncPathError) throw err;
          failedPaths.push(removedPath);
          log(`Failed to apply remote deletion of ${removedPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Only advance the list ETag once every path in this batch has been applied.
      // Committing it while a document still failed would make the next poll 304 and
      // silently drop that document from the change feed for good.
      if (failedPaths.length === 0 && !listEtagInvalidated && !deletionsRefused) {
        state.remoteListEtag = sync.listEtag;
        stateMutated = true;
      } else if (failedPaths.length > 0) {
        log(
          `Holding list ETag: ${failedPaths.length} path(s) failed this poll and will be retried (${failedPaths.slice(0, 5).join(', ')})`,
        );
      } else if (deletionsRefused) {
        // Committing the ETag would make the next poll 304 and drop the refused
        // deletions from the feed for good, hiding the anomaly instead of
        // re-raising it once the listing recovers.
        log('Holding list ETag: a deletion batch was refused and will be re-evaluated on the next poll');
      }

      // Save even on a partial failure so the documents that did succeed are not
      // re-downloaded on every subsequent poll.
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

  /**
   * Start a poll unless one is already in flight or shutdown began. The
   * in-flight promise is tracked here and only here, so a skipped tick can
   * never replace the promise stop() must wait on.
   */
  function startPoll(): void {
    if (activePoll || stopping) return;
    const running = (serialize ? serialize(pollOnce) : pollOnce())
      .catch(err => onError?.(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        if (activePoll === running) activePoll = null;
      });
    activePoll = running;
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
        await awaitWithTimeout(running, shutdownTimeoutMs, 'Poller shutdown drain');
      }
      log('Stopped polling');
    },
  };
}
