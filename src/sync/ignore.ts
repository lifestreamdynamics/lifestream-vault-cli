/**
 * Ignore pattern matching for sync operations.
 * Supports .lsvault-ignore files and built-in default patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';

/** Default patterns that are always ignored. */
export const DEFAULT_IGNORE_PATTERNS = [
  '.git/',
  '.svn/',
  '.hg/',
  'node_modules/',
  '*.tmp',
  '.DS_Store',
  'Thumbs.db',
  '.lsvault/',
  '.lsvault-*',
];

/**
 * Load ignore patterns from a .lsvault-ignore file.
 * Returns empty array if file doesn't exist.
 */
export function loadIgnoreFile(localPath: string): string[] {
  const ignoreFile = path.join(localPath, '.lsvault-ignore');
  if (!fs.existsSync(ignoreFile)) return [];
  try {
    const content = fs.readFileSync(ignoreFile, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Combine default patterns, config-level patterns, and .lsvault-ignore patterns.
 */
export function resolveIgnorePatterns(
  configIgnore: string[],
  localPath: string,
): string[] {
  const filePatterns = loadIgnoreFile(localPath);
  // Deduplicate
  const all = new Set([...DEFAULT_IGNORE_PATTERNS, ...configIgnore, ...filePatterns]);
  return [...all];
}

/**
 * Check if a document path should be ignored.
 * The docPath should be a relative path using forward slashes.
 */
export function shouldIgnore(docPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Directory patterns (ending with /)
    if (pattern.endsWith('/')) {
      const dirPattern = pattern.slice(0, -1);
      if (docPath.startsWith(dirPattern + '/') || docPath === dirPattern) {
        return true;
      }
    }
    // Glob patterns
    if (minimatch(docPath, pattern, { dot: true })) {
      return true;
    }
    // Also check basename for file-level patterns (e.g., ".DS_Store" matches "sub/.DS_Store")
    const basename = path.posix.basename(docPath);
    if (minimatch(basename, pattern, { dot: true })) {
      return true;
    }
  }
  return false;
}
