/**
 * Local file watcher for continuous sync.
 * Uses chokidar to detect file changes and triggers sync operations.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'chokidar';
import type { LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import type { SyncConfig } from './types.js';
import { shouldIgnore } from './ignore.js';
import { hashFileContent, loadSyncState, saveSyncState, buildRemoteFileState } from './state.js';
import { updateLastSync } from './config.js';
import { resolveConflict, detectConflict, createConflictFile, formatConflictLog } from './conflict.js';
import fs from 'node:fs';
import { assertSyncRoot } from './root-marker.js';
import { getHttpTimeoutMs } from '../client.js';

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

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && (error as { statusCode?: unknown }).statusCode === 404;
}

/** TTL set to prevent sync loops — files written by sync are ignored for 5s */
class RecentlyWrittenSet {
  private map = new Map<string, number>();
  private ttlMs: number;

  constructor(ttlMs = 5000) {
    this.ttlMs = ttlMs;
  }

  add(filePath: string): void {
    this.map.set(filePath, Date.now());
  }

  has(filePath: string): boolean {
    const ts = this.map.get(filePath);
    if (!ts) return false;
    if (Date.now() - ts > this.ttlMs) {
      this.map.delete(filePath);
      return false;
    }
    return true;
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
  /** Mark a poller-originated local mutation so chokidar will not re-upload it. */
  markLocalWrite: (docPath: string) => void;
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
    shutdownTimeoutMs = getHttpTimeoutMs() + 5_000,
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
  const markLocalWrite = (docPath: string): void => recentlyWritten.add(docPath);

  const log = (msg: string) => onLog?.(`[sync:${config.id.slice(0, 8)}] ${msg}`);

  function toDocPath(absPath: string): string {
    const rel = path.relative(config.localPath, absPath);
    return rel.split(path.sep).join('/');
  }

  /**
   * Handles a detected conflict between local and remote versions of a file.
   * Creates a backup of the losing side and applies the winning resolution.
   * Returns the resolution chosen, or 'skip' if no actual conflict was detected.
   */
  async function handleConflict(params: {
    absPath: string;
    docPath: string;
    localContent: string;
    localHash: string;
    lastLocal: import('./types.js').FileState | undefined;
    lastRemote: import('./types.js').FileState | undefined;
    remoteContent: string;
    remoteHash: string;
    remoteUpdatedAt: string;
    state: import('./types.js').SyncState;
  }): Promise<'local' | 'remote' | 'skip'> {
    const { absPath, docPath, localContent, localHash, lastLocal, lastRemote, remoteContent, remoteHash, remoteUpdatedAt, state } = params;

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
      await client.documents.put(config.vaultId, docPath, localContent);
      log(`Conflict: ${docPath} — used local, saved remote as ${conflictFile}`);
    } else {
      assertSyncRoot(config);
      conflictFile = createConflictFile(config.localPath, docPath, localContent, 'local');
      assertSyncRoot(config);
      recentlyWritten.add(docPath);
      const tmpFile = absPath + '.tmp.' + randomBytes(4).toString('hex');
      fs.writeFileSync(tmpFile, remoteContent, 'utf-8');
      fs.renameSync(tmpFile, absPath);
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
    if (recentlyWritten.has(docPath)) {
      log(`Skipping ${docPath} (recently written by sync)`);
      return;
    }

    try {
      assertSyncRoot(config);
      const content = fs.readFileSync(absPath, 'utf-8');
      const localHash = hashFileContent(content);
      const state = loadSyncState(config.id);
      const lastLocal = state.local[docPath];
      const lastRemote = state.remote[docPath];

      // Check remote for conflicts in bidirectional mode
      if (config.mode === 'sync' && lastRemote) {
        try {
          const result = await client.documents.get(config.vaultId, docPath, {
            ifNoneMatch: `"${lastRemote.hash}"`,
          });
          if (!result.notModified) {
            // Server returned the body — check if hash differs from our last-known state.
            const remoteHash = hashFileContent(result.content);
            if (remoteHash !== lastRemote.hash) {
              const conflictResult = await handleConflict({
                absPath, docPath, localContent: content, localHash,
                lastLocal, lastRemote,
                remoteContent: result.content, remoteHash,
                remoteUpdatedAt: result.document.updatedAt, state,
              });
              if (conflictResult !== 'skip') return;
            }
            // 200 + matching hash: rare list/cache mismatch — fall through to push.
          }
          // 304: remote unchanged since last sync — no conflict possible. Fall through to push.
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
        await client.documents.put(config.vaultId, docPath, content);
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
    if (recentlyWritten.has(docPath)) return;

    try {
      if (config.mode === 'push' || config.mode === 'sync') {
        assertSyncRoot(config);

        const state = loadSyncState(config.id);
        const lastRemote = state.remote[docPath];
        let remoteAlreadyMissing = false;
        if (config.mode === 'sync' && lastRemote) {
          try {
            const result = await client.documents.get(config.vaultId, docPath, {
              ifNoneMatch: `"${lastRemote.hash}"`,
            });
            if (!result.notModified) {
              // The remote changed after the last shared state while the local
              // file was deleted. Preserve the losing side, then apply the
              // configured conflict policy. There is no conditional DELETE in
              // the SDK, so this preflight is the strongest available guard.
              const remoteContent = result.content;
              const remoteHash = hashFileContent(remoteContent);
              if (remoteHash !== lastRemote.hash) {
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
                  assertSyncRoot(config);
                  recentlyWritten.add(docPath);
                  const dir = path.dirname(absPath);
                  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                  const tmpFile = absPath + '.tmp.' + randomBytes(4).toString('hex');
                  fs.writeFileSync(tmpFile, remoteContent, 'utf-8');
                  fs.renameSync(tmpFile, absPath);
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
          await client.documents.delete(config.vaultId, docPath);
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

  watcher.on('add', (absPath: string) => {
    if (stopping) return;
    clearTimeout(pendingChanges.get(absPath));
    pendingChanges.set(absPath, setTimeout(() => {
      pendingChanges.delete(absPath);
      if (stopping) return;
      serialize(() => handleFileChange(absPath)).catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
    }, debounceMs));
  });

  watcher.on('change', (absPath: string) => {
    if (stopping) return;
    clearTimeout(pendingChanges.get(absPath));
    pendingChanges.set(absPath, setTimeout(() => {
      pendingChanges.delete(absPath);
      if (stopping) return;
      serialize(() => handleFileChange(absPath)).catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
    }, debounceMs));
  });

  watcher.on('unlink', (absPath: string) => {
    if (stopping) return;
    clearTimeout(pendingChanges.get(absPath));
    pendingChanges.set(absPath, setTimeout(() => {
      pendingChanges.delete(absPath);
      if (stopping) return;
      serialize(() => handleFileDelete(absPath)).catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
    }, debounceMs));
  });

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
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completed = await Promise.race([
        drain.then(() => true),
        new Promise<false>(resolve => {
          timeout = setTimeout(() => resolve(false), shutdownTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!completed) {
        throw new Error(`Watcher shutdown drain timed out after ${shutdownTimeoutMs}ms`);
      }
      log('Stopped watching');
    },
  };
}
