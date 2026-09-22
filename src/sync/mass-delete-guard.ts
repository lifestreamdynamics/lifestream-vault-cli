/**
 * Guard against a short listing that implies a catastrophic deletion.
 *
 * Every deletion path in the sync engine is derived the same way: subtract the
 * *current* listing of one side from the last-known state. That subtraction
 * cannot tell a genuine tombstone from a listing that came back short, and both
 * sides can come back short.
 *
 *   - Pull (`sync.removed`, `computePullDiff`): a vault-scoped API key that lost
 *     its scope, a lagging read replica, or a reconciler that pruned database
 *     rows all present as "every document was deleted", and unlink the user's
 *     whole local vault.
 *   - Push (`computePushDiff`): an unmounted network drive, a `localPath` whose
 *     mount point is momentarily empty, or a permission change mid-scan present
 *     identically — and delete every document in the *remote* vault, which is
 *     the copy every other client syncs from.
 *
 * The guard is a threshold, not a proof. It cannot distinguish a real bulk
 * delete from a bad listing either — it simply refuses to act on the class of
 * verdict where being wrong is unrecoverable, and leaves the operator to
 * confirm with `--allow-mass-delete`.
 */
import type { DeletionAnomaly, DeletionTarget, SyncState } from './types.js';

export type { DeletionTarget };


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

/** How each target describes the listing that went short and what it spared. */
const TARGET_PROSE: Record<DeletionTarget, { listing: string; causes: string; spared: string }> = {
  local: {
    listing: 'the remote listing',
    causes: 'a scope change on the API key, a lagging replica, a vault moved on the server',
    spared: 'no local file was removed',
  },
  remote: {
    listing: 'the local scan',
    causes: 'an unmounted drive, a sync root whose mount point is empty, a permission change mid-scan',
    spared: 'no remote document was deleted — every other client still has the vault intact',
  },
};

/**
 * Decide whether a batch of listing-derived deletions is safe to apply.
 *
 * @param removedCount - How many tracked paths the current listing no longer contains.
 * @param knownCount - How many paths the last-known state held.
 * @param target - Which side would have lost files. Shapes the message only;
 *   the thresholds are identical, because the arithmetic that produced the
 *   verdict is identical.
 */
export function assessDeletions(
  removedCount: number,
  knownCount: number,
  target: DeletionTarget = 'local',
): DeletionAssessment {
  if (removedCount <= 0) return { allow: true };

  // Nothing was tracked before, so there is no baseline to be suspicious of —
  // these deletions can only have come from paths this run itself observed.
  if (knownCount <= 0) return { allow: true };

  const prose = TARGET_PROSE[target];

  // Every tracked document vanished at once. A listing that returns none of the
  // documents it returned last time is an anomaly, never a tombstone set: a real
  // "delete everything" is a sequence of deletes, not a single empty response.
  if (removedCount >= knownCount) {
    return {
      allow: false,
      reason:
        `${prose.listing} no longer contains any of the ${knownCount} document(s) this sync was tracking. `
        + `An empty or truncated listing (${prose.causes}) is indistinguishable from a real bulk delete, so ${prose.spared}.`,
    };
  }

  const threshold = Math.max(MASS_DELETE_FLOOR, MASS_DELETE_FRACTION * knownCount);
  if (removedCount > threshold) {
    return {
      allow: false,
      reason:
        `${removedCount} of ${knownCount} tracked document(s) disappeared from ${prose.listing} in one pass, `
        + `above the safety threshold of ${Math.floor(threshold)}, so ${prose.spared}.`,
    };
  }

  return { allow: true };
}

/**
 * The escape-hatch sentence appended to a refusal message shown to a user.
 *
 * Names the command that actually carries the override for this target — the
 * pull flag does not unblock a refused push, and telling an operator otherwise
 * sends them round a loop.
 */
export function massDeleteOverrideHint(target: DeletionTarget): string {
  return target === 'local'
    ? 'Re-run with `lsvault sync pull --allow-mass-delete` once you have confirmed those documents really were deleted from the vault.'
    : 'Re-run with `lsvault sync push --allow-mass-delete` once you have confirmed those files really were deleted locally and every other client should lose them too.';
}

/**
 * Persist a refusal so it outlives the run that found it.
 *
 * Keyed by target: a refused push and a refused pull are different conditions
 * with different remedies, and a sync-mode reconciliation can trip both in one
 * pass. Overwriting one with the other would hide the first.
 */
export function recordDeletionAnomaly(state: SyncState, anomaly: DeletionAnomaly): void {
  state.deletionAnomalies = { ...state.deletionAnomalies, [anomaly.target]: anomaly };
}

/**
 * Drop a refusal once that side's listing is consistent again.
 *
 * @returns true when a marker was actually cleared, so callers only save state
 *   they changed.
 */
export function clearDeletionAnomaly(state: SyncState, target: DeletionTarget): boolean {
  if (!state.deletionAnomalies?.[target]) return false;
  delete state.deletionAnomalies[target];
  if (Object.keys(state.deletionAnomalies).length === 0) delete state.deletionAnomalies;
  return true;
}
