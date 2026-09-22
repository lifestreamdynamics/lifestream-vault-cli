import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./root-marker.js', () => ({
  assertSyncRoot: vi.fn(),
  SYNC_ROOT_MARKER: '.lsvault-sync-root',
}));
vi.mock('./state.js', () => ({
  loadSyncState: vi.fn(() => ({ syncId: 'sync-1', local: {}, remote: {}, updatedAt: '' })),
  saveSyncState: vi.fn(),
  hashFileContent: vi.fn((content: string) => `hash-${content}`),
  buildRemoteFileState: vi.fn((docPath: string, content: string, mtime: string) => ({
    path: docPath, hash: `hash-${content}`, mtime, size: content.length,
  })),
}));
vi.mock('./config.js', () => ({ updateLastSync: vi.fn() }));
vi.mock('./ignore.js', () => ({
  shouldIgnore: vi.fn(() => false),
  resolveIgnorePatterns: vi.fn(() => []),
}));

import { executePull } from './engine.js';
import { createRemotePoller } from './remote-poller.js';
import type { SyncConfig } from './types.js';

describe('sync operations reject real symlink escapes', () => {
  let root: string;
  let outside: string;
  let config: SyncConfig;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-op-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-op-outside-'));
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
    config = {
      id: 'sync-1', vaultId: 'vault-1', localPath: root, mode: 'sync', onConflict: 'newer',
      ignore: [], lastSyncAt: '', autoSync: false, rootMarkerVersion: 1,
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('blocks a pull before fetching or writing through the symlink', async () => {
    const get = vi.fn();
    const result = await executePull({ documents: { get } } as any, config, {
      uploads: [],
      downloads: [{ path: 'linked/pulled.md', action: 'create', direction: 'download', sizeBytes: 1, reason: 'remote' }],
      deletes: [],
      totalBytes: 1,
    });

    expect(result.failed).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(outside, 'pulled.md'))).toBe(false);
  });

  it('blocks a remote poll before fetching or writing through the symlink', async () => {
    const get = vi.fn();
    const syncList = vi.fn().mockResolvedValue({
      vaultUnchanged: false,
      changes: [{ path: 'linked/polled.md', contentHash: 'hash', fileModifiedAt: '', kind: 'created' }],
      removed: [], unchanged: [], listEtag: 'etag',
    });
    const onError = vi.fn();
    const poller = createRemotePoller({ documents: { syncList, get } } as any, config, {
      ignorePatterns: [], intervalMs: 60_000, onError,
    });
    await poller.stop();

    expect(get).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/symbolic link/) }));
    expect(fs.existsSync(path.join(outside, 'polled.md'))).toBe(false);
  });
});
