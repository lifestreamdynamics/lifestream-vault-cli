/**
 * Type definitions for the sync engine.
 */
import type { SYNC_ROOT_MARKER_VERSION } from './root-marker.js';

export const SYNC_MODES = ['pull', 'push', 'sync'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const CONFLICT_STRATEGIES = ['newer', 'local', 'remote', 'ask'] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

export function isSyncMode(value: unknown): value is SyncMode {
  return typeof value === 'string' && (SYNC_MODES as readonly string[]).includes(value);
}

export function isConflictStrategy(value: unknown): value is ConflictStrategy {
  return typeof value === 'string' && (CONFLICT_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Persisted configuration for a single vault sync.
 * Stored in ~/.lsvault/syncs.json.
 */
export interface SyncConfig {
  /** Unique identifier for this sync configuration */
  id: string;
  /** Remote vault ID */
  vaultId: string;
  /** Absolute local filesystem path */
  localPath: string;
  /** Sync direction: pull (remote->local), push (local->remote), sync (bidirectional) */
  mode: SyncMode;
  /** How to resolve conflicts */
  onConflict: ConflictStrategy;
  /** Glob patterns to ignore (relative to localPath) */
  ignore: string[];
  /** ISO 8601 timestamp of last successful sync */
  lastSyncAt: string;
  /** Sync interval for auto-sync (e.g., '5m', '1h') */
  syncInterval?: string;
  /** Whether auto-sync is enabled */
  autoSync: boolean;
  /** Version of the local sync-root marker this configuration trusts. */
  rootMarkerVersion?: typeof SYNC_ROOT_MARKER_VERSION;
}

/**
 * Per-file tracking entry in sync state.
 */
export interface FileState {
  /** Document path (relative, using forward slashes) */
  path: string;
  /** SHA-256 hash of the file content */
  hash: string;
  /** Last modified time as ISO 8601 timestamp */
  mtime: string;
  /** File size in bytes */
  size: number;
}

/**
 * Persisted state for a single sync configuration.
 * Stored in ~/.lsvault/sync-state/<syncId>.json.
 */
export interface SyncState {
  /** Corresponding sync config ID */
  syncId: string;
  /** Map of document path -> file state for local files */
  local: Record<string, FileState>;
  /** Map of document path -> file state for remote files */
  remote: Record<string, FileState>;
  /** ETag from the most recent successful list response (for conditional polling). */
  remoteListEtag?: string;
  /** ISO 8601 timestamp when state was last updated */
  updatedAt: string;
}

/**
 * Options for creating a new sync configuration.
 */
export interface CreateSyncOptions {
  vaultId: string;
  localPath: string;
  mode?: SyncMode;
  onConflict?: ConflictStrategy;
  ignore?: string[];
  syncInterval?: string;
  autoSync?: boolean;
}
