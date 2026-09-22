import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

import {
  detectConflict,
  resolveConflict,
  createConflictFile,
  formatConflictLog,
} from './conflict.js';
import type { FileState } from './types.js';

function makeFileState(overrides: Partial<FileState> = {}): FileState {
  return {
    path: 'notes/test.md',
    hash: 'default-hash',
    mtime: '2025-06-15T10:00:00.000Z',
    size: 100,
    ...overrides,
  };
}

describe('sync conflict', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedFs.lstatSync.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  });
  describe('detectConflict', () => {
    it('should return false when only local changed', () => {
      const local = makeFileState({ hash: 'new-local' });
      const remote = makeFileState({ hash: 'original' });
      const lastLocal = makeFileState({ hash: 'original' });
      const lastRemote = makeFileState({ hash: 'original' });
      expect(detectConflict(local, remote, lastLocal, lastRemote)).toBe(false);
    });

    it('should return false when only remote changed', () => {
      const local = makeFileState({ hash: 'original' });
      const remote = makeFileState({ hash: 'new-remote' });
      const lastLocal = makeFileState({ hash: 'original' });
      const lastRemote = makeFileState({ hash: 'original' });
      expect(detectConflict(local, remote, lastLocal, lastRemote)).toBe(false);
    });

    it('should return true when both changed', () => {
      const local = makeFileState({ hash: 'new-local' });
      const remote = makeFileState({ hash: 'new-remote' });
      const lastLocal = makeFileState({ hash: 'original' });
      const lastRemote = makeFileState({ hash: 'original' });
      expect(detectConflict(local, remote, lastLocal, lastRemote)).toBe(true);
    });

    it('should return false when both changed to same content', () => {
      const local = makeFileState({ hash: 'same-new' });
      const remote = makeFileState({ hash: 'same-new' });
      const lastLocal = makeFileState({ hash: 'original' });
      const lastRemote = makeFileState({ hash: 'original' });
      // Both sides independently arrived at identical bytes: nothing to resolve.
      expect(detectConflict(local, remote, lastLocal, lastRemote)).toBe(false);
    });

    it('should detect conflict on first sync when hashes differ', () => {
      const local = makeFileState({ hash: 'local-hash' });
      const remote = makeFileState({ hash: 'remote-hash' });
      expect(detectConflict(local, remote, undefined, undefined)).toBe(true);
    });

    it('should not detect conflict on first sync when hashes match', () => {
      const local = makeFileState({ hash: 'same' });
      const remote = makeFileState({ hash: 'same' });
      expect(detectConflict(local, remote, undefined, undefined)).toBe(false);
    });
  });

  describe('resolveConflict', () => {
    const local = makeFileState({ mtime: '2025-06-15T12:00:00.000Z' });
    const remote = makeFileState({ mtime: '2025-06-15T10:00:00.000Z' });
    const olderLocal = makeFileState({ mtime: '2025-06-15T08:00:00.000Z' });

    it('should return "local" for local strategy', () => {
      expect(resolveConflict('local', local, remote)).toBe('local');
    });

    it('should return "remote" for remote strategy', () => {
      expect(resolveConflict('remote', local, remote)).toBe('remote');
    });

    it('should pick newer file for newer strategy (local is newer)', () => {
      expect(resolveConflict('newer', local, remote)).toBe('local');
    });

    it('should pick newer file for newer strategy (remote is newer)', () => {
      expect(resolveConflict('newer', olderLocal, remote)).toBe('remote');
    });

    it('rejects the ask strategy instead of silently picking a side', () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      try {
        expect(() => resolveConflict('ask', local, remote)).toThrow(/does not resolve conflicts automatically.*no interactive terminal.*sync resolve/);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      }
    });

    it('rejects the ask strategy even on a TTY (no prompt is wired in)', () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        expect(() => resolveConflict('ask', local, remote)).toThrow(/does not resolve conflicts automatically/);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      }
    });
  });

  describe('createConflictFile', () => {
    it('should create a timestamped conflict file', () => {
      mockedFs.existsSync.mockReturnValue(true);

      const result = createConflictFile(
        '/home/user/vault',
        'notes/test.md',
        '# Conflicted content',
        'remote',
      );

      expect(result).toMatch(/^notes\/test\.conflicted\.remote\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('conflicted'),
        '# Conflicted content',
        { encoding: 'utf-8', flag: 'wx' },
      );
    });

    it('handles an extension-less document path without truncating it', () => {
      mockedFs.existsSync.mockReturnValue(true);

      const result = createConflictFile('/home/user/vault', 'notes/README', 'content', 'local');

      expect(result).toMatch(/^notes\/README\.conflicted\.local\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    });

    it('never overwrites an existing backup: appends a numeric suffix on EEXIST', () => {
      mockedFs.existsSync.mockReturnValue(true);
      let attempts = 0;
      mockedFs.writeFileSync.mockImplementation(() => {
        attempts++;
        if (attempts <= 2) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      });

      const result = createConflictFile('/home/user/vault', 'notes/test.md', 'content', 'remote');

      expect(attempts).toBe(3);
      expect(result).toMatch(/^notes\/test\.conflicted\.remote\.[0-9T-]+-2\.md$/);
      expect(String(mockedFs.writeFileSync.mock.calls[2][0])).toMatch(/-2\.md$/);
    });

    it('rethrows non-EEXIST write failures', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.writeFileSync.mockImplementation(() => { throw Object.assign(new Error('read-only fs'), { code: 'EROFS' }); });

      expect(() => createConflictFile('/home/user/vault', 'notes/test.md', 'content', 'remote')).toThrow('read-only fs');
    });

    it('should create parent directory if needed', () => {
      mockedFs.existsSync.mockReturnValue(false);

      createConflictFile('/vault', 'deep/nested/doc.md', 'content', 'local');

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('rejects a conflict path that escapes the sync root', () => {
      expect(() => createConflictFile('/vault', '../outside.md', 'content', 'local')).toThrow(/Unsafe/);
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('formatConflictLog', () => {
    it('should format a conflict log entry', () => {
      const log = formatConflictLog('notes/test.md', 'local', 'notes/test.conflicted.remote.2025-06-15T10-00-00.md');
      expect(log).toContain('CONFLICT');
      expect(log).toContain('notes/test.md');
      expect(log).toContain('resolved=local');
      expect(log).toContain('backup:');
    });

    it('should handle null conflict file path', () => {
      const log = formatConflictLog('test.md', 'remote', null);
      expect(log).toContain('resolved=remote');
      expect(log).not.toContain('backup:');
    });
  });
});
