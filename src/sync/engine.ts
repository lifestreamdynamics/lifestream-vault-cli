/**
 * Core sync engine — performs pull and push operations.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { LifestreamVaultClient, SyncListKnownState } from '@lifestreamdynamics/vault-sdk';
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
 *
 * When `lastState` is provided, files whose stat mtime and size match the
 * persisted entry skip the readFileSync + hash step entirely (D-2 fast-path).
 */
export function scanLocalFiles(
  localPath: string,
  ignorePatterns: string[],
  lastState?: SyncState,
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
          const stat = fs.statSync(absPath);
          const stored = lastState?.local?.[relPath];
          if (stored && stat.size === stored.size && stat.mtime.toISOString() === stored.mtime) {
            // mtime+size unchanged — reuse persisted hash, skip file read
            files[relPath] = stored;
          } else {
            const content = fs.readFileSync(absPath);
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
  }

  walk(localPath, '');
  return files;
}

/** Result type for {@link scanRemoteFiles}. */
export interface ScanRemoteResult {
  /** Map of doc paths -> FileState for all non-ignored remote files. */
  files: Record<string, FileState>;
  /** List ETag from this response, for use in the next call. */
  listEtag: string;
  /** True when the server confirmed the vault is unchanged (304 fast-path). */
  vaultUnchanged: boolean;
}

/**
 * Scan remote vault for document list using the syncList fast-path.
 *
 * When `knownState` is provided (with hashes and optionally a prior listEtag),
 * the server may respond 304 and `vaultUnchanged` will be true — in that case
 * `files` is rebuilt from `knownState.remote` without any per-doc network call.
 *
 * When `knownState` is omitted a full list is always fetched (backward-compat).
 */
export async function scanRemoteFiles(
  client: LifestreamVaultClient,
  vaultId: string,
  ignorePatterns: string[],
  knownState?: { remote: Record<string, FileState>; remoteListEtag?: string },
): Promise<ScanRemoteResult> {
  const sdkKnownState: SyncListKnownState = {
    hashes: knownState
      ? Object.fromEntries(Object.entries(knownState.remote).map(([k, v]) => [k, v.hash]))
      : {},
    listEtag: knownState?.remoteListEtag,
  };

  const sync = await client.documents.syncList(vaultId, sdkKnownState);

  if (sync.vaultUnchanged) {
    // Server confirmed nothing changed — rebuild files from persisted state.
    const files: Record<string, FileState> = {};
    if (knownState) {
      for (const [docPath, fs_] of Object.entries(knownState.remote)) {
        if (!shouldIgnore(docPath, ignorePatterns)) {
          files[docPath] = fs_;
        }
      }
    }
    return { files, listEtag: sync.listEtag, vaultUnchanged: true };
  }

  // Build files from changes + unchanged paths.
  const files: Record<string, FileState> = {};

  for (const change of sync.changes) {
    if (!shouldIgnore(change.path, ignorePatterns)) {
      files[change.path] = {
        path: change.path,
        hash: change.contentHash,
        mtime: change.fileModifiedAt,
        // sizeBytes is not provided by syncList change objects; use 0 as a
        // fallback — size is only used for progress-bar estimation in the diff.
        size: 0,
      };
    }
  }

  for (const unchangedPath of sync.unchanged) {
    if (!shouldIgnore(unchangedPath, ignorePatterns)) {
      // Reuse the persisted FileState so size is preserved for progress reporting.
      const stored = knownState?.remote?.[unchangedPath];
      files[unchangedPath] = stored ?? {
        path: unchangedPath,
        hash: sdkKnownState.hashes[unchangedPath] ?? '',
        mtime: '',
        size: 0,
      };
    }
  }

  return { files, listEtag: sync.listEtag, vaultUnchanged: false };
}

/**
 * Write a file atomically using a temp file + rename.
 * Prevents partial reads if the process is interrupted mid-write.
 */
function atomicWriteFileSync(targetPath: string, content: string, encoding: BufferEncoding = 'utf-8'): void {
  const tmpFile = targetPath + '.tmp.' + randomBytes(4).toString('hex');
  fs.writeFileSync(tmpFile, content, encoding);
  fs.renameSync(tmpFile, targetPath);
}

/**
 * Called when the SDK signals a 429 response while transferring a file.
 * The SDK will back off and retry automatically; the CLI uses this to
 * update the spinner text so the user sees "Rate limited — waiting and retrying…"
 * rather than an apparently frozen transfer.
 */
export type ThrottleCallback = (file: string) => void;

/**
 * Direction-specific callbacks for the sync operation helper.
 */
interface SyncOperationHandlers {
  /** The file entries to transfer (downloads for pull, uploads for push). */
  transfers: SyncDiffEntry[];
  /** The file entries to delete. */
  deletes: SyncDiffEntry[];
  /** Transfer a single file entry; returns the content for state tracking. */
  transferFile(entry: SyncDiffEntry, config: SyncConfig, onThrottle?: ThrottleCallback): Promise<string>;
  /** Delete a single file entry. */
  deleteFile(entry: SyncDiffEntry, config: SyncConfig): Promise<void>;
  /** Which counter to increment on successful transfer. */
  transferCounterKey: 'filesUploaded' | 'filesDownloaded';
}

/**
 * Default in-flight transfer count. A small number flattens the load1 spike
 * a full-vault `sync pull` causes on the API host without making single
 * transfers measurably slower.
 */
const DEFAULT_TRANSFER_CONCURRENCY = 4;
const MAX_TRANSFER_CONCURRENCY = 16;

/**
 * Validates and clamps a user-supplied concurrency value. Throws on invalid
 * values so the CLI can surface a clear error before kicking off any I/O.
 */
export function resolveConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TRANSFER_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TRANSFER_CONCURRENCY) {
    throw new Error(
      `--concurrency must be an integer between 1 and ${MAX_TRANSFER_CONCURRENCY} (got ${value})`,
    );
  }
  return value;
}

/**
 * Shared sync operation executor used by both pull and push.
 * Handles result initialization, state loading, progress callbacks,
 * quota error handling, state saving, and lastSync update.
 */
async function executeSyncOperation(
  config: SyncConfig,
  diff: SyncDiff,
  handlers: SyncOperationHandlers,
  onProgress?: ProgressCallback,
  concurrency: number = DEFAULT_TRANSFER_CONCURRENCY,
  onThrottle?: ThrottleCallback,
): Promise<SyncResult> {
  const result: SyncResult = {
    filesUploaded: 0,
    filesDownloaded: 0,
    filesDeleted: 0,
    bytesTransferred: 0,
    errors: [],
  };

  const state = loadSyncState(config.id);
  const allOps = [...handlers.transfers, ...handlers.deletes];
  let current = 0;
  // Once a quota error is hit anywhere in the pool we stop submitting new
  // work but let in-flight transfers drain to keep state consistent.
  let stopSubmitting = false;

  async function runOne(entry: SyncDiffEntry): Promise<void> {
    if (stopSubmitting) return;
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
      const content = await handlers.transferFile(entry, config, onThrottle);
      result[handlers.transferCounterKey]++;
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
      result.errors.push({ path: entry.path, error: message });
      if (isQuotaError(message)) {
        stopSubmitting = true;
      }
      // 429 errors that reach here have already exhausted SDK-level retries.
      // Stop submitting new work to avoid hammering a still-throttled API.
      if (isThrottleError(err)) {
        stopSubmitting = true;
      }
    }
  }

  // Bounded async pool. Workers race for entries off the queue tail; once
  // the queue is empty (or stopSubmitting is set), each worker exits and
  // Promise.all resolves only after every in-flight transfer has settled.
  const queue = handlers.transfers.slice();
  const poolSize = Math.min(Math.max(1, concurrency), Math.max(1, queue.length));
  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      while (!stopSubmitting) {
        const entry = queue.shift();
        if (!entry) return;
        await runOne(entry);
      }
    }),
  );

  for (const entry of handlers.deletes) {
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
      await handlers.deleteFile(entry, config);
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
 * Execute a pull operation: download remote changes to local.
 */
export async function executePull(
  client: LifestreamVaultClient,
  config: SyncConfig,
  diff: SyncDiff,
  onProgress?: ProgressCallback,
  concurrency?: number,
  onThrottle?: ThrottleCallback,
): Promise<SyncResult> {
  return executeSyncOperation(config, diff, {
    transfers: diff.downloads,
    deletes: diff.deletes,
    transferCounterKey: 'filesDownloaded',
    async transferFile(entry, cfg, throttleCallback) {
      const { content } = await retryWithBackoff(() =>
        client.documents.get(cfg.vaultId, entry.path),
        throttleCallback ? () => throttleCallback(entry.path) : undefined,
      );
      const localFile = path.join(cfg.localPath, entry.path);
      const localDir = path.dirname(localFile);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      atomicWriteFileSync(localFile, content, 'utf-8');
      return content;
    },
    async deleteFile(entry, cfg) {
      const localFile = path.join(cfg.localPath, entry.path);
      if (fs.existsSync(localFile)) {
        fs.unlinkSync(localFile);
      }
    },
  }, onProgress, concurrency, onThrottle);
}

/**
 * Execute a push operation: upload local changes to remote.
 */
export async function executePush(
  client: LifestreamVaultClient,
  config: SyncConfig,
  diff: SyncDiff,
  onProgress?: ProgressCallback,
  concurrency?: number,
  onThrottle?: ThrottleCallback,
): Promise<SyncResult> {
  return executeSyncOperation(config, diff, {
    transfers: diff.uploads,
    deletes: diff.deletes,
    transferCounterKey: 'filesUploaded',
    async transferFile(entry, cfg, throttleCallback) {
      const localFile = path.join(cfg.localPath, entry.path);
      const content = fs.readFileSync(localFile, 'utf-8');
      await retryWithBackoff(() =>
        client.documents.put(cfg.vaultId, entry.path, content),
        throttleCallback ? () => throttleCallback(entry.path) : undefined,
      );
      return content;
    },
    async deleteFile(entry, cfg) {
      await retryWithBackoff(() =>
        client.documents.delete(cfg.vaultId, entry.path),
      );
    },
  }, onProgress, concurrency, onThrottle);
}

/**
 * Retry a function with exponential backoff (max 3 retries) for transient
 * network errors. Throttle (429) and quota/permission errors are NOT retried
 * here — the SDK already retries 429s transparently (ky retry config), and
 * quota/permission errors are not recoverable by retrying.
 *
 * @param onThrottle - Optional callback to invoke when a 429 is observed.
 *   The SDK will retry automatically; this is called so the CLI can update
 *   its spinner text to "Rate limited — waiting and retrying…".
 *   The parameter value is the file path being transferred.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  onThrottle?: (file: string) => void,
): Promise<T> {
  const maxRetries = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);

      // Throttle errors: the SDK already exhausted its own retry budget with
      // proper Retry-After backoff. Don't layer another retry loop on top —
      // that would ignore the server's backoff signal and hammer the API.
      if (isThrottleError(err)) {
        onThrottle?.('');
        throw err;
      }

      // Don't retry on other non-transient errors
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

/**
 * Returns true when an error represents an HTTP 429 (Too Many Requests / rate
 * limited) response. The SDK retries 429s transparently; a 429 reaching here
 * means all retry attempts were exhausted.
 *
 * Prefers the structured status code the SDK attaches (RateLimitError sets
 * `statusCode = 429`) and only falls back to a narrow message match. The
 * message fallback is intentionally strict — it does NOT match "rate limit" or
 * "throttle" loosely, since those words appear in unrelated errors (e.g. an
 * authorization message mentioning a rate-limited account) and a false positive
 * would suppress a real error.
 */
export function isThrottleError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const code = (err as { statusCode?: unknown; status?: unknown }).statusCode
      ?? (err as { status?: unknown }).status;
    if (code === 429) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests/i.test(message);
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
