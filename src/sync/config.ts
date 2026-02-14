/**
 * Sync configuration persistence.
 * Manages ~/.lsvault/syncs.json — the list of all configured sync pairs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { SyncConfig, CreateSyncOptions } from './types.js';

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const SYNCS_FILE = path.join(CONFIG_DIR, 'syncs.json');

/**
 * Read all sync configurations from disk.
 */
export function loadSyncConfigs(): SyncConfig[] {
  if (!fs.existsSync(SYNCS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(SYNCS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SyncConfig[];
  } catch {
    return [];
  }
}

/**
 * Write all sync configurations to disk.
 */
export function saveSyncConfigs(configs: SyncConfig[]): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(SYNCS_FILE, JSON.stringify(configs, null, 2) + '\n');
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
export function createSyncConfig(opts: CreateSyncOptions): SyncConfig {
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
  };

  configs.push(config);
  saveSyncConfigs(configs);
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
  configs.splice(index, 1);
  saveSyncConfigs(configs);
  return true;
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
