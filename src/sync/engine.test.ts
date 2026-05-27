import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

// Mock config/state modules
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
} from './engine.js';
import { computePullDiff, computePushDiff } from './diff.js';
import { loadSyncState, saveSyncState } from './state.js';
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
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe('a.md');
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
