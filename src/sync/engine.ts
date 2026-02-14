/**
 * Core sync engine — performs pull and push operations.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LifestreamVaultClient } from '@lifestream-vault/sdk';
import type { SyncConfig, SyncState, FileState } from './types.js';
import { loadSyncState, saveSyncState, hashFileContent, buildRemoteFileState } from './state.js';
import { updateLastSync } from './config.js';
import { resolveIgnorePatterns, shouldIgnore } from './ignore.js';
import { computePullDiff, computePushDiff, type SyncDiff, type SyncDiffEntry } from './diff.js';

export interface SyncProgress {
  phase: 'scanning' | 'computing' | 'transferring' | 'complete';
  current: number;
  total: number;
  currentFile?: string;
  bytesTransferred: number;
  totalBytes: number;
}

export type ProgressCallback = (progress: SyncProgress) => void;

export interface SyncResult {
  filesUploaded: number;
  filesDownloaded: number;
  filesDeleted: number;
  bytesTransferred: number;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Scan local directory recursively for .md files.
 * Returns a map of relative doc paths -> FileState.
 */
export function scanLocalFiles(
  localPath: string,
  ignorePatterns: string[],
): Record<string, FileState> {
  const files: Record<string, FileState> = {};

  function walk(dir: string, prefix: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!shouldIgnore(relPath + '/', ignorePatterns)) {
          walk(path.join(dir, entry.name), relPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (!shouldIgnore(relPath, ignorePatterns)) {
          const absPath = path.join(dir, entry.name);
          const content = fs.readFileSync(absPath);
          const stat = fs.statSync(absPath);
          files[relPath] = {
            path: relPath,
            hash: hashFileContent(content),
            mtime: stat.mtime.toISOString(),
            size: stat.size,
          };
        }
      }
    }
  }

  walk(localPath, '');
  return files;
}

/**
 * Scan remote vault for document list.
 * Returns a map of doc paths -> FileState.
 */
export async function scanRemoteFiles(
  client: LifestreamVaultClient,
  vaultId: string,
  ignorePatterns: string[],
): Promise<Record<string, FileState>> {
  const docs = await client.documents.list(vaultId);
  const files: Record<string, FileState> = {};
  for (const doc of docs) {
    if (!shouldIgnore(doc.path, ignorePatterns)) {
      files[doc.path] = {
        path: doc.path,
        hash: '', // We don't have content hash from list; will use mtime for comparison
        mtime: doc.fileModifiedAt,
        size: doc.sizeBytes,
      };
    }
  }
  return files;
}

/**
 * Execute a pull operation: download remote changes to local.
 */
export async function executePull(
  client: LifestreamVaultClient,
  config: SyncConfig,
  diff: SyncDiff,
  onProgress?: ProgressCallback,
): Promise<SyncResult> {
  const result: SyncResult = {
    filesUploaded: 0,
    filesDownloaded: 0,
    filesDeleted: 0,
    bytesTransferred: 0,
    errors: [],
  };

  const state = loadSyncState(config.id);
  const allOps = [...diff.downloads, ...diff.deletes];
  let current = 0;

  for (const entry of diff.downloads) {
    current++;
    onProgress?.({
      phase: 'transferring',
      current,
      total: allOps.length,
      currentFile: entry.path,
      bytesTransferred: result.bytesTransferred,
      totalBytes: diff.totalBytes,
    });

    try {
      const { content } = await retryWithBackoff(() =>
        client.documents.get(config.vaultId, entry.path),
      );
      const localFile = path.join(config.localPath, entry.path);
      const localDir = path.dirname(localFile);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      fs.writeFileSync(localFile, content, 'utf-8');
      result.filesDownloaded++;
      result.bytesTransferred += entry.sizeBytes;

      // Update state
      state.local[entry.path] = {
        path: entry.path,
        hash: hashFileContent(content),
        mtime: new Date().toISOString(),
        size: Buffer.byteLength(content, 'utf-8'),
      };
      state.remote[entry.path] = buildRemoteFileState(
        entry.path,
        content,
        new Date().toISOString(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isQuotaError(message)) {
        result.errors.push({ path: entry.path, error: message });
        break; // Stop immediately on quota errors
      }
      result.errors.push({ path: entry.path, error: message });
    }
  }

  for (const entry of diff.deletes) {
    current++;
    onProgress?.({
      phase: 'transferring',
      current,
      total: allOps.length,
      currentFile: entry.path,
      bytesTransferred: result.bytesTransferred,
      totalBytes: diff.totalBytes,
    });

    try {
      const localFile = path.join(config.localPath, entry.path);
      if (fs.existsSync(localFile)) {
        fs.unlinkSync(localFile);
      }
      result.filesDeleted++;
      delete state.local[entry.path];
      delete state.remote[entry.path];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ path: entry.path, error: message });
    }
  }

  saveSyncState(state);
  updateLastSync(config.id);

  onProgress?.({
    phase: 'complete',
    current: allOps.length,
    total: allOps.length,
    bytesTransferred: result.bytesTransferred,
    totalBytes: diff.totalBytes,
  });

  return result;
}

/**
 * Execute a push operation: upload local changes to remote.
 */
export async function executePush(
  client: LifestreamVaultClient,
  config: SyncConfig,
  diff: SyncDiff,
  onProgress?: ProgressCallback,
): Promise<SyncResult> {
  const result: SyncResult = {
    filesUploaded: 0,
    filesDownloaded: 0,
    filesDeleted: 0,
    bytesTransferred: 0,
    errors: [],
  };

  const state = loadSyncState(config.id);
  const allOps = [...diff.uploads, ...diff.deletes];
  let current = 0;

  for (const entry of diff.uploads) {
    current++;
    onProgress?.({
      phase: 'transferring',
      current,
      total: allOps.length,
      currentFile: entry.path,
      bytesTransferred: result.bytesTransferred,
      totalBytes: diff.totalBytes,
    });

    try {
      const localFile = path.join(config.localPath, entry.path);
      const content = fs.readFileSync(localFile, 'utf-8');
      await retryWithBackoff(() =>
        client.documents.put(config.vaultId, entry.path, content),
      );
      result.filesUploaded++;
      result.bytesTransferred += entry.sizeBytes;

      // Update state
      state.local[entry.path] = {
        path: entry.path,
        hash: hashFileContent(content),
        mtime: new Date().toISOString(),
        size: Buffer.byteLength(content, 'utf-8'),
      };
      state.remote[entry.path] = buildRemoteFileState(
        entry.path,
        content,
        new Date().toISOString(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isQuotaError(message)) {
        result.errors.push({ path: entry.path, error: message });
        break; // Stop immediately on quota errors
      }
      result.errors.push({ path: entry.path, error: message });
    }
  }

  for (const entry of diff.deletes) {
    current++;
    onProgress?.({
      phase: 'transferring',
      current,
      total: allOps.length,
      currentFile: entry.path,
      bytesTransferred: result.bytesTransferred,
      totalBytes: diff.totalBytes,
    });

    try {
      await retryWithBackoff(() =>
        client.documents.delete(config.vaultId, entry.path),
      );
      result.filesDeleted++;
      delete state.local[entry.path];
      delete state.remote[entry.path];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ path: entry.path, error: message });
    }
  }

  saveSyncState(state);
  updateLastSync(config.id);

  onProgress?.({
    phase: 'complete',
    current: allOps.length,
    total: allOps.length,
    bytesTransferred: result.bytesTransferred,
    totalBytes: diff.totalBytes,
  });

  return result;
}

/**
 * Retry a function with exponential backoff (max 3 retries).
 */
async function retryWithBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // Don't retry on non-transient errors
      if (isQuotaError(message) || isPermissionError(message)) {
        throw err;
      }
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 500; // 500ms, 1s, 2s
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function isQuotaError(message: string): boolean {
  return /quota|storage limit|limit exceeded/i.test(message);
}

function isPermissionError(message: string): boolean {
  return /permission|forbidden|unauthorized|access denied/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Re-export diff functions for convenience
export { computePullDiff, computePushDiff, type SyncDiff, type SyncDiffEntry };
