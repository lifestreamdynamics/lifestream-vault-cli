/**
 * Tests for atomicWriteFileSync and sweepOrphanedTempFiles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

// randomBytes produces a predictable value in tests so we can assert on the
// temp-file name.  We mock the crypto module BEFORE importing atomic-write.
vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => Buffer.from([0xde, 0xad, 0xbe, 0xef])),
}));

import { atomicWriteFileSync, sweepOrphanedTempFiles } from './atomic-write.js';

describe('atomicWriteFileSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.renameSync.mockImplementation(() => undefined);
    mockedFs.unlinkSync.mockImplementation(() => undefined);
  });

  it('writes content then renames to the target path', () => {
    atomicWriteFileSync('/vault/notes.md', '# Hello');

    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      '/vault/notes.md.tmp.deadbeef',
      '# Hello',
      'utf-8',
    );
    expect(mockedFs.renameSync).toHaveBeenCalledTimes(1);
    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      '/vault/notes.md.tmp.deadbeef',
      '/vault/notes.md',
    );
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('passes the encoding argument through to writeFileSync', () => {
    atomicWriteFileSync('/vault/notes.md', 'content', 'ascii');

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      '/vault/notes.md.tmp.deadbeef',
      'content',
      'ascii',
    );
  });

  it('deletes the temp file and rethrows when renameSync throws', () => {
    const renameError = new Error('rename failed');
    mockedFs.renameSync.mockImplementation(() => { throw renameError; });

    expect(() => atomicWriteFileSync('/vault/notes.md', 'content')).toThrow(renameError);

    // Temp file must be cleaned up
    expect(mockedFs.unlinkSync).toHaveBeenCalledTimes(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/notes.md.tmp.deadbeef');
  });

  it('deletes the temp file and rethrows when writeFileSync throws', () => {
    const writeError = new Error('disk full');
    mockedFs.writeFileSync.mockImplementation(() => { throw writeError; });

    expect(() => atomicWriteFileSync('/vault/notes.md', 'content')).toThrow(writeError);

    // Temp file should still be attempted for cleanup (even if it may not exist)
    expect(mockedFs.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error even when unlinkSync also throws', () => {
    const renameError = new Error('rename failed');
    const unlinkError = new Error('unlink failed');
    mockedFs.renameSync.mockImplementation(() => { throw renameError; });
    mockedFs.unlinkSync.mockImplementation(() => { throw unlinkError; });

    // The ORIGINAL error (rename) must propagate, not the unlink error.
    expect(() => atomicWriteFileSync('/vault/notes.md', 'content')).toThrow(renameError);
  });
});

describe('sweepOrphanedTempFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.unlinkSync.mockImplementation(() => undefined);
  });

  it('deletes a .tmp.<8hex> file when its canonical sibling exists', () => {
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      if (dir === '/vault') {
        return [
          { name: 'foo.md.tmp.deadbeef', isFile: () => true, isDirectory: () => false },
          { name: 'foo.md', isFile: () => true, isDirectory: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);
    // canonical sibling exists
    mockedFs.existsSync.mockReturnValue(true);

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/foo.md.tmp.deadbeef');
  });

  it('deletes a .tmp file when its canonical sibling exists', () => {
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      if (dir === '/vault') {
        return [
          { name: 'bar.md.tmp', isFile: () => true, isDirectory: () => false },
          { name: 'bar.md', isFile: () => true, isDirectory: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);
    mockedFs.existsSync.mockReturnValue(true);

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/bar.md.tmp');
  });

  it('preserves a .tmp.<8hex> file when its canonical sibling does NOT exist', () => {
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      if (dir === '/vault') {
        return [
          { name: 'orphan-no-sibling.md.tmp.a1b2c3d4', isFile: () => true, isDirectory: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);
    // canonical sibling does NOT exist
    mockedFs.existsSync.mockReturnValue(false);

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('ignores files that are not temp files (e.g. unrelated .md files)', () => {
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      if (dir === '/vault') {
        return [
          { name: 'notes.md', isFile: () => true, isDirectory: () => false },
          { name: 'README.txt', isFile: () => true, isDirectory: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('skips hidden directories (starting with .)', () => {
    const readdirCalls: string[] = [];
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      readdirCalls.push(dir);
      if (dir === '/vault') {
        return [
          { name: '.git', isFile: () => false, isDirectory: () => true },
          { name: '.lsvault', isFile: () => false, isDirectory: () => true },
          { name: 'docs', isFile: () => false, isDirectory: () => true },
        ] as unknown as fs.Dirent[];
      }
      if (dir === '/vault/docs') {
        return [] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);

    sweepOrphanedTempFiles('/vault');

    // Hidden dirs must NOT be walked
    expect(readdirCalls).not.toContain('/vault/.git');
    expect(readdirCalls).not.toContain('/vault/.lsvault');
    // Non-hidden subdir is walked
    expect(readdirCalls).toContain('/vault/docs');
  });

  it('skips node_modules directory', () => {
    const readdirCalls: string[] = [];
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      readdirCalls.push(dir);
      if (dir === '/vault') {
        return [
          { name: 'node_modules', isFile: () => false, isDirectory: () => true },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);

    sweepOrphanedTempFiles('/vault');

    expect(readdirCalls).not.toContain('/vault/node_modules');
  });

  it('walks nested subdirectories and sweeps temp files there too', () => {
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      if (dir === '/vault') {
        return [
          { name: 'sub', isFile: () => false, isDirectory: () => true },
        ] as unknown as fs.Dirent[];
      }
      if (dir === '/vault/sub') {
        return [
          { name: 'deep.md.tmp.cafe1234', isFile: () => true, isDirectory: () => false },
        ] as unknown as fs.Dirent[];
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);
    mockedFs.existsSync.mockReturnValue(true);

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/sub/deep.md.tmp.cafe1234');
  });

  it('continues past an unreadable directory (defensive)', () => {
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      if (dir === '/vault') {
        return [
          { name: 'bad-dir', isFile: () => false, isDirectory: () => true },
          { name: 'good.md.tmp.12345678', isFile: () => true, isDirectory: () => false },
        ] as unknown as fs.Dirent[];
      }
      if (dir === '/vault/bad-dir') {
        throw new Error('EACCES: permission denied');
      }
      return [] as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);
    mockedFs.existsSync.mockReturnValue(true);

    // Should not throw, and should still handle the good temp file
    expect(() => sweepOrphanedTempFiles('/vault')).not.toThrow();
    const removed = sweepOrphanedTempFiles('/vault');
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it('returns 0 when there are no temp files', () => {
    mockedFs.readdirSync.mockImplementation((() => []) as unknown as typeof fs.readdirSync);

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
  });
});
