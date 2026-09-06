/**
 * Tests for the pull/push diff, focused on the two guards it carries:
 * the mass-delete refusal and the denied-delete suppression.
 *
 * `path-collision.js` is mocked because the real fold is derived from
 * `process.platform` and is a deliberate no-op on Linux, where the CI runs —
 * the fold itself is covered by `path-collision.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./path-collision.js', () => ({
  assertNoPathCollisions: vi.fn(),
}));

import { computePullDiff, computePushDiff } from './diff.js';
import { assertNoPathCollisions } from './path-collision.js';
import type { FileState, SyncState } from './types.js';

const mockAssertNoPathCollisions = vi.mocked(assertNoPathCollisions);

function file(path: string, hash = `hash-${path}`): FileState {
  return { path, hash, mtime: '2026-01-01T00:00:00.000Z', size: 10 };
}

function files(count: number, prefix = 'doc'): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  for (let i = 0; i < count; i++) out[`${prefix}-${i}.md`] = file(`${prefix}-${i}.md`);
  return out;
}

function makeState(overrides: Partial<SyncState> = {}): SyncState {
  return { syncId: 'sync-1', local: {}, remote: {}, updatedAt: '', ...overrides };
}

describe('computePullDiff — mass-delete guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a listing that lost every tracked document and removes nothing', () => {
    // The reachable failure: a vault-scoped API key that lost its scope, or a
    // lagging replica, answers the listing with nothing. Subtraction then says
    // "all 50 documents were deleted" and the whole vault is unlinked.
    const tracked = files(50);
    const diff = computePullDiff(tracked, {}, makeState({ remote: tracked, local: tracked }));

    expect(diff.deletes).toEqual([]);
    expect(diff.deletionAnomaly).toBeDefined();
    expect(diff.deletionAnomaly?.removedCount).toBe(50);
    expect(diff.deletionAnomaly?.knownCount).toBe(50);
    expect(diff.deletionAnomaly?.reason).toMatch(/50/);
  });

  it('still applies creates and updates while withholding the deletions', () => {
    // Withholding the destructive half must not stall the rest of the sync.
    const tracked = files(50);
    const remote = { 'brand-new.md': file('brand-new.md') };
    const diff = computePullDiff(tracked, remote, makeState({ remote: tracked, local: tracked }));

    expect(diff.deletes).toEqual([]);
    expect(diff.downloads.map(d => d.path)).toEqual(['brand-new.md']);
    expect(diff.deletionAnomaly).toBeDefined();
  });

  it('applies the same batch when --allow-mass-delete is threaded through', () => {
    const tracked = files(50);
    const diff = computePullDiff(
      tracked, {}, makeState({ remote: tracked, local: tracked }), { allowMassDelete: true },
    );

    expect(diff.deletes).toHaveLength(50);
    // The operator confirmed it, so there is no anomaly left to report.
    expect(diff.deletionAnomaly).toBeUndefined();
  });

  it('leaves an ordinary deletion batch alone', () => {
    const tracked = files(50);
    const remaining = { ...tracked };
    delete remaining['doc-0.md'];

    const diff = computePullDiff(tracked, remaining, makeState({ remote: tracked, local: tracked }));

    expect(diff.deletes.map(d => d.path)).toEqual(['doc-0.md']);
    expect(diff.deletionAnomaly).toBeUndefined();
  });
});

describe('computePushDiff — mass-delete guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a full-tracked-set deletion derived from an empty local scan', () => {
    // The gating case, and the worse of the two directions: an unmounted network
    // drive or a mount point that reads empty makes every tracked path look
    // locally deleted, and the push would delete them from the vault every other
    // client syncs from — including clients that were never near the fault.
    const tracked = files(50);
    const diff = computePushDiff({}, tracked, makeState({ local: tracked, remote: tracked }));

    expect(diff.deletes).toEqual([]);
    expect(diff.deletionAnomaly).toBeDefined();
    expect(diff.deletionAnomaly?.target).toBe('remote');
    expect(diff.deletionAnomaly?.removedCount).toBe(50);
    expect(diff.deletionAnomaly?.knownCount).toBe(50);
    expect(diff.deletionAnomaly?.reason).toMatch(/the local scan/);
    expect(diff.deletionAnomaly?.reason).toMatch(/no remote document was deleted/);
  });

  it('still applies uploads while withholding the deletions', () => {
    const tracked = files(50);
    const local = { 'brand-new.md': file('brand-new.md') };
    const diff = computePushDiff(local, tracked, makeState({ local: tracked, remote: tracked }));

    expect(diff.deletes).toEqual([]);
    expect(diff.uploads.map(u => u.path)).toEqual(['brand-new.md']);
    expect(diff.deletionAnomaly).toBeDefined();
  });

  it('applies the same batch when --allow-mass-delete is threaded through', () => {
    const tracked = files(50);
    const diff = computePushDiff(
      {}, tracked, makeState({ local: tracked, remote: tracked }), { allowMassDelete: true },
    );

    expect(diff.deletes).toHaveLength(50);
    expect(diff.deletionAnomaly).toBeUndefined();
  });

  it('leaves an ordinary deletion batch alone', () => {
    const tracked = files(50);
    const remaining = { ...tracked };
    delete remaining['doc-0.md'];

    const diff = computePushDiff(remaining, tracked, makeState({ local: tracked, remote: tracked }));

    expect(diff.deletes.map(d => d.path)).toEqual(['doc-0.md']);
    expect(diff.deletionAnomaly).toBeUndefined();
  });

  it('uses the same threshold as the pull side', () => {
    // A push guard looser than the pull guard would be the more dangerous of
    // the two; keep them provably in lockstep.
    const tracked = files(50);
    const keepPushed = { ...tracked };
    const keepPulled = { ...tracked };
    for (let i = 0; i < 11; i++) {
      delete keepPushed[`doc-${i}.md`];
      delete keepPulled[`doc-${i}.md`];
    }

    const push = computePushDiff(keepPushed, tracked, makeState({ local: tracked, remote: tracked }));
    const pull = computePullDiff(tracked, keepPulled, makeState({ local: tracked, remote: tracked }));

    expect(push.deletionAnomaly).toBeDefined();
    expect(pull.deletionAnomaly).toBeDefined();
    expect(push.deletionAnomaly?.removedCount).toBe(pull.deletionAnomaly?.removedCount);
  });
});

describe('computePullDiff — denied deletes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not restore a document whose deletion the server refused', () => {
    // Without this, an editor's 403 on a team-vault delete turns into a loop:
    // push fails, pull restores the file, the watcher deletes it again, forever.
    const state = makeState({
      local: { 'notes/team.md': file('notes/team.md') },
      remote: { 'notes/team.md': file('notes/team.md') },
      deniedDeletes: { 'notes/team.md': { deniedAt: '2026-09-01T00:00:00.000Z', reason: 'forbidden (403)' } },
    });

    const diff = computePullDiff({}, { 'notes/team.md': file('notes/team.md') }, state);

    expect(diff.downloads).toEqual([]);
  });

  it('still restores a locally deleted document with no denial marker', () => {
    const state = makeState({
      local: { 'notes/ordinary.md': file('notes/ordinary.md') },
      remote: { 'notes/ordinary.md': file('notes/ordinary.md') },
    });

    const diff = computePullDiff({}, { 'notes/ordinary.md': file('notes/ordinary.md') }, state);

    expect(diff.downloads).toHaveLength(1);
    expect(diff.downloads[0].reason).toBe('Deleted locally, exists remotely (pull restores)');
  });

  it('still downloads a brand-new remote document even while a denial is recorded', () => {
    const state = makeState({
      local: { 'notes/team.md': file('notes/team.md') },
      remote: { 'notes/team.md': file('notes/team.md') },
      deniedDeletes: { 'notes/team.md': { deniedAt: '2026-09-01T00:00:00.000Z', reason: 'forbidden (403)' } },
    });

    const diff = computePullDiff(
      {},
      { 'notes/team.md': file('notes/team.md'), 'notes/new.md': file('notes/new.md') },
      state,
    );

    expect(diff.downloads.map(d => d.path)).toEqual(['notes/new.md']);
  });
});

describe('diff path-collision plumbing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks the union of local and remote paths on pull', () => {
    computePullDiff({ 'a.md': file('a.md') }, { 'b.md': file('b.md') }, makeState());
    expect(mockAssertNoPathCollisions).toHaveBeenCalledWith(['b.md', 'a.md']);
  });

  it('checks the union of local and remote paths on push', () => {
    computePushDiff({ 'a.md': file('a.md') }, { 'b.md': file('b.md') }, makeState());
    expect(mockAssertNoPathCollisions).toHaveBeenCalledWith(['b.md', 'a.md']);
  });

  it('propagates the refusal rather than planning work on a colliding set', () => {
    mockAssertNoPathCollisions.mockImplementationOnce(() => {
      throw new Error('names the same local file');
    });
    expect(() => computePullDiff({}, { 'a.md': file('a.md') }, makeState()))
      .toThrow(/names the same local file/);
  });
});
