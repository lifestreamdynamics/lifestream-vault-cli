import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
vi.mock('./root-marker.js', () => ({ assertSyncRoot: vi.fn(), SYNC_ROOT_MARKER: '.lsvault-sync-root' }));
const mockedFs = vi.mocked(fs);
import { assertSyncRoot } from './root-marker.js';

// Mock config/state modules
vi.mock('./conflict.js', () => ({
  createConflictFile: vi.fn(() => 'notes.conflicted.local.1970-01-01.md'),
}));

vi.mock('./state.js', () => ({
  loadSyncState: vi.fn(() => ({
    syncId: 'sync-1',
    local: {},
    remote: {},
    updatedAt: '1970-01-01T00:00:00.000Z',
  })),
  saveSyncState: vi.fn(),
  hashFileContent: vi.fn((content: string) => `hash-${content.slice(0, 10)}`),
  buildRemoteFileState: vi.fn((docPath: string, content: string, updatedAt: string) => ({
    path: docPath,
    hash: `hash-${content.slice(0, 10)}`,
    mtime: updatedAt,
    size: content.length,
  })),
}));

vi.mock('./config.js', () => ({
  updateLastSync: vi.fn(),
}));

vi.mock('./ignore.js', () => ({
  resolveIgnorePatterns: vi.fn(() => []),
  shouldIgnore: vi.fn(() => false),
}));

import {
  scanLocalFiles,
  scanRemoteFiles,
  executePull,
  executePush,
  sweepOrphanedTempFiles,
  isRetryableSyncError,
} from './engine.js';
import { computePullDiff, computePushDiff } from './diff.js';
import { loadSyncState, saveSyncState } from './state.js';
import { createConflictFile } from './conflict.js';
const mockedCreateConflictFile = vi.mocked(createConflictFile);
import { updateLastSync } from './config.js';
import type { SyncConfig, SyncState, FileState } from './types.js';

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'sync-1',
    vaultId: 'vault-1',
    localPath: '/home/user/vault',
    mode: 'sync',
    onConflict: 'newer',
    ignore: [],
    lastSyncAt: '1970-01-01T00:00:00.000Z',
    autoSync: false,
    ...overrides,
  };
}

describe('sync engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.lstatSync.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  });

  describe('scanLocalFiles', () => {
    it('should return empty object when directory does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const files = scanLocalFiles('/nonexistent', []);
      expect(files).toEqual({});
    });

    it('reuses persisted hash when mtime and size match (no readFileSync)', () => {
      const storedMtime = '2025-01-01T00:00:00.000Z';
      const storedSize = 42;
      const storedHash = 'stored-hash-' + 'x'.repeat(52);
      const lastState = {
        syncId: 'sync-1',
        local: {
          'hello.md': { path: 'hello.md', hash: storedHash, mtime: storedMtime, size: storedSize },
        },
        remote: {},
        updatedAt: '',
      };

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockImplementation((() => [
        { name: 'hello.md', isFile: () => true, isDirectory: () => false },
      ]) as unknown as typeof fs.readdirSync);
      mockedFs.statSync.mockReturnValue({
        mtime: new Date(storedMtime),
        size: storedSize,
      } as fs.Stats);

      const files = scanLocalFiles('/vault', [], lastState);
      expect(files['hello.md'].hash).toBe(storedHash);
      // readFileSync should NOT have been called for this file
      expect(mockedFs.readFileSync).not.toHaveBeenCalled();
    });

    it('re-hashes file when size differs from stored state', () => {
      const storedMtime = '2025-01-01T00:00:00.000Z';
      const lastState = {
        syncId: 'sync-1',
        local: {
          'hello.md': { path: 'hello.md', hash: 'old-hash', mtime: storedMtime, size: 42 },
        },
        remote: {},
        updatedAt: '',
      };

      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockImplementation((() => [
        { name: 'hello.md', isFile: () => true, isDirectory: () => false },
      ]) as unknown as typeof fs.readdirSync);
      mockedFs.statSync.mockReturnValue({
        mtime: new Date(storedMtime),
        size: 99, // differs from stored 42
      } as fs.Stats);
      mockedFs.readFileSync.mockReturnValue(Buffer.from('new content'));

      const files = scanLocalFiles('/vault', [], lastState);
      expect(mockedFs.readFileSync).toHaveBeenCalled();
      expect(files['hello.md'].hash).toContain('hash-new conten'); // mock returns hash-<first10>
    });

    it('should scan .md files recursively', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockImplementation(((dirPath: string) => {
        if (dirPath === '/vault') {
          return [
            { name: 'hello.md', isFile: () => true, isDirectory: () => false },
            { name: 'sub', isFile: () => false, isDirectory: () => true },
            { name: 'skip.txt', isFile: () => true, isDirectory: () => false },
          ] as unknown as fs.Dirent[];
        }
        if (dirPath.includes('sub')) {
          return [
            { name: 'nested.md', isFile: () => true, isDirectory: () => false },
          ] as unknown as fs.Dirent[];
        }
        return [] as unknown as fs.Dirent[];
      }) as unknown as typeof fs.readdirSync);

      mockedFs.readFileSync.mockReturnValue(Buffer.from('content'));
      mockedFs.statSync.mockReturnValue({
        mtime: new Date('2025-01-01'),
        size: 7,
      } as fs.Stats);

      const files = scanLocalFiles('/vault', []);
      expect(Object.keys(files)).toContain('hello.md');
      expect(Object.keys(files)).toContain('sub/nested.md');
      expect(Object.keys(files)).not.toContain('skip.txt');
    });
  });

  describe('scanRemoteFiles', () => {
    it('uses contentHash from syncList changes as FileState.hash', async () => {
      const fakeClient = {
        documents: {
          syncList: vi.fn().mockResolvedValue({
            changes: [
              {
                path: 'a.md',
                contentHash: 'a'.repeat(64),
                fileModifiedAt: '2025-01-01T00:00:00.000Z',
                kind: 'added',
              },
              {
                path: 'sub/b.md',
                contentHash: 'b'.repeat(64),
                fileModifiedAt: '2025-01-02T00:00:00.000Z',
                kind: 'added',
              },
            ],
            removed: [],
            unchanged: [],
            listEtag: 'etag-1',
            vaultUnchanged: false,
          }),
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await scanRemoteFiles(fakeClient as any, 'vault-1', []);
      expect(result.vaultUnchanged).toBe(false);
      expect(result.listEtag).toBe('etag-1');
      expect(result.files['a.md'].hash).toBe('a'.repeat(64));
      expect(result.files['sub/b.md'].hash).toBe('b'.repeat(64));
    });

    it('returns vaultUnchanged=true and rebuilds files from knownState on 304', async () => {
      const knownRemote = {
        'a.md': { path: 'a.md', hash: 'a'.repeat(64), mtime: '2025-01-01T00:00:00.000Z', size: 10 },
        'b.md': { path: 'b.md', hash: 'b'.repeat(64), mtime: '2025-01-02T00:00:00.000Z', size: 20 },
      };
      const fakeClient = {
        documents: {
          syncList: vi.fn().mockResolvedValue({
            changes: [],
            removed: [],
            unchanged: ['a.md', 'b.md'],
            listEtag: 'etag-cached',
            vaultUnchanged: true,
          }),
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await scanRemoteFiles(fakeClient as any, 'vault-1', [], {
        remote: knownRemote,
        remoteListEtag: 'etag-cached',
      });
      expect(result.vaultUnchanged).toBe(true);
      expect(result.listEtag).toBe('etag-cached');
      expect(result.files['a.md'].hash).toBe('a'.repeat(64));
      expect(result.files['a.md'].size).toBe(10);
      expect(result.files['b.md'].size).toBe(20);
      // No per-doc fetches needed
      expect(fakeClient.documents.syncList).toHaveBeenCalledTimes(1);
    });

    it('reuses persisted FileState for unchanged paths and uses size=0 for changed paths', async () => {
      const knownRemote = {
        'existing.md': { path: 'existing.md', hash: 'old-hash', mtime: '2025-01-01T00:00:00.000Z', size: 50 },
        'unchanged.md': { path: 'unchanged.md', hash: 'same-hash', mtime: '2025-01-01T00:00:00.000Z', size: 30 },
      };
      const fakeClient = {
        documents: {
          syncList: vi.fn().mockResolvedValue({
            changes: [
              { path: 'existing.md', contentHash: 'new-hash', fileModifiedAt: '2025-02-01T00:00:00.000Z', kind: 'changed' },
              { path: 'added.md', contentHash: 'add-hash', fileModifiedAt: '2025-02-01T00:00:00.000Z', kind: 'added' },
            ],
            removed: [],
            unchanged: ['unchanged.md'],
            listEtag: 'etag-2',
            vaultUnchanged: false,
          }),
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await scanRemoteFiles(fakeClient as any, 'vault-1', [], {
        remote: knownRemote,
        remoteListEtag: 'etag-1',
      });
      expect(result.vaultUnchanged).toBe(false);
      // Changed entry uses new hash but size=0 (not available from syncList)
      expect(result.files['existing.md'].hash).toBe('new-hash');
      expect(result.files['existing.md'].size).toBe(0);
      // Unchanged entry reuses persisted size
      expect(result.files['unchanged.md'].hash).toBe('same-hash');
      expect(result.files['unchanged.md'].size).toBe(30);
      // Added entry
      expect(result.files['added.md'].hash).toBe('add-hash');
    });
  });

  describe('computePullDiff', () => {
    it('should detect new remote files', () => {
      const diff = computePullDiff(
        {},
        { 'notes/new.md': { path: 'notes/new.md', hash: 'abc', mtime: '', size: 100 } },
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.downloads).toHaveLength(1);
      expect(diff.downloads[0].action).toBe('create');
      expect(diff.downloads[0].path).toBe('notes/new.md');
    });

    it('should detect updated remote files', () => {
      const lastState: SyncState = {
        syncId: 's1',
        local: { 'a.md': { path: 'a.md', hash: 'old', mtime: '', size: 10 } },
        remote: { 'a.md': { path: 'a.md', hash: 'old', mtime: '', size: 10 } },
        updatedAt: '',
      };
      const diff = computePullDiff(
        { 'a.md': { path: 'a.md', hash: 'old', mtime: '', size: 10 } },
        { 'a.md': { path: 'a.md', hash: 'new', mtime: '', size: 15 } },
        lastState,
      );
      expect(diff.downloads).toHaveLength(1);
      expect(diff.downloads[0].action).toBe('update');
    });

    it('should detect remote deletions', () => {
      const lastState: SyncState = {
        syncId: 's1',
        local: {},
        remote: { 'deleted.md': { path: 'deleted.md', hash: 'x', mtime: '', size: 5 } },
        updatedAt: '',
      };
      const diff = computePullDiff(
        { 'deleted.md': { path: 'deleted.md', hash: 'x', mtime: '', size: 5 } },
        {},
        lastState,
      );
      expect(diff.deletes).toHaveLength(1);
    });

    it('should return empty diff when nothing changed', () => {
      const state: FileState = { path: 'a.md', hash: 'same', mtime: '', size: 10 };
      const lastState: SyncState = {
        syncId: 's1',
        local: { 'a.md': state },
        remote: { 'a.md': state },
        updatedAt: '',
      };
      const diff = computePullDiff(
        { 'a.md': state },
        { 'a.md': state },
        lastState,
      );
      expect(diff.downloads).toHaveLength(0);
      expect(diff.deletes).toHaveLength(0);
    });

    it('should download all remote files when local is empty', () => {
      const diff = computePullDiff(
        {},
        {
          'a.md': { path: 'a.md', hash: 'h1', mtime: '', size: 10 },
          'b.md': { path: 'b.md', hash: 'h2', mtime: '', size: 20 },
        },
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.downloads).toHaveLength(2);
      expect(diff.downloads.every((d) => d.action === 'create')).toBe(true);
      expect(diff.deletes).toHaveLength(0);
    });

    it('should produce no changes when remote is empty and no prior state', () => {
      const diff = computePullDiff(
        { 'local.md': { path: 'local.md', hash: 'h1', mtime: '', size: 10 } },
        {},
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.downloads).toHaveLength(0);
      expect(diff.deletes).toHaveLength(0);
    });

    it('should ignore orphaned lastState entries not in local or remote', () => {
      const lastState: SyncState = {
        syncId: 's1',
        local: { 'gone.md': { path: 'gone.md', hash: 'x', mtime: '', size: 5 } },
        remote: { 'gone.md': { path: 'gone.md', hash: 'x', mtime: '', size: 5 } },
        updatedAt: '',
      };
      const diff = computePullDiff({}, {}, lastState);
      // File is in lastState.remote but not in remoteFiles AND not in localFiles → no delete needed
      expect(diff.downloads).toHaveLength(0);
      expect(diff.deletes).toHaveLength(0);
    });

    it('should produce no actions for identical files with no prior state (first sync)', () => {
      const state: FileState = { path: 'same.md', hash: 'identical', mtime: '', size: 30 };
      const diff = computePullDiff(
        { 'same.md': state },
        { 'same.md': state },
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.downloads).toHaveLength(0);
      expect(diff.deletes).toHaveLength(0);
    });
  });

  describe('computePushDiff', () => {
    it('should detect new local files', () => {
      const diff = computePushDiff(
        { 'new.md': { path: 'new.md', hash: 'abc', mtime: '', size: 50 } },
        {},
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.uploads).toHaveLength(1);
      expect(diff.uploads[0].action).toBe('create');
    });

    it('should detect updated local files', () => {
      const lastState: SyncState = {
        syncId: 's1',
        local: { 'a.md': { path: 'a.md', hash: 'old', mtime: '', size: 10 } },
        remote: { 'a.md': { path: 'a.md', hash: 'old', mtime: '', size: 10 } },
        updatedAt: '',
      };
      const diff = computePushDiff(
        { 'a.md': { path: 'a.md', hash: 'new', mtime: '', size: 15 } },
        { 'a.md': { path: 'a.md', hash: 'old', mtime: '', size: 10 } },
        lastState,
      );
      expect(diff.uploads).toHaveLength(1);
      expect(diff.uploads[0].action).toBe('update');
    });

    it('should detect local deletions', () => {
      const lastState: SyncState = {
        syncId: 's1',
        local: { 'deleted.md': { path: 'deleted.md', hash: 'x', mtime: '', size: 5 } },
        remote: {},
        updatedAt: '',
      };
      const diff = computePushDiff(
        {},
        { 'deleted.md': { path: 'deleted.md', hash: 'x', mtime: '', size: 5 } },
        lastState,
      );
      expect(diff.deletes).toHaveLength(1);
    });

    it('should upload all local files when remote is empty', () => {
      const diff = computePushDiff(
        {
          'a.md': { path: 'a.md', hash: 'h1', mtime: '', size: 10 },
          'b.md': { path: 'b.md', hash: 'h2', mtime: '', size: 20 },
        },
        {},
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.uploads).toHaveLength(2);
      expect(diff.uploads.every((u) => u.action === 'create')).toBe(true);
      expect(diff.deletes).toHaveLength(0);
    });

    it('should produce no changes when local is empty and no prior state', () => {
      const diff = computePushDiff(
        {},
        { 'remote.md': { path: 'remote.md', hash: 'h1', mtime: '', size: 10 } },
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.uploads).toHaveLength(0);
      expect(diff.deletes).toHaveLength(0);
    });

    it('should produce no actions for identical files on first sync', () => {
      const state: FileState = { path: 'same.md', hash: 'identical', mtime: '', size: 30 };
      const diff = computePushDiff(
        { 'same.md': state },
        { 'same.md': state },
        { syncId: 's1', local: {}, remote: {}, updatedAt: '' },
      );
      expect(diff.uploads).toHaveLength(0);
      expect(diff.deletes).toHaveLength(0);
    });
  });

  describe('executePull', () => {
    it('should download files and update state', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          { path: 'new.md', action: 'create' as const, direction: 'download' as const, sizeBytes: 100, reason: 'New' },
        ],
        deletes: [],
        totalBytes: 100,
      };

      const mockClient = {
        documents: {
          get: vi.fn().mockResolvedValue({ content: '# Hello', document: { path: 'new.md' } }),
        },
      } as any;

      mockedFs.existsSync.mockReturnValue(true);

      const result = await executePull(mockClient, config, diff);

      expect(result.filesDownloaded).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
      expect(saveSyncState).toHaveBeenCalled();
      expect(updateLastSync).toHaveBeenCalledWith('sync-1');
    });

    it('should handle download errors', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          { path: 'fail.md', action: 'create' as const, direction: 'download' as const, sizeBytes: 50, reason: 'New' },
        ],
        deletes: [],
        totalBytes: 50,
      };

      const mockClient = {
        documents: {
          get: vi.fn().mockRejectedValue(new Error('quota exceeded')),
        },
      } as any;

      const result = await executePull(mockClient, config, diff);

      expect(result.filesDownloaded).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('quota exceeded');
    });

    it('holds back deletes when any download in the same run failed', async () => {
      // The delete list comes from a diff snapshot. Once a transfer in the same run
      // has failed, that snapshot is no longer known to hold, so acting on its deletes
      // can remove a file whose remote counterpart was never successfully read.
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          { path: 'fail.md', action: 'create' as const, direction: 'download' as const, sizeBytes: 10, reason: 'New' },
        ],
        deletes: [
          { path: 'gone.md', action: 'delete' as const, direction: 'download' as const, sizeBytes: 0, reason: 'Removed remotely' },
        ],
        totalBytes: 10,
      };

      const mockClient = {
        documents: {
          // An ordinary transient failure — not quota, not a 429.
          get: vi.fn().mockRejectedValue(new Error('socket hang up')),
        },
      } as any;
      mockedFs.existsSync.mockReturnValue(true);

      const result = await executePull(mockClient, config, diff);

      expect(result.filesDeleted).toBe(0);
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
      expect(result.errors.map(e => e.path)).toContain('gone.md');
      expect(result.errors.find(e => e.path === 'gone.md')?.error).toContain('fail.md');
    });

    it('still applies deletes when every download succeeded', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          { path: 'ok.md', action: 'create' as const, direction: 'download' as const, sizeBytes: 10, reason: 'New' },
        ],
        deletes: [
          { path: 'gone.md', action: 'delete' as const, direction: 'download' as const, sizeBytes: 0, reason: 'Removed remotely' },
        ],
        totalBytes: 10,
      };

      const mockClient = {
        documents: {
          get: vi.fn().mockResolvedValue({ content: '# ok', document: { path: 'ok.md' } }),
        },
      } as any;
      mockedFs.existsSync.mockReturnValue(true);

      const result = await executePull(mockClient, config, diff);

      expect(result.filesDownloaded).toBe(1);
      expect(result.filesDeleted).toBe(1);
    });

    it('rejects traversal downloads before network or filesystem access', async () => {
      const diff = {
        uploads: [],
        downloads: [
          { path: '../outside.md', action: 'create' as const, direction: 'download' as const, sizeBytes: 10, reason: 'remote' },
        ],
        deletes: [],
        totalBytes: 10,
      };
      const get = vi.fn();

      const result = await executePull({ documents: { get } } as any, makeConfig(), diff);

      expect(result.filesDownloaded).toBe(0);
      expect(result.errors[0].error).toMatch(/Unsafe/);
      expect(get).not.toHaveBeenCalled();
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('preserves a locally-modified file as a conflict copy before deleting it', async () => {
      // The pull diff emits this delete purely because the document vanished
      // remotely; it never compares the local file against last-known state.
      // Without a guard, a local edit the user has not pushed is destroyed.
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [],
        deletes: [
          { path: 'notes.md', action: 'delete' as const, direction: 'download' as const, sizeBytes: 0, reason: 'Deleted remotely' },
        ],
        totalBytes: 0,
      };

      vi.mocked(loadSyncState).mockReturnValueOnce({
        syncId: 'sync-1',
        // Last sync saw this content; the file on disk now differs.
        local: { 'notes.md': { path: 'notes.md', hash: 'hash-OLD', mtime: '', size: 3 } },
        remote: {},
        updatedAt: '1970-01-01T00:00:00.000Z',
      } as never);
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('MY UNSAVED EDIT' as never);

      const onConflict = vi.fn();
      const result = await executePull({} as any, config, diff, undefined, undefined, undefined, onConflict);

      expect(mockedCreateConflictFile).toHaveBeenCalledWith(
        config.localPath, 'notes.md', 'MY UNSAVED EDIT', 'local',
      );
      expect(onConflict).toHaveBeenCalledWith('notes.md', expect.any(String));
      expect(result.filesDeleted).toBe(1);
      expect(mockedFs.unlinkSync).toHaveBeenCalled();
    });

    it('deletes without a conflict copy when the local file is unchanged since last sync', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [],
        deletes: [
          { path: 'notes.md', action: 'delete' as const, direction: 'download' as const, sizeBytes: 0, reason: 'Deleted remotely' },
        ],
        totalBytes: 0,
      };

      vi.mocked(loadSyncState).mockReturnValueOnce({
        syncId: 'sync-1',
        local: { 'notes.md': { path: 'notes.md', hash: 'hash-UNCHANGED', mtime: '', size: 9 } },
        remote: {},
        updatedAt: '1970-01-01T00:00:00.000Z',
      } as never);
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('UNCHANGED' as never);

      await executePull({} as any, config, diff);

      expect(mockedCreateConflictFile).not.toHaveBeenCalled();
      expect(mockedFs.unlinkSync).toHaveBeenCalled();
    });

    it('should delete local files on remote deletion', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [],
        deletes: [
          { path: 'old.md', action: 'delete' as const, direction: 'download' as const, sizeBytes: 0, reason: 'Deleted remotely' },
        ],
        totalBytes: 0,
      };

      mockedFs.existsSync.mockReturnValue(true);

      const result = await executePull({} as any, config, diff);

      expect(result.filesDeleted).toBe(1);
      expect(mockedFs.unlinkSync).toHaveBeenCalled();
    });

    // -------------------------------------------------------------------
    // Conditional GET (ifNoneMatch) tests
    // -------------------------------------------------------------------

    it('create entry with remoteHash but NO local file uses unconditional GET and writes the file', async () => {
      // This is the critical regression guard: 'create' entries always have
      // remoteHash set (from computePullDiff), but the local file does not
      // exist yet.  Sending ifNoneMatch here would result in a guaranteed 304
      // (server hash === remoteHash), and the 304 branch would then ENOENT on
      // readFileSync.  The fix: only use conditional GET when the local file exists.
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          {
            path: 'brand-new.md',
            action: 'create' as const,
            direction: 'download' as const,
            sizeBytes: 40,
            reason: 'New remote file',
            remoteHash: 'aabbccdd',
          },
        ],
        deletes: [],
        totalBytes: 40,
      };

      const mockClient = {
        documents: {
          get: vi.fn().mockResolvedValue({
            content: '# Brand New',
            document: { path: 'brand-new.md' },
          }),
        },
      } as any;

      // Local file does NOT exist (create case)
      mockedFs.existsSync.mockReturnValue(false);

      const result = await executePull(mockClient, config, diff);

      expect(result.filesDownloaded).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Must be an unconditional GET — no ifNoneMatch options argument
      expect(mockClient.documents.get).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.documents.get.mock.calls[0];
      expect(callArgs[0]).toBe('vault-1');
      expect(callArgs[1]).toBe('brand-new.md');
      expect(callArgs[2]).toBeUndefined(); // no options → no ifNoneMatch

      // The file must be written
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it('update entry with remoteHash and existing local file uses conditional GET (ifNoneMatch)', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          {
            path: 'cached.md',
            action: 'update' as const,
            direction: 'download' as const,
            sizeBytes: 50,
            reason: 'Remote file updated',
            remoteHash: 'abc123',
          },
        ],
        deletes: [],
        totalBytes: 50,
      };

      const mockClient = {
        documents: {
          get: vi.fn().mockResolvedValue({
            notModified: false,
            etag: '"abc123"',
            content: '# Updated',
            document: { path: 'cached.md' },
          }),
        },
      } as any;

      // Local file exists → conditional GET is appropriate
      mockedFs.existsSync.mockReturnValue(true);

      const result = await executePull(mockClient, config, diff);

      expect(result.filesDownloaded).toBe(1);
      expect(mockClient.documents.get).toHaveBeenCalledWith(
        'vault-1',
        'cached.md',
        { ifNoneMatch: '"abc123"' },
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it('issues unconditional GET when no remoteHash on the entry', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          {
            path: 'noHash.md',
            action: 'create' as const,
            direction: 'download' as const,
            sizeBytes: 30,
            reason: 'New remote file',
            // no remoteHash
          },
        ],
        deletes: [],
        totalBytes: 30,
      };

      const mockClient = {
        documents: {
          get: vi.fn().mockResolvedValue({ content: '# NoHash', document: { path: 'noHash.md' } }),
        },
      } as any;

      mockedFs.existsSync.mockReturnValue(false);

      await executePull(mockClient, config, diff);

      expect(mockClient.documents.get).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.documents.get.mock.calls[0];
      expect(callArgs[0]).toBe('vault-1');
      expect(callArgs[1]).toBe('noHash.md');
      expect(callArgs[2]).toBeUndefined(); // no ifNoneMatch
    });

    it('skips write and reads local file on 304 (notModified: true), local file exists', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [
          {
            path: 'unchanged.md',
            action: 'update' as const,
            direction: 'download' as const,
            sizeBytes: 20,
            reason: 'Remote file updated',
            remoteHash: 'deaddead',
          },
        ],
        deletes: [],
        totalBytes: 20,
      };

      const mockClient = {
        documents: {
          get: vi.fn().mockResolvedValue({
            notModified: true,
            etag: '"deaddead"',
          }),
        },
      } as any;

      // Local file EXISTS — this is what enables the conditional GET path and
      // makes the subsequent readFileSync safe.
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('# Unchanged local content');

      const result = await executePull(mockClient, config, diff);

      // Transfer is still counted
      expect(result.filesDownloaded).toBe(1);
      expect(result.errors).toHaveLength(0);

      // writeFileSync must NOT be called (no write on 304)
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
      expect(mockedFs.renameSync).not.toHaveBeenCalled();

      // readFileSync IS called to retrieve local content for state hash
      expect(mockedFs.readFileSync).toHaveBeenCalled();

      // State must be saved with the correct hash derived from the local file
      expect(saveSyncState).toHaveBeenCalled();
    });
  });

  describe('executePush', () => {
    it('should upload files and update state', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [
          { path: 'local.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 80, reason: 'New' },
        ],
        downloads: [],
        deletes: [],
        totalBytes: 80,
      };

      const mockClient = {
        documents: {
          put: vi.fn().mockResolvedValue({ path: 'local.md' }),
        },
      } as any;

      mockedFs.readFileSync.mockReturnValue('# Local content');

      const result = await executePush(mockClient, config, diff);

      expect(result.filesUploaded).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(result.failed).toBe(false);
      expect(mockClient.documents.put).toHaveBeenCalledWith('vault-1', 'local.md', '# Local content');
      expect(saveSyncState).toHaveBeenCalled();
      expect(updateLastSync).toHaveBeenCalledWith('sync-1');
    });

    it('should delete remote files on local deletion', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [],
        downloads: [],
        deletes: [
          { path: 'old.md', action: 'delete' as const, direction: 'upload' as const, sizeBytes: 0, reason: 'Deleted locally' },
        ],
        totalBytes: 0,
      };

      const mockClient = {
        documents: {
          delete: vi.fn().mockResolvedValue(undefined),
        },
      } as any;

      const result = await executePush(mockClient, config, diff);

      expect(result.filesDeleted).toBe(1);
      expect(mockClient.documents.delete).toHaveBeenCalledWith('vault-1', 'old.md');
    });

    it('should stop submitting new uploads after a quota error', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [
          { path: 'a.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 50, reason: 'New' },
          { path: 'b.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 50, reason: 'New' },
          { path: 'c.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 50, reason: 'New' },
        ],
        downloads: [],
        deletes: [],
        totalBytes: 150,
      };

      const mockClient = {
        documents: {
          put: vi.fn().mockRejectedValue(new Error('storage limit exceeded')),
        },
      } as any;

      mockedFs.readFileSync.mockReturnValue('content');

      // concurrency=1 forces serialised execution so the third upload is
      // never picked up after the first quota error trips.
      const result = await executePush(mockClient, config, diff, undefined, 1);

      expect(result.filesUploaded).toBe(0);
      expect(mockClient.documents.put).toHaveBeenCalledTimes(1);
      // The quota failure itself plus the two uploads that were never attempted.
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]).toEqual({ path: 'a.md', error: 'storage limit exceeded', retryable: false });
      expect(result.errors.slice(1)).toEqual([
        { path: 'b.md', error: expect.stringMatching(/Skipped.*quota/), retryable: true },
        { path: 'c.md', error: expect.stringMatching(/Skipped.*quota/), retryable: true },
      ]);
      expect(result.filesSkipped).toBe(2);
      expect(result.failed).toBe(true);
    });

    it('does not run remote deletes after submission stopped, and records them as skipped', async () => {
      const diff = {
        uploads: [
          { path: 'a.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 50, reason: 'New' },
        ],
        downloads: [],
        deletes: [
          { path: 'gone.md', action: 'delete' as const, direction: 'upload' as const, sizeBytes: 0, reason: 'Deleted locally' },
        ],
        totalBytes: 50,
      };
      const mockClient = {
        documents: {
          put: vi.fn().mockRejectedValue(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 })),
          delete: vi.fn(),
        },
      } as any;
      mockedFs.readFileSync.mockReturnValue('content');

      const result = await executePush(mockClient, makeConfig(), diff, undefined, 1);

      expect(mockClient.documents.delete).not.toHaveBeenCalled();
      expect(result.filesDeleted).toBe(0);
      expect(result.filesSkipped).toBe(1);
      expect(result.errors.map(e => e.path)).toEqual(['a.md', 'gone.md']);
      expect(result.errors[1].error).toMatch(/Skipped.*rate limit/);
    });

    it('does not retry a permanent 4xx rejection', async () => {
      const diff = {
        uploads: [{ path: 'a.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 5, reason: 'New' }],
        downloads: [], deletes: [], totalBytes: 5,
      };
      const put = vi.fn().mockRejectedValue(Object.assign(new Error('Conflict'), { statusCode: 409 }));
      mockedFs.readFileSync.mockReturnValue('content');

      const result = await executePush({ documents: { put } } as any, makeConfig(), diff);

      expect(put).toHaveBeenCalledTimes(1);
      expect(result.errors[0]).toEqual(expect.objectContaining({ path: 'a.md', retryable: false }));
    });

    it('explains an admin-only 403 on a team-vault delete', async () => {
      const diff = {
        uploads: [], downloads: [],
        deletes: [{ path: 'team/doc.md', action: 'delete' as const, direction: 'upload' as const, sizeBytes: 0, reason: 'Deleted locally' }],
        totalBytes: 0,
      };
      const del = vi.fn().mockRejectedValue(Object.assign(new Error('Permission denied'), { statusCode: 403 }));

      const result = await executePush({ documents: { delete: del } } as any, makeConfig(), diff);

      expect(del).toHaveBeenCalledTimes(1);
      expect(result.errors[0].error).toMatch(/forbidden \(403\).*admin role.*not propagated/);
      expect(result.errors[0].retryable).toBe(false);
      expect(result.failed).toBe(true);
    });

    it('an untrusted root prevents the remote delete', async () => {
      vi.mocked(assertSyncRoot)
        .mockImplementationOnce(() => undefined)              // executeSyncOperation entry
        .mockImplementationOnce(() => { throw new Error('Sync root marker is missing'); }); // deleteFile
      const diff = {
        uploads: [], downloads: [],
        deletes: [{ path: 'old.md', action: 'delete' as const, direction: 'upload' as const, sizeBytes: 0, reason: 'Deleted locally' }],
        totalBytes: 0,
      };
      const del = vi.fn();

      const result = await executePush({ documents: { delete: del } } as any, makeConfig(), diff);

      expect(del).not.toHaveBeenCalled();
      expect(result.filesDeleted).toBe(0);
      expect(result.errors[0].error).toMatch(/marker is missing/);
    });
  });

  describe('executePush conditional writes', () => {
    it('sends the diff-observed remote hash as If-Match on an update', async () => {
      const diff = {
        uploads: [
          { path: 'local.md', action: 'update' as const, direction: 'upload' as const, sizeBytes: 10, reason: 'Changed', remoteHash: 'remote-hash-at-diff-time' },
        ],
        deletes: [],
        downloads: [],
        totalBytes: 10,
      };
      const put = vi.fn().mockResolvedValue({});
      mockedFs.readFileSync.mockReturnValue('# Local content' as any);

      await executePush({ documents: { put } } as any, makeConfig(), diff);

      expect(put).toHaveBeenCalledWith('vault-1', 'local.md', '# Local content', {
        ifMatch: 'remote-hash-at-diff-time',
      });
    });

    it('sends no precondition for a create, which has no remote counterpart', async () => {
      const diff = {
        uploads: [
          { path: 'new.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 10, reason: 'New' },
        ],
        deletes: [],
        downloads: [],
        totalBytes: 10,
      };
      const put = vi.fn().mockResolvedValue({});
      mockedFs.readFileSync.mockReturnValue('# New' as any);

      await executePush({ documents: { put } } as any, makeConfig(), diff);

      expect(put).toHaveBeenCalledWith('vault-1', 'new.md', '# New');
    });

    it('reports a 412 as a non-retryable conflict instead of retrying the write', async () => {
      const diff = {
        uploads: [
          { path: 'raced.md', action: 'update' as const, direction: 'upload' as const, sizeBytes: 10, reason: 'Changed', remoteHash: 'stale' },
        ],
        deletes: [],
        downloads: [],
        totalBytes: 10,
      };
      const put = vi.fn().mockRejectedValue(
        Object.assign(new Error('Precondition failed'), { statusCode: 412 }),
      );
      mockedFs.readFileSync.mockReturnValue('# Local content' as any);

      const result = await executePush({ documents: { put } } as any, makeConfig(), diff);

      // Retrying a precondition failure either keeps failing or, if forced past it,
      // performs the very overwrite the precondition prevents.
      expect(put).toHaveBeenCalledTimes(1);
      expect(result.filesUploaded).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].retryable).toBe(false);
      expect(result.errors[0].error).toContain('changed on the server');
    });

    it('guards the remote delete with the same precondition', async () => {
      const diff = {
        uploads: [],
        downloads: [],
        deletes: [
          { path: 'gone.md', action: 'delete' as const, direction: 'upload' as const, sizeBytes: 0, reason: 'Deleted locally', remoteHash: 'remote-hash-at-diff-time' },
        ],
        totalBytes: 0,
      };
      const del = vi.fn().mockResolvedValue(undefined);

      await executePush({ documents: { delete: del } } as any, makeConfig(), diff);

      expect(del).toHaveBeenCalledWith('vault-1', 'gone.md', {
        ifMatch: 'remote-hash-at-diff-time',
      });
    });
  });

  describe('executePull root safety', () => {
    it('an untrusted root prevents the local delete', async () => {
      vi.mocked(assertSyncRoot)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error('Sync root marker is missing'); });
      const diff = {
        uploads: [], downloads: [],
        deletes: [{ path: 'old.md', action: 'delete' as const, direction: 'download' as const, sizeBytes: 0, reason: 'Deleted remotely' }],
        totalBytes: 0,
      };
      mockedFs.existsSync.mockReturnValue(true);

      const result = await executePull({} as any, makeConfig(), diff);

      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
      expect(result.filesDeleted).toBe(0);
      expect(result.errors[0].error).toMatch(/marker is missing/);
    });
  });

  describe('concurrency limiting', () => {
    it('caps in-flight transfers to the configured concurrency', async () => {
      const config = makeConfig();
      const N = 12;
      const diff = {
        uploads: [],
        downloads: Array.from({ length: N }, (_, i) => ({
          path: `${i}.md`,
          action: 'create' as const,
          direction: 'download' as const,
          sizeBytes: 1,
          reason: 'New',
        })),
        deletes: [],
        totalBytes: N,
      };

      let inFlight = 0;
      let peak = 0;

      const mockClient = {
        documents: {
          get: vi.fn().mockImplementation(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return { content: '#', document: {} };
          }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      mockedFs.existsSync.mockReturnValue(true);

      const result = await executePull(mockClient, config, diff, undefined, 4);

      expect(result.filesDownloaded).toBe(N);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1); // confirm parallelism actually occurred
    });

    it('defaults to 4 in-flight transfers when concurrency is omitted', async () => {
      const config = makeConfig();
      const N = 8;
      const diff = {
        uploads: [],
        downloads: Array.from({ length: N }, (_, i) => ({
          path: `${i}.md`,
          action: 'create' as const,
          direction: 'download' as const,
          sizeBytes: 1,
          reason: 'New',
        })),
        deletes: [],
        totalBytes: N,
      };

      let inFlight = 0;
      let peak = 0;

      const mockClient = {
        documents: {
          get: vi.fn().mockImplementation(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return { content: '#', document: {} };
          }),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      mockedFs.existsSync.mockReturnValue(true);

      await executePull(mockClient, config, diff);

      expect(peak).toBeLessThanOrEqual(4);
    });
  });
});

// sweepOrphanedTempFiles is re-exported from engine.ts (from atomic-write.ts).
// Verify the re-export is wired correctly with a basic smoke test.
describe('sweepOrphanedTempFiles (re-export smoke test)', () => {
  it('is exported from engine and returns a number', () => {
    mockedFs.readdirSync.mockImplementation((() => []) as unknown as typeof fs.readdirSync);
    const result = sweepOrphanedTempFiles('/tmp');
    expect(typeof result).toBe('number');
    expect(result).toBe(0);
  });
});

describe('resolveConcurrency', () => {
  it('returns the default when undefined', async () => {
    const { resolveConcurrency } = await import('./engine.js');
    expect(resolveConcurrency(undefined)).toBe(4);
  });

  it('accepts integers between 1 and 16', async () => {
    const { resolveConcurrency } = await import('./engine.js');
    expect(resolveConcurrency(1)).toBe(1);
    expect(resolveConcurrency(16)).toBe(16);
    expect(resolveConcurrency(8)).toBe(8);
  });

  it('rejects 0 / negative / >16 / non-integer values', async () => {
    const { resolveConcurrency } = await import('./engine.js');
    expect(() => resolveConcurrency(0)).toThrow(/between 1 and 16/);
    expect(() => resolveConcurrency(-1)).toThrow(/between 1 and 16/);
    expect(() => resolveConcurrency(17)).toThrow(/between 1 and 16/);
    expect(() => resolveConcurrency(2.5)).toThrow(/between 1 and 16/);
    expect(() => resolveConcurrency(NaN)).toThrow(/between 1 and 16/);
  });
});

// ---------------------------------------------------------------------------
// isThrottleError — unit tests
// ---------------------------------------------------------------------------
describe('isThrottleError', () => {
  it('returns true for a structured 429 status on the error object', async () => {
    const { isThrottleError } = await import('./engine.js');
    expect(isThrottleError({ statusCode: 429 })).toBe(true);
    expect(isThrottleError({ status: 429 })).toBe(true);
    expect(isThrottleError(Object.assign(new Error('Rate limit exceeded'), { statusCode: 429 }))).toBe(true);
  });

  it('returns true for unambiguous 429 / too-many-requests messages', async () => {
    const { isThrottleError } = await import('./engine.js');
    expect(isThrottleError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(isThrottleError('Request failed with status code 429')).toBe(true);
    expect(isThrottleError('429')).toBe(true);
    expect(isThrottleError('too many requests')).toBe(true);
  });

  it('does NOT match loose "rate limit"/"throttle" wording without a 429 (avoids false positives)', async () => {
    const { isThrottleError } = await import('./engine.js');
    // These are NOT 429s — e.g. an auth error mentioning a rate-limited account.
    // Matching them would suppress a real error, so they must return false.
    expect(isThrottleError('rate limit exceeded')).toBe(false);
    expect(isThrottleError('throttled by server')).toBe(false);
    expect(isThrottleError('access denied for rate-limited account')).toBe(false);
  });

  it('returns false for unrelated errors', async () => {
    const { isThrottleError } = await import('./engine.js');
    expect(isThrottleError('Network connection refused')).toBe(false);
    expect(isThrottleError('Not found')).toBe(false);
    expect(isThrottleError('storage limit exceeded')).toBe(false);
    expect(isThrottleError('Unauthorized')).toBe(false);
    expect(isThrottleError('')).toBe(false);
    expect(isThrottleError({ statusCode: 403 })).toBe(false);
  });
});

describe('isRetryableSyncError', () => {
  it('treats every HTTP status as already handled (4xx permanent, 5xx/429 retried by the SDK)', () => {
    for (const statusCode of [400, 401, 403, 404, 409, 429, 500, 502, 503]) {
      expect(isRetryableSyncError(Object.assign(new Error(`HTTP ${statusCode}`), { statusCode }))).toBe(false);
    }
    expect(isRetryableSyncError({ status: 500 })).toBe(false);
  });

  it('treats quota and permission messages without a status as permanent', () => {
    expect(isRetryableSyncError(new Error('storage limit exceeded'))).toBe(false);
    expect(isRetryableSyncError(new Error('Permission denied'))).toBe(false);
    expect(isRetryableSyncError(new Error('HTTP 429 Too Many Requests'))).toBe(false);
  });

  it('retries only status-less network failures', () => {
    expect(isRetryableSyncError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableSyncError(new Error('Network request failed'))).toBe(true);
  });
});
