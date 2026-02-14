/**
 * Local file watcher for continuous sync.
 * Uses chokidar to detect file changes and triggers sync operations.
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { watch, type FSWatcher } from 'chokidar';
import type { LifestreamVaultClient } from '@lifestream-vault/sdk';
import type { SyncConfig } from './types.js';
import { shouldIgnore } from './ignore.js';
import { hashFileContent, loadSyncState, saveSyncState, buildRemoteFileState } from './state.js';
import { updateLastSync } from './config.js';
import { resolveConflict, detectConflict, createConflictFile, formatConflictLog } from './conflict.js';
import fs from 'node:fs';

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
): { watcher: FSWatcher; stop: () => Promise<void> } {
  const { ignorePatterns, onLog, onConflictLog, onError, debounceMs = 500 } = options;
  const recentlyWritten = new RecentlyWrittenSet();
  const pendingChanges = new Map<string, NodeJS.Timeout>();

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
      conflictFile = createConflictFile(config.localPath, docPath, remoteContent, 'remote');
      await client.documents.put(config.vaultId, docPath, localContent);
      log(`Conflict: ${docPath} — used local, saved remote as ${conflictFile}`);
    } else {
      conflictFile = createConflictFile(config.localPath, docPath, localContent, 'local');
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
      const content = fs.readFileSync(absPath, 'utf-8');
      const localHash = hashFileContent(content);
      const state = loadSyncState(config.id);
      const lastLocal = state.local[docPath];
      const lastRemote = state.remote[docPath];

      // Check remote for conflicts in bidirectional mode
      if (config.mode === 'sync' && lastRemote) {
        try {
          const remote = await client.documents.get(config.vaultId, docPath);
          const remoteHash = hashFileContent(remote.content);
          if (remoteHash !== lastRemote.hash) {
            const result = await handleConflict({
              absPath, docPath, localContent: content, localHash,
              lastLocal, lastRemote,
              remoteContent: remote.content, remoteHash,
              remoteUpdatedAt: remote.document.updatedAt, state,
            });
            if (result !== 'skip') return;
          }
        } catch {
          // Remote check failed — proceed with push
        }
      }

      // No conflict — push the change
      if (config.mode === 'push' || config.mode === 'sync') {
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
        await client.documents.delete(config.vaultId, docPath);
        log(`Deleted remote: ${docPath}`);

        const state = loadSyncState(config.id);
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

  watcher.on('add', (absPath: string) => {
    clearTimeout(pendingChanges.get(absPath));
    pendingChanges.set(absPath, setTimeout(() => {
      pendingChanges.delete(absPath);
      handleFileChange(absPath).catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
    }, debounceMs));
  });

  watcher.on('change', (absPath: string) => {
    clearTimeout(pendingChanges.get(absPath));
    pendingChanges.set(absPath, setTimeout(() => {
      pendingChanges.delete(absPath);
      handleFileChange(absPath).catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
    }, debounceMs));
  });

  watcher.on('unlink', (absPath: string) => {
    clearTimeout(pendingChanges.get(absPath));
    pendingChanges.set(absPath, setTimeout(() => {
      pendingChanges.delete(absPath);
      handleFileDelete(absPath).catch(err => onError?.(err instanceof Error ? err : new Error(String(err))));
    }, debounceMs));
  });

  watcher.on('error', (err: unknown) => {
    onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  log('Watching for changes...');

  return {
    watcher,
    stop: async () => {
      for (const timeout of pendingChanges.values()) {
        clearTimeout(timeout);
      }
      pendingChanges.clear();
      recentlyWritten.clear();
      await watcher.close();
      log('Stopped watching');
    },
  };
}
