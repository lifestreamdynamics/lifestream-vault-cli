/**
 * Local file watcher for continuous sync.
 * Uses chokidar to detect file changes and triggers sync operations.
 */
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { NotFoundError, type LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import type { SyncConfig, FileState, SyncState } from './types.js';
import { shouldIgnore } from './ignore.js';
import { hashFileContent, loadSyncState, saveSyncState, buildRemoteFileState } from './state.js';
import { updateLastSync } from './config.js';
import { resolveConflict, detectConflict, createConflictFile, formatConflictLog } from './conflict.js';
import fs from 'node:fs';
import { assertSyncRoot } from './root-marker.js';
import { resolveWithinSyncRoot } from './safe-path.js';
import { atomicWriteFileSync } from './atomic-write.js';
import { awaitWithTimeout, defaultShutdownTimeoutMs } from './shutdown.js';

export interface WatcherOptions {
  /** Patterns to ignore */
  ignorePatterns: string[];
  /** Callback for log messages */
  onLog?: (message: string) => void;
  /** Callback for conflict log messages */
  onConflictLog?: (message: string) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;
  /** Debounce delay in ms (default: 500) */
  debounceMs?: number;
  /** Maximum time to wait for queued file operations during shutdown. */
  shutdownTimeoutMs?: number;
}

/** Serializes watcher and poller operations that share one sync-state file. */
export type SyncOperationSerializer = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Only a structured SDK 404 proves the remote document is absent. A bare
 * object carrying `statusCode: 404` (or any other failure) leaves the remote
 * state unknown and must abort the mutation.
 */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof NotFoundError;
}

/**
 * Remembers what sync itself just wrote, so chokidar's event for that write is
 * not mistaken for a user edit.
 *
 * A hit requires BOTH that the mark is inside the TTL *and* that the file still
 * holds the bytes sync wrote. Suppressing on the clock alone silently discarded
 * a real edit: the poller writes at T=0, the user saves at T=1.5s, the event is
 * dropped, `state.local` keeps the pulled hash, and the next remote change
 * overwrites the user's work with no conflict copy — the file is simply gone.
 *
 * A deletion is marked with a `null` hash, which matches only the delete-side
 * probe; a file recreated at the same path is a genuine event.
 */
class RecentlyWrittenSet {
  private map = new Map<string, { at: number; hash: string | null }>();
  private ttlMs: number;

  constructor(ttlMs = 5000) {
    this.ttlMs = ttlMs;
  }

  add(filePath: string, hash: string | null): void {
    this.map.set(filePath, { at: Date.now(), hash });
  }

  has(filePath: string, hash: string | null): boolean {
    const mark = this.map.get(filePath);
    if (!mark) return false;
    if (Date.now() - mark.at > this.ttlMs) {
      this.map.delete(filePath);
      return false;
    }
    return mark.hash === hash;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Creates and starts a file watcher for a sync configuration.
 * Returns a cleanup function to stop watching.
 */
export function createWatcher(
  client: LifestreamVaultClient,
  config: SyncConfig,
  options: WatcherOptions,
): {
  watcher: FSWatcher;
  ready: Promise<void>;
  /**
   * Mark a poller-originated local mutation so chokidar will not re-upload it.
   * `contentHash` is the SHA-256 of the bytes written, or null for a deletion;
   * an event whose content no longer matches is a user edit and is processed.
   */
  markLocalWrite: (docPath: string, contentHash: string | null) => void;
  /** Run a state/file operation after earlier watcher or poller operations finish. */
  serialize: SyncOperationSerializer;
  stop: () => Promise<void>;
} {
  assertSyncRoot(config);
  const {
    ignorePatterns,
    onLog,
    onConflictLog,
    onError,
    debounceMs = 500,
    shutdownTimeoutMs = defaultShutdownTimeoutMs(),
  } = options;
  const recentlyWritten = new RecentlyWrittenSet();
  const pendingChanges = new Map<string, NodeJS.Timeout>();
  let operationTail: Promise<void> = Promise.resolve();
  let stopping = false;

  const serialize: SyncOperationSerializer = <T>(operation: () => Promise<T>) => {
    const run = operationTail.then(operation, operation);
    // Keep the queue live after an operation failure while returning the
    // original rejection to its caller for normal error reporting.
    operationTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const markLocalWrite = (docPath: string, contentHash: string | null): void =>
    recentlyWritten.add(docPath, contentHash);

  const log = (msg: string) => onLog?.(`[sync:${config.id.slice(0, 8)}] ${msg}`);

  function toDocPath(absPath: string): string {
    const rel = path.relative(config.localPath, absPath);
    return rel.split(path.sep).join('/');
  }

  /** Write remote content over the local file through the containment check. */
  function writeLocal(docPath: string, content: string): void {
    assertSyncRoot(config);
    const target = resolveWithinSyncRoot(config.localPath, docPath);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    recentlyWritten.add(docPath, hashFileContent(content));
    atomicWriteFileSync(target, content, 'utf-8');
  }

  /**
   * Handles a detected conflict between local and remote versions of a file.
   * Creates a backup of the losing side and applies the winning resolution.
   * Returns the resolution chosen, or 'skip' if no actual conflict was detected.
   */
  async function handleConflict(params: {
    docPath: string;
    localContent: string;
    localHash: string;
    lastLocal: FileState | undefined;
    lastRemote: FileState | undefined;
    remoteContent: string;
    remoteHash: string;
    remoteUpdatedAt: string;
    state: SyncState;
  }): Promise<'local' | 'remote' | 'skip'> {
    const { docPath, localContent, localHash, lastLocal, lastRemote, remoteContent, remoteHash, remoteUpdatedAt, state } = params;

    const localState = { path: docPath, hash: localHash, mtime: new Date().toISOString(), size: Buffer.byteLength(localContent) };
    const remoteState = { path: docPath, hash: remoteHash, mtime: remoteUpdatedAt, size: Buffer.byteLength(remoteContent) };

    if (!detectConflict(localState, remoteState, lastLocal, lastRemote)) {
      return 'skip';
    }

    const resolution = resolveConflict(config.onConflict, localState, remoteState);
    let conflictFile: string | null = null;

    if (resolution === 'local') {
      assertSyncRoot(config);
      conflictFile = createConflictFile(config.localPath, docPath, remoteContent, 'remote');
      assertSyncRoot(config);
      // Conditional on the remote bytes this handler just read, so a third
      // client writing in between is refused rather than silently overwritten.
      await client.documents.put(config.vaultId, docPath, localContent,
        remoteHash ? { ifMatch: remoteHash } : undefined);
      log(`Conflict: ${docPath} — used local, saved remote as ${conflictFile}`);
    } else {
      assertSyncRoot(config);
      conflictFile = createConflictFile(config.localPath, docPath, localContent, 'local');
      writeLocal(docPath, remoteContent);
      log(`Conflict: ${docPath} — used remote, saved local as ${conflictFile}`);
    }

    onConflictLog?.(formatConflictLog(docPath, resolution, conflictFile));

    state.local[docPath] = resolution === 'local' ? localState : remoteState;
    state.remote[docPath] = resolution === 'local'
      ? buildRemoteFileState(docPath, localContent, new Date().toISOString())
      : buildRemoteFileState(docPath, remoteContent, remoteUpdatedAt);
    saveSyncState(state);

    return resolution;
  }

  async function handleFileChange(absPath: string): Promise<void> {
    const docPath = toDocPath(absPath);

    if (shouldIgnore(docPath, ignorePatterns)) return;
    if (!docPath.endsWith('.md')) return;

    try {
      assertSyncRoot(config);
      const localFile = resolveWithinSyncRoot(config.localPath, docPath);
      let content: string;
      try {
        content = fs.readFileSync(localFile, 'utf-8');
      } catch (readErr) {
        // The file disappeared between the event and this handler. The unlink
        // event covers that case; there is nothing to push here.
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw readErr;
      }
      const localHash = hashFileContent(content);
      // The suppression check needs the *content*, so it can only run once the
      // file has been read: a same-path event whose bytes differ from what sync
      // wrote is a user edit that must not be discarded.
      if (recentlyWritten.has(docPath, localHash)) {
        log(`Skipping ${docPath} (recently written by sync)`);
        return;
      }
      const state = loadSyncState(config.id);
      const lastLocal = state.local[docPath];
      const lastRemote = state.remote[docPath];

      // The remote hash this push may assert as an If-Match precondition. Only
      // ever set from an observation made moments ago in this same handler; in
      // push mode there is no preflight, so the write stays unconditional.
      let expectedRemoteHash: string | undefined;

      // Check remote for conflicts in bidirectional mode.
      // This used to be gated on `lastRemote` being present, which skipped the check in
      // exactly the case where the remote is least known: no recorded shared state at
      // all. The PUT then went out blind and could overwrite a document created on the
      // server since the last sync. With no baseline we send an unconditional GET and
      // treat any existing remote content as needing reconciliation - detectConflict
      // already returns true for a differing hash with no last-known state.
      if (config.mode === 'sync') {
        try {
          const result = await client.documents.get(config.vaultId, docPath, {
            ...(lastRemote ? { ifNoneMatch: `"${lastRemote.hash}"` } : {}),
          });
          if (!result.notModified) {
            // Server returned the body — check if hash differs from our last-known state.
            const remoteHash = hashFileContent(result.content);
            if (!lastRemote || remoteHash !== lastRemote.hash) {
              const conflictResult = await handleConflict({
                docPath, localContent: content, localHash,
                lastLocal, lastRemote,
                remoteContent: result.content, remoteHash,
                remoteUpdatedAt: result.document.updatedAt, state,
              });
              if (conflictResult !== 'skip') return;

              // The remote moved since the last shared state and no conflict
              // was detected, which means the local bytes did not actually
              // diverge from the last sync (or both sides already match).
              // Pushing here would overwrite the newer remote edit with a
              // stale local copy, so adopt the remote version instead.
              if (remoteHash === localHash) {
                log(`Remote already matches ${docPath}; recorded shared state`);
              } else {
                writeLocal(docPath, result.content);
                log(`Adopted remote: ${docPath} (remote changed, local unchanged since last sync)`);
              }
              state.local[docPath] = {
                path: docPath, hash: remoteHash, mtime: new Date().toISOString(), size: Buffer.byteLength(result.content),
              };
              state.remote[docPath] = buildRemoteFileState(docPath, result.content, result.document.updatedAt);
              saveSyncState(state);
              updateLastSync(config.id);
              return;
            }
            // 200 + matching hash: rare list/cache mismatch — fall through to push.
            expectedRemoteHash = remoteHash;
          } else {
            // 304: remote unchanged since last sync — it is still at the hash we
            // conditioned the GET on. No conflict possible; fall through to push.
            expectedRemoteHash = lastRemote?.hash;
          }
        } catch (err) {
          // A confirmed 404 means the remote side has no competing content,
          // so creating it is safe. Authentication, timeout, and server
          // failures leave the remote state unknown and must abort the PUT.
          if (!isNotFoundError(err)) throw err;
        }
      }

      // No conflict — push the change
      if (config.mode === 'push' || config.mode === 'sync') {
        assertSyncRoot(config);
        await client.documents.put(config.vaultId, docPath, content,
          expectedRemoteHash ? { ifMatch: expectedRemoteHash } : undefined);
        log(`Pushed: ${docPath}`);

        state.local[docPath] = { path: docPath, hash: localHash, mtime: new Date().toISOString(), size: Buffer.byteLength(content) };
        state.remote[docPath] = buildRemoteFileState(docPath, content, new Date().toISOString());
        saveSyncState(state);
        updateLastSync(config.id);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function handleFileDelete(absPath: string): Promise<void> {
    const docPath = toDocPath(absPath);
    if (shouldIgnore(docPath, ignorePatterns)) return;
    if (!docPath.endsWith('.md')) return;
    // A deletion the poller performed is marked with a null hash; a user's own
    // deletion of the same path has no mark and is processed normally.
    if (recentlyWritten.has(docPath, null)) return;

    try {
      if (config.mode === 'push' || config.mode === 'sync') {
        assertSyncRoot(config);
        resolveWithinSyncRoot(config.localPath, docPath);

        const state = loadSyncState(config.id);
        const lastRemote = state.remote[docPath];
        let remoteAlreadyMissing = false;
        // Remote hash to assert as an If-Match on the DELETE, set only from an
        // observation this handler just made.
        let expectedRemoteHash: string | undefined;
        // As on the write path, the preflight must run even with no recorded shared
        // state — otherwise a local delete of a file we never synced issues an
        // unconditional remote DELETE against content we have never seen.
        if (config.mode === 'sync') {
          try {
            const result = await client.documents.get(config.vaultId, docPath, {
              ...(lastRemote ? { ifNoneMatch: `"${lastRemote.hash}"` } : {}),
            });
            if (!result.notModified) {
              // The remote changed after the last shared state while the local
              // file was deleted. Preserve the losing side, then apply the
              // configured conflict policy. The DELETE below is additionally
              // conditioned on the hash read here, so a write landing between
              // this preflight and the delete is refused rather than lost.
              const remoteContent = result.content;
              const remoteHash = hashFileContent(remoteContent);
              expectedRemoteHash = remoteHash;
              if (!lastRemote || remoteHash !== lastRemote.hash) {
                const localDeletionState = {
                  path: docPath,
                  hash: '',
                  mtime: new Date().toISOString(),
                  size: 0,
                };
                const remoteState = {
                  path: docPath,
                  hash: remoteHash,
                  mtime: result.document.updatedAt,
                  size: Buffer.byteLength(remoteContent),
                };
                const resolution = resolveConflict(config.onConflict, localDeletionState, remoteState);
                let conflictFile: string | null = null;

                if (resolution === 'remote') {
                  writeLocal(docPath, remoteContent);
                  state.local[docPath] = remoteState;
                  state.remote[docPath] = remoteState;
                  saveSyncState(state);
                  updateLastSync(config.id);
                  log(`Conflict: ${docPath} — restored concurrent remote edit locally`);
                  onConflictLog?.(formatConflictLog(docPath, resolution, null));
                  return;
                }

                assertSyncRoot(config);
                conflictFile = createConflictFile(config.localPath, docPath, remoteContent, 'remote');
                onConflictLog?.(formatConflictLog(docPath, resolution, conflictFile));
                log(`Conflict: ${docPath} — kept local deletion, saved remote as ${conflictFile}`);
              }
            } else {
              // 304: the remote is still at the hash we conditioned the GET on.
              expectedRemoteHash = lastRemote?.hash;
            }
          } catch (err) {
            // If another client already deleted the document, local and remote
            // agree. Any other failure leaves remote state unknown and aborts.
            if (!isNotFoundError(err)) throw err;
            remoteAlreadyMissing = true;
          }
        }

        if (!remoteAlreadyMissing) {
          assertSyncRoot(config);
          await client.documents.delete(config.vaultId, docPath,
            expectedRemoteHash ? { ifMatch: expectedRemoteHash } : undefined);
          log(`Deleted remote: ${docPath}`);
        }

        delete state.local[docPath];
        delete state.remote[docPath];
        saveSyncState(state);
        updateLastSync(config.id);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const watcher = watch(config.localPath, {
    ignoreInitial: true,
    persistent: true,
    // A symlinked directory inside the root would otherwise be walked and its
    // targets reported as documents "inside" the root. Containment is also
    // enforced per path by resolveWithinSyncRoot; this keeps chokidar from
    // even generating events for linked trees.
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: debounceMs },
    ignored: (filePath: string) => {
      const rel = path.relative(config.localPath, filePath);
      if (!rel || rel === '.') return false;
      const docPath = rel.split(path.sep).join('/');
      return shouldIgnore(docPath, ignorePatterns);
    },
  });

  // Chokidar constructs asynchronously. Returning before its `ready` event
  // used to let callers announce a healthy daemon/watch process even when the
  // underlying OS watcher had not started (or failed during its initial scan).
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Some consumers only need the watcher handle. Keep a rejected readiness
  // promise from becoming an unhandled rejection while preserving rejection
  // for daemon and foreground-watch callers that await it.
  void ready.catch(() => undefined);

  watcher.once('ready', () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  });

  const schedule = (absPath: string, handler: (absPath: string) => Promise<void>): void => {
    if (stopping) return;
    clearTimeout(pendingChanges.get(absPath));
    pendingChanges.set(absPath, setTimeout(() => {
      pendingChanges.delete(absPath);
      if (stopping) return;
      serialize(() => handler(absPath)).catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
    }, debounceMs));
  };

  watcher.on('add', (absPath: string) => schedule(absPath, handleFileChange));
  watcher.on('change', (absPath: string) => schedule(absPath, handleFileChange));
  watcher.on('unlink', (absPath: string) => schedule(absPath, handleFileDelete));

  watcher.on('error', (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    onError?.(error);
  });

  log('Watching for changes...');

  return {
    watcher,
    ready,
    markLocalWrite,
    serialize,
    stop: async () => {
      stopping = true;
      for (const timeout of pendingChanges.values()) {
        clearTimeout(timeout);
      }
      pendingChanges.clear();
      recentlyWritten.clear();
      const drain = Promise.all([watcher.close(), operationTail]).then(() => undefined);
      await awaitWithTimeout(drain, shutdownTimeoutMs, 'Watcher shutdown drain');
      log('Stopped watching');
    },
  };
}
