import path from 'node:path';
import fs from 'node:fs';
import { SYNC_ROOT_MARKER } from './root-marker.js';

/** Resolve a canonical remote document path without permitting root escape. */
export function resolveWithinSyncRoot(localPath: string, docPath: string): string {
  if (!docPath || docPath.includes('\0') || docPath.includes('\\')) {
    throw new Error(`Unsafe sync document path: ${JSON.stringify(docPath)}`);
  }
  if (path.posix.isAbsolute(docPath) || path.win32.isAbsolute(docPath)) {
    throw new Error(`Unsafe absolute sync document path: ${docPath}`);
  }
  const segments = docPath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe sync document path traversal: ${docPath}`);
  }
  if (segments.includes(SYNC_ROOT_MARKER)) {
    throw new Error(`Sync document path targets reserved root marker: ${docPath}`);
  }

  const root = path.resolve(localPath);
  const resolved = path.resolve(root, ...segments);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Sync document path escapes root: ${docPath}`);
  }

  // Lexical containment is insufficient: an existing directory or target
  // symlink can redirect a later write/unlink outside the trusted root. Walk
  // every currently existing component without following it and reject links.
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Sync document path contains a symbolic link: ${docPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return resolved;
}
