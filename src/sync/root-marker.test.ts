import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSyncRoot,
  prepareSyncRoot,
  SYNC_ROOT_MARKER,
  writeSyncRootMarker,
} from './root-marker.js';
import type { SyncConfig } from './types.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-root-marker-'));
  tempDirs.push(dir);
  return dir;
}

function config(localPath: string, overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'sync-1', vaultId: 'vault-1', localPath, mode: 'sync', onConflict: 'newer',
    ignore: [], lastSyncAt: new Date(0).toISOString(), autoSync: false,
    rootMarkerVersion: 1,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('sync root marker', () => {
  it('rejects a missing init path unless createDir is enabled', () => {
    const root = path.join(tempDir(), 'new-root');
    expect(() => prepareSyncRoot(root)).toThrow(/--create-dir/);
    prepareSyncRoot(root, { createDir: true });
    expect(fs.statSync(root).isDirectory()).toBe(true);
  });

  it('rejects a regular file as a sync root', () => {
    const file = path.join(tempDir(), 'root-file');
    fs.writeFileSync(file, 'not a directory');
    expect(() => prepareSyncRoot(file)).toThrow(/not a directory/);
  });

  it('accepts an intentionally empty directory with its matching marker', () => {
    const root = tempDir();
    const value = config(root);
    writeSyncRootMarker(value);
    expect(() => assertSyncRoot(value)).not.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(root, SYNC_ROOT_MARKER), 'utf-8'))).toEqual({
      version: 1, syncId: 'sync-1', vaultId: 'vault-1',
    });
  });

  it('rejects legacy configs, missing markers, and marker identity mismatches', () => {
    const root = tempDir();
    expect(() => assertSyncRoot(config(root, { rootMarkerVersion: undefined }))).toThrow(/trust-root/);
    expect(() => assertSyncRoot(config(root))).toThrow(/marker is missing/);
    writeSyncRootMarker(config(root));
    expect(() => assertSyncRoot(config(root, { id: 'different-sync' }))).toThrow(/marker mismatch/);
  });

  it('never overwrites an existing marker', () => {
    const root = tempDir();
    writeSyncRootMarker(config(root));
    expect(() => writeSyncRootMarker(config(root, { id: 'other' }))).toThrow(/refusing to overwrite/);
  });
});
