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

import { atomicWriteFileSync, sweepOrphanedTempFiles, TEMP_FILE_MIN_AGE_MS } from './atomic-write.js';

describe('atomicWriteFileSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.openSync.mockReturnValue(7);
    mockedFs.writeSync.mockReturnValue(0);
    mockedFs.fsyncSync.mockImplementation(() => undefined);
    mockedFs.closeSync.mockImplementation(() => undefined);
    mockedFs.chmodSync.mockImplementation(() => undefined);
    mockedFs.renameSync.mockImplementation(() => undefined);
    mockedFs.unlinkSync.mockImplementation(() => undefined);
    // No pre-existing target unless a test says otherwise.
    mockedFs.statSync.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  });

  it('writes content then renames to the target path', () => {
    atomicWriteFileSync('/vault/notes.md', '# Hello');

    expect(mockedFs.openSync).toHaveBeenCalledWith('/vault/notes.md.tmp.deadbeef', 'wx', 0o666);
    expect(mockedFs.writeSync).toHaveBeenCalledTimes(1);
    expect(mockedFs.writeSync).toHaveBeenCalledWith(7, '# Hello', 0, 'utf-8');
    expect(mockedFs.renameSync).toHaveBeenCalledTimes(1);
    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      '/vault/notes.md.tmp.deadbeef',
      '/vault/notes.md',
    );
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('fsyncs the file before the rename and the directory after it', () => {
    // Without the directory fsync a crash can leave the entry pointing at
    // neither the old nor the new file.
    const order: string[] = [];
    mockedFs.fsyncSync.mockImplementation(((fd: number) => { order.push(`fsync:${fd}`); }) as never);
    mockedFs.renameSync.mockImplementation((() => { order.push('rename'); }) as never);
    mockedFs.openSync.mockImplementation(((target: string) => (target === '/vault' ? 9 : 7)) as never);

    atomicWriteFileSync('/vault/notes.md', '# Hello');

    expect(order).toEqual(['fsync:7', 'rename', 'fsync:9']);
    expect(mockedFs.openSync).toHaveBeenCalledWith('/vault', 'r');
  });

  it('preserves the existing target permissions when no explicit mode is given', () => {
    // A file the user chmod'd 0600 must not come back world-readable after the
    // first sync write; writeFileSync's `mode` only applies at creation.
    mockedFs.statSync.mockReturnValue({ mode: 0o100600 } as never);

    atomicWriteFileSync('/vault/private.md', 'secret');

    expect(mockedFs.openSync).toHaveBeenCalledWith('/vault/private.md.tmp.deadbeef', 'wx', 0o600);
    expect(mockedFs.chmodSync).toHaveBeenCalledWith('/vault/private.md.tmp.deadbeef', 0o600);
  });

  it('an explicit mode wins over the existing target permissions', () => {
    mockedFs.statSync.mockReturnValue({ mode: 0o100644 } as never);

    atomicWriteFileSync('/state/sync.json', '{}', 'utf-8', { mode: 0o600 });

    expect(mockedFs.chmodSync).toHaveBeenCalledWith('/state/sync.json.tmp.deadbeef', 0o600);
  });

  it('passes the encoding argument through to the write', () => {
    atomicWriteFileSync('/vault/notes.md', 'content', 'ascii');

    expect(mockedFs.writeSync).toHaveBeenCalledWith(7, 'content', 0, 'ascii');
  });

  it('deletes the temp file and rethrows when renameSync throws', () => {
    const renameError = new Error('rename failed');
    mockedFs.renameSync.mockImplementation(() => { throw renameError; });

    expect(() => atomicWriteFileSync('/vault/notes.md', 'content')).toThrow(renameError);

    // Temp file must be cleaned up
    expect(mockedFs.unlinkSync).toHaveBeenCalledTimes(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/notes.md.tmp.deadbeef');
  });

  it('deletes the temp file and rethrows when the write throws', () => {
    const writeError = new Error('disk full');
    mockedFs.writeSync.mockImplementation(() => { throw writeError; });

    expect(() => atomicWriteFileSync('/vault/notes.md', 'content')).toThrow(writeError);

    // The open succeeded, so the descriptor must be released as well.
    expect(mockedFs.closeSync).toHaveBeenCalledWith(7);
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

  it('does not fail the write when the directory fsync is unsupported', () => {
    mockedFs.openSync.mockImplementation(((target: string) => {
      if (target === '/vault') throw new Error('EISDIR: illegal operation on a directory');
      return 7;
    }) as never);

    expect(() => atomicWriteFileSync('/vault/notes.md', '# Hello')).not.toThrow();
    expect(mockedFs.renameSync).toHaveBeenCalled();
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });
});

describe('sweepOrphanedTempFiles', () => {
  /** Baseline for the age arithmetic below; the sweep reads Date.now() itself. */
  const NOW = Date.now();
  /** Comfortably older than TEMP_FILE_MIN_AGE_MS but well inside the orphan cutoff. */
  const OLD_ENOUGH = NOW - (TEMP_FILE_MIN_AGE_MS + 60_000);

  /**
   * Stat mock driven by a path -> {isFile, mtimeMs} table. Anything absent from
   * the table throws ENOENT, which is what a missing canonical sibling looks
   * like to the sweep.
   */
  function stubStats(table: Record<string, { file: boolean; mtimeMs?: number }>): void {
    mockedFs.statSync.mockImplementation(((target: string) => {
      const entry = table[target];
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => entry.file, mtimeMs: entry.mtimeMs ?? OLD_ENOUGH };
    }) as never);
  }

  function stubDir(tree: Record<string, Array<{ name: string; dir?: boolean }>>): void {
    mockedFs.readdirSync.mockImplementation(((dir: string) => {
      const entries = tree[dir] ?? [];
      return entries.map(e => ({
        name: e.name,
        isFile: () => !e.dir,
        isDirectory: () => Boolean(e.dir),
      })) as unknown as fs.Dirent[];
    }) as unknown as typeof fs.readdirSync);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.unlinkSync.mockImplementation(() => undefined);
  });

  it('deletes a .md.tmp.<8hex> file when its canonical sibling is a real file', () => {
    stubDir({ '/vault': [{ name: 'foo.md.tmp.deadbeef' }, { name: 'foo.md' }] });
    stubStats({
      '/vault/foo.md.tmp.deadbeef': { file: true },
      '/vault/foo.md': { file: true },
    });

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/foo.md.tmp.deadbeef');
  });

  it('preserves a bare .tmp file — it was never written by this sync engine', () => {
    // The old pattern matched any `*.tmp`, so `budget.xlsx.tmp` beside
    // `budget.xlsx`, or `bar.md.tmp` from an unrelated tool, was destroyed on
    // every pull. Only the `.md.tmp.<8 hex>` form this module produces is ours.
    stubDir({ '/vault': [{ name: 'bar.md.tmp' }, { name: 'bar.md' }, { name: 'budget.xlsx.tmp' }, { name: 'budget.xlsx' }] });
    stubStats({
      '/vault/bar.md.tmp': { file: true },
      '/vault/bar.md': { file: true },
      '/vault/budget.xlsx.tmp': { file: true },
      '/vault/budget.xlsx': { file: true },
    });

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('preserves a temp file whose canonical counterpart is a DIRECTORY, not a file', () => {
    // existsSync alone is satisfied by a directory of the same name, which used
    // to make `build.md.tmp.<hex>` beside a `build.md/` directory disposable.
    stubDir({
      '/vault': [{ name: 'build.md.tmp.a1b2c3d4' }, { name: 'build.md', dir: true }],
      '/vault/build.md': [],
    });
    stubStats({
      '/vault/build.md.tmp.a1b2c3d4': { file: true },
      '/vault/build.md': { file: false },
    });

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('preserves a temp file younger than the in-flight window', () => {
    // A concurrent CLI or daemon may be mid-write; its rename has not happened yet.
    stubDir({ '/vault': [{ name: 'foo.md.tmp.deadbeef' }, { name: 'foo.md' }] });
    stubStats({
      '/vault/foo.md.tmp.deadbeef': { file: true, mtimeMs: NOW },
      '/vault/foo.md': { file: true },
    });

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('preserves a recent .md.tmp.<8hex> file when its canonical sibling does NOT exist', () => {
    stubDir({ '/vault': [{ name: 'orphan-no-sibling.md.tmp.a1b2c3d4' }] });
    stubStats({ '/vault/orphan-no-sibling.md.tmp.a1b2c3d4': { file: true } });

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
  });

  it('sweeps a sibling-less temp file once it is older than the orphan cutoff', () => {
    // Residue of an interrupted *create*: the canonical file was never made, so
    // the sibling test can never clear it, and it would live forever.
    stubDir({ '/vault': [{ name: 'orphan-no-sibling.md.tmp.a1b2c3d4' }] });
    stubStats({
      '/vault/orphan-no-sibling.md.tmp.a1b2c3d4': { file: true, mtimeMs: NOW - (48 * 60 * 60 * 1_000) },
    });

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/orphan-no-sibling.md.tmp.a1b2c3d4');
  });

  it('honours user ignore patterns but not the built-in temp-file patterns', () => {
    // `*.tmp` / `*.tmp.*` exist to keep our own temp files out of the sync set;
    // obeying them here would make the sweep a permanent no-op.
    stubDir({
      '/vault': [{ name: 'drafts', dir: true }, { name: 'keep.md.tmp.deadbeef' }, { name: 'keep.md' }],
      '/vault/drafts': [{ name: 'skip.md.tmp.deadbeef' }, { name: 'skip.md' }],
    });
    stubStats({
      '/vault/keep.md.tmp.deadbeef': { file: true },
      '/vault/keep.md': { file: true },
      '/vault/drafts/skip.md.tmp.deadbeef': { file: true },
      '/vault/drafts/skip.md': { file: true },
    });

    const removed = sweepOrphanedTempFiles('/vault', { ignorePatterns: ['*.tmp', '*.tmp.*', 'drafts/**'] });

    expect(removed).toBe(1);
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith('/vault/keep.md.tmp.deadbeef');
    expect(mockedFs.unlinkSync).not.toHaveBeenCalledWith('/vault/drafts/skip.md.tmp.deadbeef');
  });

  it('ignores files that are not temp files (e.g. unrelated .md files)', () => {
    stubDir({ '/vault': [{ name: 'notes.md' }, { name: 'README.txt' }] });
    stubStats({});

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
    stubDir({
      '/vault': [{ name: 'sub', dir: true }],
      '/vault/sub': [{ name: 'deep.md.tmp.cafe1234' }, { name: 'deep.md' }],
    });
    stubStats({
      '/vault/sub/deep.md.tmp.cafe1234': { file: true },
      '/vault/sub/deep.md': { file: true },
    });

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
    stubStats({
      '/vault/good.md.tmp.12345678': { file: true },
      '/vault/good.md': { file: true },
    });

    // Should not throw, and should still handle the good temp file
    expect(() => sweepOrphanedTempFiles('/vault')).not.toThrow();
    const removed = sweepOrphanedTempFiles('/vault');
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it('returns 0 when there are no temp files', () => {
    stubDir({});
    stubStats({});

    const removed = sweepOrphanedTempFiles('/vault');

    expect(removed).toBe(0);
  });
});
