/**
 * Sync-root identity marker and validation.
 *
 * The marker prevents a missing/unmounted sync root from being interpreted as
 * an intentionally empty directory and propagated as mass remote deletion.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SyncConfig } from './types.js';

export const SYNC_ROOT_MARKER = '.lsvault-sync-root';
export const SYNC_ROOT_MARKER_VERSION = 1 as const;

export interface SyncRootMarker {
  version: typeof SYNC_ROOT_MARKER_VERSION;
  syncId: string;
  vaultId: string;
}

export interface PrepareSyncRootOptions {
  createDir?: boolean;
  requireUnmarked?: boolean;
}

function markerPath(localPath: string): string {
  return path.join(localPath, SYNC_ROOT_MARKER);
}

function assertUsableDirectory(localPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(localPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Sync root does not exist: ${localPath}`);
    }
    throw new Error(`Cannot inspect sync root ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Sync root is not a directory: ${localPath}`);
  }
  try {
    fs.accessSync(localPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`Sync root must be readable and writable: ${localPath}`);
  }
}

/** Validate an init target before any API request is made. */
export function prepareSyncRoot(localPath: string, options: PrepareSyncRootOptions = {}): void {
  if (!fs.existsSync(localPath)) {
    if (!options.createDir) {
      throw new Error(`Sync root does not exist: ${localPath}. Pass --create-dir to create it.`);
    }
    try {
      fs.mkdirSync(localPath, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Error(`Failed to create sync root ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assertUsableDirectory(localPath);

  const target = markerPath(localPath);
  if (options.requireUnmarked && fs.existsSync(target)) {
    throw new Error(`Sync root already contains ${SYNC_ROOT_MARKER}; remove the existing sync configuration or choose another directory.`);
  }
}

function readMarker(localPath: string): SyncRootMarker {
  const target = markerPath(localPath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Sync root marker is missing: ${target}`);
    }
    throw new Error(`Cannot inspect sync root marker ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Sync root marker must be a regular file: ${target}`);
  }

  // Read outside the parse guard so an I/O failure (EACCES, EIO) is reported
  // as such rather than as a corrupt marker.
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read sync root marker ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let value: Partial<SyncRootMarker>;
  try {
    value = JSON.parse(raw) as Partial<SyncRootMarker>;
  } catch (err) {
    throw new Error(`Invalid sync root marker ${target}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (value === null || typeof value !== 'object' || typeof value.syncId !== 'string' || typeof value.vaultId !== 'string') {
    throw new Error(`Invalid sync root marker ${target}: invalid marker fields`);
  }
  if (value.version !== SYNC_ROOT_MARKER_VERSION) {
    throw new Error(
      `Unsupported sync root marker version at ${target}: expected ${SYNC_ROOT_MARKER_VERSION}, found ${String(value.version)}.`,
    );
  }
  return value as SyncRootMarker;
}

/** Create the authoritative marker. Existing markers are never overwritten. */
export function writeSyncRootMarker(config: Pick<SyncConfig, 'id' | 'vaultId' | 'localPath'>): void {
  assertUsableDirectory(config.localPath);
  const marker: SyncRootMarker = {
    version: SYNC_ROOT_MARKER_VERSION,
    syncId: config.id,
    vaultId: config.vaultId,
  };
  try {
    fs.writeFileSync(markerPath(config.localPath), JSON.stringify(marker, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Sync root already contains ${SYNC_ROOT_MARKER}; refusing to overwrite it.`);
    }
    throw err;
  }
}

/** Fail closed unless the configured root and its identity marker are valid. */
export function assertSyncRoot(config: SyncConfig): void {
  if (config.rootMarkerVersion !== SYNC_ROOT_MARKER_VERSION) {
    throw new Error(
      `Sync ${config.id} has an untrusted legacy root. Run \`lsvault sync trust-root ${config.id}\` after verifying ${config.localPath}.`,
    );
  }
  assertUsableDirectory(config.localPath);
  const marker = readMarker(config.localPath);
  if (marker.syncId !== config.id || marker.vaultId !== config.vaultId) {
    throw new Error(
      `Sync root marker mismatch at ${config.localPath}: expected sync ${config.id} for vault ${config.vaultId}.`,
    );
  }
}

/** Remove only a marker that belongs to the supplied configuration. */
export function removeOwnedSyncRootMarker(config: SyncConfig): void {
  try {
    const marker = readMarker(config.localPath);
    if (marker.syncId === config.id && marker.vaultId === config.vaultId) {
      fs.unlinkSync(markerPath(config.localPath));
    }
  } catch {
    // Config deletion must not remove unknown/malformed markers or fail because
    // an offline root is unavailable.
  }
}
