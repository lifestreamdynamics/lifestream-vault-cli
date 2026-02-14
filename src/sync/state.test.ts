import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

import {
  loadSyncState,
  saveSyncState,
  deleteSyncState,
  hashFileContent,
  buildFileState,
  buildRemoteFileState,
  hasFileChanged,
} from './state.js';
import type { SyncState, FileState } from './types.js';

describe('sync state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadSyncState', () => {
    it('should return empty state when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const state = loadSyncState('sync-1');
      expect(state.syncId).toBe('sync-1');
      expect(state.local).toEqual({});
      expect(state.remote).toEqual({});
    });

    it('should return empty state for corrupt file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-json');
      const state = loadSyncState('sync-1');
      expect(state.local).toEqual({});
    });

    it('should return parsed state', () => {
      const existing: SyncState = {
        syncId: 'sync-1',
        local: {
          'notes/hello.md': {
            path: 'notes/hello.md',
            hash: 'abc123',
            mtime: '2025-01-01T00:00:00.000Z',
            size: 42,
          },
        },
        remote: {},
        updatedAt: '2025-01-01T00:00:00.000Z',
      };
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

      const state = loadSyncState('sync-1');
      expect(state.local['notes/hello.md'].hash).toBe('abc123');
    });
  });

  describe('saveSyncState', () => {
    it('should create state directory if it does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      saveSyncState({
        syncId: 'sync-1',
        local: {},
        remote: {},
        updatedAt: '',
      });
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('sync-state'),
        { recursive: true },
      );
    });

    it('should write state to file with updated timestamp', () => {
      mockedFs.existsSync.mockReturnValue(true);
      const state: SyncState = {
        syncId: 'sync-1',
        local: {},
        remote: {},
        updatedAt: '',
      };
      saveSyncState(state);

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('sync-1.json'),
        expect.any(String),
      );

      // updatedAt should have been set
      expect(state.updatedAt).not.toBe('');
    });
  });

  describe('deleteSyncState', () => {
    it('should return false when no state file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(deleteSyncState('sync-1')).toBe(false);
    });

    it('should delete state file and return true', () => {
      mockedFs.existsSync.mockReturnValue(true);
      expect(deleteSyncState('sync-1')).toBe(true);
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('sync-1.json'),
      );
    });
  });

  describe('hashFileContent', () => {
    it('should return consistent SHA-256 hash for same content', () => {
      const hash1 = hashFileContent('hello world');
      const hash2 = hashFileContent('hello world');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex is 64 chars
    });

    it('should return different hash for different content', () => {
      const hash1 = hashFileContent('hello');
      const hash2 = hashFileContent('world');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle Buffer input', () => {
      const hash1 = hashFileContent(Buffer.from('hello world'));
      const hash2 = hashFileContent('hello world');
      expect(hash1).toBe(hash2);
    });

    it('should handle empty content', () => {
      const hash = hashFileContent('');
      expect(hash).toHaveLength(64);
    });
  });

  describe('buildFileState', () => {
    it('should build state from local file', () => {
      const content = '# Hello\nWorld';
      mockedFs.readFileSync.mockReturnValue(Buffer.from(content));
      mockedFs.statSync.mockReturnValue({
        mtime: new Date('2025-06-15T10:00:00.000Z'),
        size: content.length,
      } as fs.Stats);

      const state = buildFileState('/home/user/vault/hello.md', 'hello.md');
      expect(state.path).toBe('hello.md');
      expect(state.hash).toHaveLength(64);
      expect(state.mtime).toBe('2025-06-15T10:00:00.000Z');
      expect(state.size).toBe(content.length);
    });
  });

  describe('buildRemoteFileState', () => {
    it('should build state from remote content', () => {
      const content = '# Remote Document';
      const state = buildRemoteFileState(
        'notes/remote.md',
        content,
        '2025-06-15T12:00:00.000Z',
      );
      expect(state.path).toBe('notes/remote.md');
      expect(state.hash).toHaveLength(64);
      expect(state.mtime).toBe('2025-06-15T12:00:00.000Z');
      expect(state.size).toBe(Buffer.byteLength(content, 'utf-8'));
    });
  });

  describe('hasFileChanged', () => {
    it('should return false when hashes match', () => {
      const hash = hashFileContent('same');
      const a: FileState = { path: 'a.md', hash, mtime: '2025-01-01T00:00:00Z', size: 4 };
      const b: FileState = { path: 'a.md', hash, mtime: '2025-06-01T00:00:00Z', size: 4 };
      expect(hasFileChanged(a, b)).toBe(false);
    });

    it('should return true when hashes differ', () => {
      const a: FileState = {
        path: 'a.md',
        hash: hashFileContent('old'),
        mtime: '2025-01-01T00:00:00Z',
        size: 3,
      };
      const b: FileState = {
        path: 'a.md',
        hash: hashFileContent('new'),
        mtime: '2025-01-01T00:00:00Z',
        size: 3,
      };
      expect(hasFileChanged(a, b)).toBe(true);
    });
  });
});
