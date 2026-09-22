import path from 'node:path';
import fs from 'node:fs';
import { SYNC_ROOT_MARKER } from './root-marker.js';
import { SyncPathError } from './sync-errors.js';

/**
 * Canonical form used to compare a path segment against the reserved marker.
 * Case-insensitive filesystems (macOS, Windows) and Windows' trailing-dot/space
 * stripping would otherwise let `.LSVAULT-SYNC-ROOT` or `.lsvault-sync-root.`
 * alias the marker file.
 */
function canonicalSegment(segment: string): string {
  return segment.normalize('NFC').toLowerCase().replace(/[. ]+$/u, '');
}

const CANONICAL_MARKER = canonicalSegment(SYNC_ROOT_MARKER);

/** Resolve a canonical remote document path without permitting root escape. */
export function resolveWithinSyncRoot(localPath: string, docPath: string): string {
  if (!docPath || docPath.includes('\0') || docPath.includes('\\')) {
    throw new SyncPathError(`Unsafe sync document path: ${JSON.stringify(docPath)}`);
  }
  if (path.posix.isAbsolute(docPath) || path.win32.isAbsolute(docPath)) {
    throw new SyncPathError(`Unsafe absolute sync document path: ${docPath}`);
  }
  const segments = docPath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new SyncPathError(`Unsafe sync document path traversal: ${docPath}`);
  }
  if (segments.some(segment => canonicalSegment(segment) === CANONICAL_MARKER)) {
    throw new SyncPathError(`Sync document path targets reserved root marker: ${docPath}`);
  }

  const root = path.resolve(localPath);
  const resolved = path.resolve(root, ...segments);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new SyncPathError(`Sync document path escapes root: ${docPath}`);
  }

  // Lexical containment is insufficient: an existing directory or target
  // symlink can redirect a later write/unlink outside the trusted root. Walk
  // every currently existing component without following it and reject links.
  //
  // Residual TOCTOU: a symlink swapped in between this check and the caller's
  // write/unlink is not detected. Closing that window needs O_NOFOLLOW-style
  // open-by-handle semantics that Node's sync fs API does not expose; the
  // check still blocks every pre-existing link, which is the realistic threat
  // for a directory the user's own tools populate.
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let isLink: boolean;
    try {
      isLink = fs.lstatSync(current).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (isLink) {
      throw new SyncPathError(`Sync document path contains a symbolic link: ${docPath}`);
    }
  }
  return resolved;
}

export { SyncPathError } from './sync-errors.js';
