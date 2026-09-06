/**
 * Guard against a remote listing that implies a catastrophic local deletion.
 *
 * Both deletion paths — the poller's `sync.removed` set and the pull diff's
 * "gone from remote" set — are derived by subtracting the *current* remote
 * listing from the last-known state. That derivation cannot tell a genuine
 * tombstone from a listing that came back short: a vault-scoped API key that
 * lost its scope, a lagging read replica, or a reconciler that pruned database
 * rows all present as "every document was deleted". Applying that verdict
 * unlinks the user's whole vault.
 *
 * The guard is a threshold, not a proof. It cannot distinguish a real bulk
 * delete from a bad listing either — it simply refuses to act on the class of
 * verdict where being wrong is unrecoverable, and leaves the operator to
 * confirm with `lsvault sync pull --allow-mass-delete`.
 */

/** Deletions below this count are always allowed, whatever the vault size. */
export const MASS_DELETE_FLOOR = 10;

/** Fraction of the known path set above which a deletion batch is refused. */
export const MASS_DELETE_FRACTION = 0.2;

export interface DeletionAssessment {
  /** True when the deletions may be applied. */
  allow: boolean;
  /** Operator-facing explanation. Present only when `allow` is false. */
  reason?: string;
}

/**
 * Decide whether a batch of remote-derived deletions is safe to apply.
 *
 * @param removedCount - How many tracked paths the remote listing no longer contains.
 * @param knownCount - How many paths the last-known remote state held.
 */
export function assessDeletions(removedCount: number, knownCount: number): DeletionAssessment {
  if (removedCount <= 0) return { allow: true };

  // Nothing was tracked before, so there is no baseline to be suspicious of —
  // these deletions can only have come from paths this run itself observed.
  if (knownCount <= 0) return { allow: true };

  // Every tracked document vanished at once. A listing that returns none of the
  // documents it returned last time is an anomaly, never a tombstone set: a real
  // "delete everything" is a sequence of deletes, not a single empty response.
  if (removedCount >= knownCount) {
    return {
      allow: false,
      reason:
        `the remote listing no longer contains any of the ${knownCount} document(s) this sync was tracking. `
        + 'An empty or truncated listing (a scope change on the API key, a lagging replica, a vault moved on the server) '
        + 'is indistinguishable from a real bulk delete, so no local file was removed.',
    };
  }

  const threshold = Math.max(MASS_DELETE_FLOOR, MASS_DELETE_FRACTION * knownCount);
  if (removedCount > threshold) {
    return {
      allow: false,
      reason:
        `${removedCount} of ${knownCount} tracked document(s) disappeared from the remote listing in one pass, `
        + `above the safety threshold of ${Math.floor(threshold)}. No local file was removed.`,
    };
  }

  return { allow: true };
}

/** The escape-hatch sentence appended to every refusal message shown to a user. */
export const MASS_DELETE_OVERRIDE_HINT =
  'Re-run with `lsvault sync pull --allow-mass-delete` once you have confirmed the documents really were deleted.';
