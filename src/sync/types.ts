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
 * Which side's files a refused deletion batch would have removed.
 *
 * `'local'` is a pull refusing to unlink files on this machine; `'remote'` is a
 * push refusing to delete documents in the vault. The two want different
 * operator responses, so they are carried, persisted and reported separately.
 */
export type DeletionTarget = 'local' | 'remote';

/**
 * A batch of listing-derived deletions the mass-delete guard refused to apply.
 *
 * Persisted rather than only logged: the daemon has no operator watching its
 * output, and a refusal means the vault is *not* converging. `lsvault sync
 * status` reads this so the condition stays visible until it is resolved.
 */
export interface DeletionAnomaly {
  /** Which side would have lost files: `local` from a pull, `remote` from a push. */
  target: DeletionTarget;
  /** ISO 8601 timestamp of the refusal. */
  detectedAt: string;
  /** How many tracked paths the current listing no longer contained. */
  removedCount: number;
  /** How many paths the last-known state held. */
  knownCount: number;
  /** Operator-facing explanation from `assessDeletions`. */
  reason: string;
}

/**
 * A local deletion the server refused to propagate (HTTP 403).
 *
 * Deleting a document in a team vault is admin-only. Without this record the
 * push fails permanently, the pull phase then treats the missing local file as
 * "deleted locally, exists remotely" and restores it, and the next watcher pass
 * deletes it again — forever.
 */
export interface DeniedDelete {
  /** ISO 8601 timestamp of the first refusal. */
  deniedAt: string;
  /** The server-facing message that came back with the 403. */
  reason: string;
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
  /**
   * Most recent deletion batch refused by the mass-delete guard, keyed by the
   * side it would have deleted from.
   *
   * Keyed rather than a single field because both can be live at once: a
   * sync-mode reconciliation pushes and then pulls, and a machine whose drive
   * unmounted mid-run can trip both halves. Collapsing them would let the
   * second refusal hide the first.
   */
  deletionAnomalies?: Partial<Record<DeletionTarget, DeletionAnomaly>>;
  /** Document paths whose remote deletion the server refused, keyed by path. */
  deniedDeletes?: Record<string, DeniedDelete>;
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
