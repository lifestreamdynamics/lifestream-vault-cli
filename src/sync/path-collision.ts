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
 * are two files and folding them would refuse a perfectly valid vault. The fold
 * is therefore derived from the platform, and callers may override it.
 */
import { SyncPathError } from './sync-errors.js';

export interface PathFoldOptions {
  /** Treat paths differing only by case as the same file (macOS, Windows). */
  caseInsensitive?: boolean;
  /** Treat paths differing only by Unicode normalisation form as the same file (APFS/HFS+). */
  normalizationInsensitive?: boolean;
}

/**
 * How the local filesystem is assumed to fold path names.
 *
 * Derived from `process.platform`, which is a proxy: a case-sensitive volume on
 * macOS folds less than this assumes, and a case-insensitive volume mounted on
 * Linux folds more. Erring towards "folds" only ever costs an explicit refusal
 * the operator can resolve by renaming; erring the other way costs the loop
 * this module exists to stop.
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
