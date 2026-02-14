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

    it('should stop on quota errors', async () => {
      const config = makeConfig();
      const diff = {
        uploads: [
          { path: 'a.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 50, reason: 'New' },
          { path: 'b.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 50, reason: 'New' },
        ],
        downloads: [],
        deletes: [],
        totalBytes: 100,
      };

      const mockClient = {
        documents: {
          put: vi.fn().mockRejectedValue(new Error('storage limit exceeded')),
        },
      } as any;

      mockedFs.readFileSync.mockReturnValue('content');

      const result = await executePush(mockClient, config, diff);

      // Should stop after first quota error, not retry the second file
      expect(result.errors).toHaveLength(1);
      expect(result.filesUploaded).toBe(0);
    });
  });
});
