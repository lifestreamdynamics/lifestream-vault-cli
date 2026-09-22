import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSyncRoot,
  prepareSyncRoot,
  removeOwnedSyncRootMarker,
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

  it('requireUnmarked rejects a directory that already carries a marker', () => {
    const root = tempDir();
    writeSyncRootMarker(config(root));
    expect(() => prepareSyncRoot(root, { requireUnmarked: true })).toThrow(/already contains/);
    expect(() => prepareSyncRoot(root)).not.toThrow();
  });

  it('rejects a marker with an unsupported version', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), JSON.stringify({ version: 2, syncId: 'sync-1', vaultId: 'vault-1' }));
    expect(() => assertSyncRoot(config(root))).toThrow(/Unsupported sync root marker version.*expected 1, found 2/);
  });

  it('rejects malformed marker content distinctly from a read failure', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{not json');
    expect(() => assertSyncRoot(config(root))).toThrow(/Invalid sync root marker/);
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), JSON.stringify({ version: 1 }));
    expect(() => assertSyncRoot(config(root))).toThrow(/invalid marker fields/);
  });

  it('rejects a marker that is a symlink, even to a valid marker file', () => {
    const root = tempDir();
    const elsewhere = tempDir();
    const realMarker = path.join(elsewhere, 'marker.json');
    fs.writeFileSync(realMarker, JSON.stringify({ version: 1, syncId: 'sync-1', vaultId: 'vault-1' }));
    fs.symlinkSync(realMarker, path.join(root, SYNC_ROOT_MARKER));
    expect(() => assertSyncRoot(config(root))).toThrow(/must be a regular file/);
  });

  it('removeOwnedSyncRootMarker removes only the marker that belongs to the config', () => {
    const root = tempDir();
    writeSyncRootMarker(config(root));

    removeOwnedSyncRootMarker(config(root, { id: 'someone-else' }));
    expect(fs.existsSync(path.join(root, SYNC_ROOT_MARKER))).toBe(true);
    removeOwnedSyncRootMarker(config(root, { vaultId: 'other-vault' }));
    expect(fs.existsSync(path.join(root, SYNC_ROOT_MARKER))).toBe(true);

    removeOwnedSyncRootMarker(config(root));
    expect(fs.existsSync(path.join(root, SYNC_ROOT_MARKER))).toBe(false);

    // Missing root / missing marker: silent no-op.
    expect(() => removeOwnedSyncRootMarker(config(path.join(root, 'gone')))).not.toThrow();
  });
});
