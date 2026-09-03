/**
 * Sync configuration persistence.
 * Manages ~/.lsvault/syncs.json — the list of all configured sync pairs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { SyncConfig, CreateSyncOptions } from './types.js';
import { prepareSyncRoot, removeOwnedSyncRootMarker, writeSyncRootMarker, SYNC_ROOT_MARKER_VERSION } from './root-marker.js';
import { atomicWriteFileSync } from './atomic-write.js';

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const SYNCS_FILE = path.join(CONFIG_DIR, 'syncs.json');

/**
 * Read all sync configurations from disk.
 *
 * A missing file means "no syncs configured". A file that exists but cannot
 * be parsed is an error: silently treating it as empty would let `sync init`
 * overwrite every existing configuration and let the daemon report "nothing
 * to do" for roots it should be protecting.
 */
export function loadSyncConfigs(): SyncConfig[] {
  if (!fs.existsSync(SYNCS_FILE)) {
    return [];
  }
  const raw = fs.readFileSync(SYNCS_FILE, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Sync configuration file ${SYNCS_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Sync configuration file ${SYNCS_FILE} must contain a JSON array of sync configurations.`);
  }
  return parsed as SyncConfig[];
}

/**
 * Write all sync configurations to disk (temp file + rename, mode 0600).
 */
export function saveSyncConfigs(configs: SyncConfig[]): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  atomicWriteFileSync(SYNCS_FILE, JSON.stringify(configs, null, 2) + '\n', 'utf-8', { mode: 0o600 });
}

/**
 * Find a sync config by its ID.
 */
export function getSyncConfig(id: string): SyncConfig | undefined {
  return loadSyncConfigs().find(c => c.id === id);
}

/**
 * Find a sync config by vault ID.
 * Returns the first match (a vault should typically only have one sync config).
 */
export function getSyncConfigByVaultId(vaultId: string): SyncConfig | undefined {
  return loadSyncConfigs().find(c => c.vaultId === vaultId);
}

/**
 * Create a new sync configuration.
 * Returns the created config with a generated ID.
 */
export function createSyncConfig(
  opts: CreateSyncOptions,
  rootOptions: { markRoot?: boolean; createDir?: boolean } = {},
): SyncConfig {
  const configs = loadSyncConfigs();

  // Check for duplicate vault+path combinations
  const existing = configs.find(
    c => c.vaultId === opts.vaultId && c.localPath === opts.localPath,
  );
  if (existing) {
    throw new Error(
      `Sync already exists for vault ${opts.vaultId} at ${opts.localPath} (id: ${existing.id})`,
    );
  }

  const config: SyncConfig = {
    id: crypto.randomUUID(),
    vaultId: opts.vaultId,
    localPath: opts.localPath,
    mode: opts.mode ?? 'sync',
    onConflict: opts.onConflict ?? 'newer',
    ignore: opts.ignore ?? ['.git', '.DS_Store', 'node_modules'],
    lastSyncAt: new Date(0).toISOString(),
    syncInterval: opts.syncInterval,
    autoSync: opts.autoSync ?? false,
    ...(rootOptions.markRoot ? { rootMarkerVersion: SYNC_ROOT_MARKER_VERSION } : {}),
  };

  let markerWritten = false;
  if (rootOptions.markRoot) {
    prepareSyncRoot(config.localPath, { createDir: rootOptions.createDir, requireUnmarked: true });
    writeSyncRootMarker(config);
    markerWritten = true;
  }
  try {
    configs.push(config);
    saveSyncConfigs(configs);
  } catch (err) {
    if (markerWritten) removeOwnedSyncRootMarker(config);
    throw err;
  }
  return config;
}

/**
 * Delete a sync configuration by ID.
 * Returns true if the config was found and deleted.
 */
export function deleteSyncConfig(id: string): boolean {
  const configs = loadSyncConfigs();
  const index = configs.findIndex(c => c.id === id);
  if (index === -1) return false;
  const [removed] = configs.splice(index, 1);
  saveSyncConfigs(configs);
  removeOwnedSyncRootMarker(removed);
  return true;
}

/** Trust an existing legacy sync root by creating its marker and upgrading the config. */
export function trustSyncRoot(id: string): SyncConfig {
  const configs = loadSyncConfigs();
  const config = configs.find(c => c.id === id);
  if (!config) throw new Error(`Sync config not found: ${id}`);
  if (config.rootMarkerVersion === SYNC_ROOT_MARKER_VERSION) {
    throw new Error(`Sync root is already trusted: ${id}`);
  }
  prepareSyncRoot(config.localPath);
  writeSyncRootMarker(config);
  config.rootMarkerVersion = SYNC_ROOT_MARKER_VERSION;
  try {
    saveSyncConfigs(configs);
  } catch (err) {
    removeOwnedSyncRootMarker(config);
    throw err;
  }
  return config;
}

/**
 * Update the lastSyncAt timestamp for a sync config.
 */
export function updateLastSync(id: string, timestamp?: string): void {
  const configs = loadSyncConfigs();
  const config = configs.find(c => c.id === id);
  if (!config) throw new Error(`Sync config not found: ${id}`);
  config.lastSyncAt = timestamp ?? new Date().toISOString();
  saveSyncConfigs(configs);
}
