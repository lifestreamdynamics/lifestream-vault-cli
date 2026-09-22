import { describe, it, expect } from 'vitest';
import { assessDeletions, massDeleteOverrideHint, MASS_DELETE_FLOOR } from './mass-delete-guard.js';

describe('assessDeletions', () => {
  it('allows a batch that deletes nothing', () => {
    expect(assessDeletions(0, 500)).toEqual({ allow: true });
  });

  it('allows deletions when nothing was tracked before', () => {
    // With no baseline there is no listing to be suspicious of.
    expect(assessDeletions(3, 0)).toEqual({ allow: true });
  });

  it(`allows up to ${MASS_DELETE_FLOOR} deletions however small the vault`, () => {
    // A 12-document vault losing 8 files is a plausible cleanup, and the
    // fraction alone (0.2 * 12 = 2.4) would refuse it.
    expect(assessDeletions(MASS_DELETE_FLOOR, 12).allow).toBe(true);
    expect(assessDeletions(MASS_DELETE_FLOOR + 1, 12).allow).toBe(false);
  });

  it('allows a batch inside the 20% fraction of a large vault', () => {
    expect(assessDeletions(200, 1000).allow).toBe(true);
    expect(assessDeletions(201, 1000).allow).toBe(false);
  });

  it('always refuses a listing that lost every tracked document', () => {
    // This is the shape of a truncated listing — a scope change on the API key,
    // a lagging replica, a vault moved server-side. A real bulk delete arrives
    // as a sequence, not as one empty response.
    const assessment = assessDeletions(50, 50);
    expect(assessment.allow).toBe(false);
    expect(assessment.reason).toContain('50');
  });

  it('refuses a total loss even for a tiny vault under the floor', () => {
    // 3 of 3 is below MASS_DELETE_FLOOR but is still an empty listing.
    expect(assessDeletions(3, 3).allow).toBe(false);
  });

  it('explains why it refused', () => {
    const assessment = assessDeletions(60, 100);
    expect(assessment.allow).toBe(false);
    expect(assessment.reason).toMatch(/60 of 100/);
    expect(assessment.reason).toMatch(/no local file was removed/);
  });

  it('applies identical thresholds to both targets', () => {
    // Same arithmetic, same verdict — only the prose differs. A push guard that
    // drifted looser than the pull guard would be the more dangerous of the two.
    for (const [removed, known] of [[0, 50], [10, 12], [11, 12], [200, 1000], [201, 1000], [50, 50]] as const) {
      expect(assessDeletions(removed, known, 'remote').allow)
        .toBe(assessDeletions(removed, known, 'local').allow);
    }
  });

  it('names the side that would have lost files, and what caused it', () => {
    // "your local nearly got wiped" and "your remote nearly got wiped" call for
    // different operator responses, so the messages must not be interchangeable.
    const local = assessDeletions(50, 50, 'local').reason ?? '';
    const remote = assessDeletions(50, 50, 'remote').reason ?? '';

    expect(local).toContain('the remote listing');
    expect(local).toContain('no local file was removed');
    expect(local).toContain('a scope change on the API key');

    expect(remote).toContain('the local scan');
    expect(remote).toContain('no remote document was deleted');
    expect(remote).toContain('every other client still has the vault intact');
    expect(remote).toContain('an unmounted drive');
  });
});

describe('massDeleteOverrideHint', () => {
  it('names the command that actually carries the override for that side', () => {
    // The pull flag does not unblock a refused push; sending an operator to the
    // wrong command sends them round a loop.
    expect(massDeleteOverrideHint('local')).toContain('lsvault sync pull --allow-mass-delete');
    expect(massDeleteOverrideHint('remote')).toContain('lsvault sync push --allow-mass-delete');
  });

  it('warns that a confirmed push delete costs every other client', () => {
    expect(massDeleteOverrideHint('remote')).toContain('every other client should lose them too');
  });
});
