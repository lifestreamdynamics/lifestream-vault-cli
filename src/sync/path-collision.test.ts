import { describe, it, expect } from 'vitest';
import {
  assertNoPathCollisions,
  defaultFoldOptions,
  findPathCollisions,
  pathCollisionKey,
  SyncPathError,
} from './path-collision.js';

const MAC = { caseInsensitive: true, normalizationInsensitive: true };
const LINUX = { caseInsensitive: false, normalizationInsensitive: false };

/** `café.md` in the two Unicode normalisation forms macOS treats as one file. */
const NFC = 'Notes/café.md';
const NFD = 'Notes/café.md';

describe('defaultFoldOptions', () => {
  it('folds case and normalisation on darwin', () => {
    expect(defaultFoldOptions('darwin')).toEqual({ caseInsensitive: true, normalizationInsensitive: true });
  });

  it('folds case but not normalisation on win32', () => {
    expect(defaultFoldOptions('win32')).toEqual({ caseInsensitive: true, normalizationInsensitive: false });
  });

  it('folds nothing on linux, where both really are distinct files', () => {
    expect(defaultFoldOptions('linux')).toEqual({ caseInsensitive: false, normalizationInsensitive: false });
  });
});

describe('pathCollisionKey', () => {
  it('maps NFD onto NFC when normalisation is folded', () => {
    expect(pathCollisionKey(NFD, MAC)).toBe(pathCollisionKey(NFC, MAC));
  });

  it('keeps NFD and NFC apart when normalisation is not folded', () => {
    expect(pathCollisionKey(NFD, LINUX)).not.toBe(pathCollisionKey(NFC, LINUX));
  });
});

describe('findPathCollisions', () => {
  it('finds a case-only collision on a folding filesystem', () => {
    const collisions = findPathCollisions(['Notes/A.md', 'notes/a.md'], MAC);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].paths).toEqual(['Notes/A.md', 'notes/a.md']);
  });

  it('finds a normalisation-only collision on a folding filesystem', () => {
    const collisions = findPathCollisions([NFC, NFD], MAC);
    expect(collisions).toHaveLength(1);
  });

  it('reports nothing for the same two paths on linux', () => {
    // Refusing here would break a perfectly valid case-sensitive vault.
    expect(findPathCollisions(['Notes/A.md', 'notes/a.md'], LINUX)).toEqual([]);
    expect(findPathCollisions([NFC, NFD], LINUX)).toEqual([]);
  });

  it('does not report a path repeated identically', () => {
    expect(findPathCollisions(['notes/a.md', 'notes/a.md'], MAC)).toEqual([]);
  });

  it('reports nothing for an ordinary path set', () => {
    expect(findPathCollisions(['a.md', 'b.md', 'sub/c.md'], MAC)).toEqual([]);
  });
});

describe('assertNoPathCollisions', () => {
  it('names the colliding pair so the operator can rename one', () => {
    // Left unrefused, these two overwrite each other on every pass and mint a
    // fresh `.conflicted.*` copy each time, until the disk fills.
    expect(() => assertNoPathCollisions([NFC, NFD], MAC)).toThrow(SyncPathError);
    expect(() => assertNoPathCollisions([NFC, NFD], MAC)).toThrow(/Notes/);
  });

  it('counts additional collisions without listing them all', () => {
    expect(() => assertNoPathCollisions(['A.md', 'a.md', 'B.md', 'b.md'], MAC))
      .toThrow(/and 1 more collision/);
  });

  it('passes a clean path set', () => {
    expect(() => assertNoPathCollisions(['a.md', 'sub/b.md'], MAC)).not.toThrow();
  });
});
