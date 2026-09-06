/**
 * Detection of document paths that are distinct on the server but name the same
 * file on the local filesystem.
 *
 * macOS and Windows fold case, and APFS/HFS+ additionally resolve a name
 * regardless of its Unicode normalisation form. `Notes/café.md` (NFC) and
 * `notes/café.md` (NFD) are two separate documents to the API and one file on
 * disk. Sync then oscillates: pulling one rewrites the other, the watcher
 * reports a change, the push rewrites it back, and every pass mints another
 * `.conflicted.*` copy until the disk fills.
 *
 * Linux is case- and normalisation-sensitive, so those same two paths really
 * are two files and folding them would refuse a perfectly valid vault.
 *
 * The case dimension is measured rather than assumed — see {@link resolvePathFold}
 * — because assuming it from `process.platform` is wrong in both directions: a
 * case-sensitive APFS volume would have a legitimate vault refused, and an
 * exFAT/NTFS/CIFS mount under Linux would collide while the check reported
 * nothing. The normalisation dimension stays platform-derived, which fails only
 * towards "does not fold", i.e. towards today's behaviour.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SYNC_ROOT_MARKER } from './root-marker.js';
import { SyncPathError } from './sync-errors.js';

export interface PathFoldOptions {
  /** Treat paths differing only by case as the same file (macOS, Windows). */
  caseInsensitive?: boolean;
  /** Treat paths differing only by Unicode normalisation form as the same file (APFS/HFS+). */
  normalizationInsensitive?: boolean;
}

/**
 * How the local filesystem is assumed to fold path names, from the platform
 * alone.
 *
 * This is only a fallback now: {@link resolvePathFold} measures the case
 * dimension instead, because the platform is a poor proxy for it in both
 * directions — a case-sensitive volume on macOS folds less than this assumes
 * (and a legitimate vault would be refused), a case-insensitive volume mounted
 * on Linux folds more (and a real collision would go unreported). The
 * normalisation dimension is still assumed from here, where being wrong means
 * missing a collision rather than inventing one.
 */
export function defaultFoldOptions(platform: NodeJS.Platform = process.platform): PathFoldOptions {
  if (platform === 'darwin') return { caseInsensitive: true, normalizationInsensitive: true };
  if (platform === 'win32') return { caseInsensitive: true, normalizationInsensitive: false };
  return { caseInsensitive: false, normalizationInsensitive: false };
}

/**
 * The key under which two document paths would occupy the same local file.
 *
 * NFC is the canonical direction: it is what a browser, the API, and every
 * non-Apple client produce, so folding towards it keeps the key stable across
 * the clients that share one vault.
 */
export function pathCollisionKey(docPath: string, options: PathFoldOptions): string {
  let key = docPath;
  if (options.normalizationInsensitive) key = key.normalize('NFC');
  if (options.caseInsensitive) key = key.toLowerCase();
  return key;
}

export interface PathCollision {
  /** The shared fold key. */
  key: string;
  /** The distinct document paths that fold onto it, in discovery order. */
  paths: string[];
}

/**
 * Group the given document paths by their fold key and return every group that
 * holds more than one distinct path.
 */
export function findPathCollisions(
  paths: Iterable<string>,
  options: PathFoldOptions = defaultFoldOptions(),
): PathCollision[] {
  // An identity fold can only collide with itself, so skip the whole pass.
  if (!options.caseInsensitive && !options.normalizationInsensitive) return [];

  const groups = new Map<string, string[]>();
  for (const docPath of paths) {
    const key = pathCollisionKey(docPath, options);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, [docPath]);
    } else if (!group.includes(docPath)) {
      group.push(docPath);
    }
  }

  const collisions: PathCollision[] = [];
  for (const [key, group] of groups) {
    if (group.length > 1) collisions.push({ key, paths: group });
  }
  return collisions;
}

/**
 * Refuse to plan any sync work for a path set that collides locally.
 *
 * Throwing is deliberate: there is no partial-progress answer here. Skipping the
 * colliding pair would leave whichever side pulled last on disk and re-raise the
 * conflict on the next pass, which is the loop itself.
 *
 * @throws {SyncPathError} naming the first colliding pair.
 */
export function assertNoPathCollisions(
  paths: Iterable<string>,
  options: PathFoldOptions = defaultFoldOptions(),
): void {
  const collisions = findPathCollisions(paths, options);
  if (collisions.length === 0) return;

  const first = collisions[0];
  const extra = collisions.length > 1 ? ` (and ${collisions.length - 1} more collision(s))` : '';
  throw new SyncPathError(
    `Vault contains document paths that name the same local file: ${first.paths.map(p => JSON.stringify(p)).join(' and ')}${extra}. `
    + 'This filesystem ignores letter case and/or Unicode normalisation form, so syncing them would overwrite one with the other on every pass. '
    + 'Rename one of them in the vault, then run the sync again.',
  );
}

export { SyncPathError } from './sync-errors.js';

/**
 * Swap the case of every cased character, leaving uncased ones alone.
 *
 * Used to build a name that resolves to the same directory entry if and only if
 * the filesystem folds case.
 */
export function swapCase(value: string): string {
  let out = '';
  for (const ch of value) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    out += lower === upper ? ch : (ch === lower ? upper : lower);
  }
  return out;
}

/**
 * Measure whether `rootDir`'s filesystem folds case, without writing anything.
 *
 * The sync-root marker is guaranteed to exist inside a trusted root, so there is
 * nothing to create and nothing to clean up — this is safe to run from
 * `sync status` and `--dry-run`. The marker is probed rather than the root's own
 * basename because a name is resolved by the directory that *contains* it: the
 * root's basename lives in its parent, which may be a different filesystem when
 * the root is itself a mount point, whereas the marker lives on the volume whose
 * behaviour we actually care about.
 *
 * @returns true/false when the probe is conclusive, undefined when it is not —
 *   no marker, no cased characters to swap, an unreadable path, or a platform
 *   that does not report usable inode numbers. Callers fall back to the platform
 *   default, which is exactly today's behaviour.
 */
export function probeCaseFolding(rootDir: string): boolean | undefined {
  const markerName = SYNC_ROOT_MARKER;
  const swappedName = markerName ? swapCase(markerName) : '';
  // Nothing to compare: no marker name, or one with no cased characters in it.
  if (!swappedName || swappedName === markerName) return undefined;

  let canonical: fs.Stats;
  try {
    canonical = fs.statSync(path.join(rootDir, markerName));
  } catch {
    // No marker (a legacy untrusted root) or an unreadable one. The absence of
    // the swapped name below would prove nothing, so stop here.
    return undefined;
  }

  let swapped: fs.Stats;
  try {
    swapped = fs.statSync(path.join(rootDir, swappedName));
  } catch (err) {
    // The canonical name resolved and the swapped one did not: conclusive.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return undefined;
  }

  // Windows and some network filesystems report 0 (or nothing) for `ino`, where
  // equality would be meaningless rather than informative.
  if (typeof canonical.ino !== 'number' || typeof swapped.ino !== 'number') return undefined;
  if (canonical.ino === 0 || swapped.ino === 0) return undefined;

  return canonical.ino === swapped.ino;
}

/** Probe results are stable for the life of a process; the probe is not free. */
const foldCache = new Map<string, PathFoldOptions>();

/** Drop memoised probe results. Tests only. */
export function clearPathFoldCache(): void {
  foldCache.clear();
}

/**
 * The fold to apply to one sync root: measured for case, platform-derived for
 * Unicode normalisation.
 *
 * Resolved at the impure boundary — wherever `config.localPath` is already in
 * hand — and passed to the pure collision helpers as a value, so nothing below
 * this function touches the filesystem.
 */
export function resolvePathFold(rootDir: string, platform: NodeJS.Platform = process.platform): PathFoldOptions {
  const cached = foldCache.get(rootDir);
  if (cached) return cached;

  const platformDefault = defaultFoldOptions(platform);
  const probed = probeCaseFolding(rootDir);
  const fold: PathFoldOptions = {
    caseInsensitive: probed ?? platformDefault.caseInsensitive,
    normalizationInsensitive: platformDefault.normalizationInsensitive,
  };
  foldCache.set(rootDir, fold);
  return fold;
}
