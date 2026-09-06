/**
 * Case-folding probe against a real filesystem.
 *
 * Inode identity is the whole mechanism here, so these run unmocked in a temp
 * directory the way `safe-path.real.test.ts` does. What the probe *measures*
 * therefore depends on the machine: CI is Linux/ext4 and case-sensitive, macOS
 * developers are usually on case-insensitive APFS. The assertions below are
 * written to hold either way — they check that the probe agrees with what the
 * filesystem actually does, not that it returns a particular constant.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYNC_ROOT_MARKER } from './root-marker.js';
import {
  clearPathFoldCache,
  defaultFoldOptions,
  probeCaseFolding,
  resolvePathFold,
  swapCase,
} from './path-collision.js';

/** What the filesystem under `dir` really does, established independently. */
function filesystemFoldsCase(dir: string): boolean {
  const probeFile = path.join(dir, 'CaseProbe.txt');
  fs.writeFileSync(probeFile, 'x');
  try {
    return fs.existsSync(path.join(dir, 'caseprobe.txt'));
  } finally {
    fs.unlinkSync(probeFile);
  }
}

describe('swapCase', () => {
  it('swaps cased characters and leaves the rest alone', () => {
    expect(swapCase('.lsvault-sync-root')).toBe('.LSVAULT-SYNC-ROOT');
    expect(swapCase('MiXeD-123')).toBe('mIxEd-123');
  });

  it('returns an uncased string unchanged, which the probe treats as inconclusive', () => {
    expect(swapCase('1234-.')).toBe('1234-.');
    expect(swapCase('')).toBe('');
  });
});

describe('probeCaseFolding', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-fold-'));
    clearPathFoldCache();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearPathFoldCache();
  });

  it('agrees with what the filesystem actually does', () => {
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{}');

    expect(probeCaseFolding(root)).toBe(filesystemFoldsCase(root));
  });

  it('creates nothing and removes nothing — safe inside status and --dry-run', () => {
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{}');
    const before = fs.readdirSync(root).sort();

    probeCaseFolding(root);

    expect(fs.readdirSync(root).sort()).toEqual(before);
  });

  it('reports folding when the swapped name resolves to the same inode', () => {
    // A case-insensitive volume is exactly "both names, one inode". CI runs on
    // case-sensitive ext4, so a hard link stands in for the volume — it
    // reproduces the condition the probe actually tests rather than the
    // platform that usually produces it.
    const marker = path.join(root, SYNC_ROOT_MARKER);
    fs.writeFileSync(marker, '{}');
    fs.linkSync(marker, path.join(root, swapCase(SYNC_ROOT_MARKER)));

    expect(probeCaseFolding(root)).toBe(true);
  });

  it('reports no folding when the swapped name is a different file', () => {
    // A case-sensitive volume may legitimately hold both names as two files.
    // "The swapped name exists" is not the question — "is it the same file" is.
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{}');
    fs.writeFileSync(path.join(root, swapCase(SYNC_ROOT_MARKER)), '{}');

    expect(probeCaseFolding(root)).toBe(false);
  });

  it('reports no folding when the swapped name is absent', () => {
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{}');

    expect(probeCaseFolding(root)).toBe(false);
  });

  it('is inconclusive when the root carries no marker', () => {
    // A legacy untrusted root. The swapped name would be absent too, so its
    // absence proves nothing about folding.
    expect(probeCaseFolding(root)).toBeUndefined();
  });

  it('is inconclusive for a directory that does not exist', () => {
    expect(probeCaseFolding(path.join(root, 'nope'))).toBeUndefined();
  });
});

describe('resolvePathFold', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-fold-'));
    clearPathFoldCache();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    clearPathFoldCache();
  });

  it('uses the measured answer for case, whatever the platform would have assumed', () => {
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{}');

    expect(resolvePathFold(root).caseInsensitive).toBe(filesystemFoldsCase(root));
  });

  it('falls back to the platform default when the probe is inconclusive', () => {
    // No marker: exactly today's behaviour, which is the safe failure direction.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      clearPathFoldCache();
      expect(resolvePathFold(root, platform).caseInsensitive)
        .toBe(defaultFoldOptions(platform).caseInsensitive);
    }
  });

  it('leaves Unicode normalisation platform-derived', () => {
    // Not probed: the normalisation dimension fails only towards "does not
    // fold", which is the direction that cannot refuse a valid vault.
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{}');

    expect(resolvePathFold(root, 'darwin').normalizationInsensitive).toBe(true);
    clearPathFoldCache();
    expect(resolvePathFold(root, 'linux').normalizationInsensitive).toBe(false);
    clearPathFoldCache();
    expect(resolvePathFold(root, 'win32').normalizationInsensitive).toBe(false);
  });

  it('memoises per root so a full sync probes once, not once per document', () => {
    fs.writeFileSync(path.join(root, SYNC_ROOT_MARKER), '{}');
    const first = resolvePathFold(root);

    // Remove the marker: a re-probe would now be inconclusive and could differ.
    fs.unlinkSync(path.join(root, SYNC_ROOT_MARKER));

    expect(resolvePathFold(root)).toBe(first);
  });

  it('caches each root separately', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-fold-'));
    try {
      expect(resolvePathFold(root, 'darwin')).not.toBe(resolvePathFold(other, 'darwin'));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
