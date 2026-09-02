import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveWithinSyncRoot } from './safe-path.js';

describe('resolveWithinSyncRoot', () => {
  it('resolves a canonical nested document path', () => {
    expect(resolveWithinSyncRoot('/vault', 'notes/today.md')).toBe(path.resolve('/vault/notes/today.md'));
  });

  it.each([
    '../outside.md',
    'notes/../../outside.md',
    '/tmp/absolute.md',
    'C:\\tmp\\absolute.md',
    '\\\\server\\share\\file.md',
    'notes\\outside.md',
    '.lsvault-sync-root',
    'nested/.lsvault-sync-root',
    'notes//double.md',
  ])('rejects unsafe path %s', unsafePath => {
    expect(() => resolveWithinSyncRoot('/vault', unsafePath)).toThrow();
  });
});
