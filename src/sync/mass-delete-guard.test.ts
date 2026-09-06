import { describe, it, expect } from 'vitest';
import { assessDeletions, MASS_DELETE_FLOOR } from './mass-delete-guard.js';

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
    expect(assessment.reason).toMatch(/No local file was removed/);
  });
});
