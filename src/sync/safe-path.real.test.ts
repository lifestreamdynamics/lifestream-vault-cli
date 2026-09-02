import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithinSyncRoot } from './safe-path.js';
import { createConflictFile } from './conflict.js';

describe('sync path containment with real symlinks', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-root-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-outside-'));
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('blocks a pull-style write through a symlinked directory', () => {
    expect(() => {
      const target = resolveWithinSyncRoot(root, 'linked/pulled.md');
      fs.writeFileSync(target, '# escaped');
    }).toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(outside, 'pulled.md'))).toBe(false);
  });

  it('blocks a poller-style delete through a symlinked directory', () => {
    const victim = path.join(outside, 'keep.md');
    fs.writeFileSync(victim, '# keep');

    expect(() => fs.unlinkSync(resolveWithinSyncRoot(root, 'linked/keep.md'))).toThrow(/symbolic link/);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('# keep');
  });

  it('blocks conflict backup creation through a symlinked directory', () => {
    expect(() => createConflictFile(root, 'linked/note.md', '# secret', 'remote')).toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
