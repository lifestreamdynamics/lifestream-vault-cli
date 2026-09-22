/**
 * Atomic file-write helpers shared by the sync engine and remote poller.
 *
 * All writes use a temp-file + rename strategy so interrupted writes never
 * leave a partial file at the target path.  On any error the temp file is
 * cleaned up before the error is re-thrown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { shouldIgnore } from './ignore.js';

/** Temp-file suffix produced by {@link atomicWriteFileSync}: `.tmp.<8 hex>`. */
const TEMP_SUFFIX_RE = /\.tmp\.[0-9a-f]{8}$/;

/**
 * Files this sweep is allowed to delete.
 *
 * Deliberately anchored to `.md` — the only extension sync ever writes. The
 * previous `\.tmp(\.[0-9a-f]{8})?$` matched any `*.tmp` file, so a user's
 * `budget.xlsx.tmp` sitting beside `budget.xlsx`, or a `build.tmp` beside a
 * `build/` directory, was deleted on every `sync pull` — content that existed
 * nowhere else.
 */
const ORPHAN_TEMP_RE = /\.md\.tmp\.[0-9a-f]{8}$/;

/**
 * A temp file younger than this may still be the target of an in-flight write
 * by a concurrent process (a second CLI invocation, the daemon), whose rename
 * has not happened yet.
 */
export const TEMP_FILE_MIN_AGE_MS = 60_000;

/**
 * A temp file older than this is swept even with no canonical sibling — it is
 * the residue of an interrupted *create*, where the sibling never existed.
 */
export const TEMP_FILE_ORPHAN_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Ignore patterns that exist precisely to keep sync's *own* temp files out of
 * the synced set (see `DEFAULT_IGNORE_PATTERNS`). Honouring them in the sweep
 * would make it a no-op, so they are dropped from the consulted list; every
 * other pattern, including anything the user added, is honoured.
 */
const SELF_REFERENTIAL_IGNORE_PATTERNS = new Set(['*.tmp', '*.tmp.*']);

export interface AtomicWriteOptions {
  /**
   * Permission bits for the written file. When omitted the existing target's
   * mode is preserved; when the target does not exist the process umask applies.
   */
  mode?: number;
}

/**
 * Write `content` to `targetPath` atomically and durably.
 *
 * A uniquely named temp file is created alongside the target, written, fsynced,
 * then renamed over the target (atomic on POSIX).  The containing directory is
 * fsynced afterwards so the rename itself survives a crash — without it, a
 * power loss can leave the directory entry pointing at neither version.  If any
 * step throws, the temp file is best-effort deleted before the original error
 * is re-thrown, guaranteeing no orphaned `.tmp.<hash>` files are left behind.
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8',
  options: AtomicWriteOptions = {},
): void {
  const tmpFile = targetPath + '.tmp.' + randomBytes(4).toString('hex');

  // Preserve the target's permissions. writeFileSync's `mode` only applies at
  // creation, and the temp file is always a fresh create — so without this a
  // file the user chmod'd 0600 came back world-readable after the first sync
  // write.
  let mode = options.mode;
  if (mode === undefined) {
    try {
      const existing = fs.statSync(targetPath).mode;
      if (typeof existing === 'number') mode = existing & 0o777;
    } catch {
      // No existing target — the umask governs the new file's mode.
    }
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpFile, 'wx', mode ?? 0o666);
    fs.writeSync(fd, content, 0, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // openSync's mode argument is masked by the umask; an explicit chmod is the
    // only way to reproduce a mode the umask would strip (e.g. 0664).
    if (mode !== undefined) fs.chmodSync(tmpFile, mode);
    fs.renameSync(tmpFile, targetPath);
    fsyncDirectory(path.dirname(targetPath));
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore — the fd may already be closed if closeSync was what threw.
      }
    }
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore — the file may not exist if openSync was what threw.
    }
    throw err;
  }
}

/**
 * Flush a directory entry so a completed rename survives a crash.
 *
 * Best-effort by design: opening a directory for fsync is not supported on
 * Windows, and a durability optimisation must never fail a write that already
 * landed.
 */
function fsyncDirectory(dir: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(dir, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // Unsupported or unreadable — the data write above is already durable.
  } finally {
    if (dirFd !== null) {
      try {
        fs.closeSync(dirFd);
      } catch {
        // Ignore.
      }
    }
  }
}

export interface SweepOptions {
  /**
   * Ignore patterns from the sync configuration. A temp file matching one of
   * them is left alone — the user told sync to stay away from that path.
   */
  ignorePatterns?: string[];
  /** Override the "may still be in flight" window. */
  minAgeMs?: number;
  /** Override the age past which a sibling-less temp file is swept. */
  orphanAgeMs?: number;
}

/**
 * Recursively walk `rootDir` and delete orphaned temp files.
 *
 * A file is swept only when it carries the `.md.tmp.<8 hex>` suffix this module
 * produces, is at least `minAgeMs` old, is not covered by the sync ignore
 * patterns, and either
 *   - has a canonical counterpart that is an existing *regular file* (an
 *     interrupted overwrite: the content survives at the canonical path), or
 *   - is older than `orphanAgeMs` (an interrupted create, whose canonical
 *     counterpart was never made).
 *
 * The `isFile` requirement matters: `existsSync` alone is satisfied by a
 * *directory* of the same name, so `build.tmp.deadbeef` beside a `build/`
 * directory used to be treated as disposable.
 *
 * Dirs named `node_modules` or starting with `.` (hidden dirs, including
 * `.lsvault`) are skipped, matching the sync engine's own exclusions.
 *
 * Any individual fs error (unreadable dir, permission denied, etc.) is caught
 * and skipped so a single bad entry cannot abort the sweep.
 *
 * @returns the number of orphaned temp files deleted.
 */
export function sweepOrphanedTempFiles(rootDir: string, options: SweepOptions = {}): number {
  const patterns = (options.ignorePatterns ?? []).filter(p => !SELF_REFERENTIAL_IGNORE_PATTERNS.has(p));
  const minAgeMs = options.minAgeMs ?? TEMP_FILE_MIN_AGE_MS;
  const orphanAgeMs = options.orphanAgeMs ?? TEMP_FILE_ORPHAN_AGE_MS;
  const now = Date.now();
  let removed = 0;

  function relativeDocPath(fullPath: string): string {
    return path.relative(rootDir, fullPath).split(path.sep).join('/');
  }

  function isSweepable(fullPath: string): boolean {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return false;

    const ageMs = now - stat.mtimeMs;
    if (!(ageMs >= minAgeMs)) return false;

    if (ageMs >= orphanAgeMs) return true;

    // Younger than the orphan cutoff: only disposable when the content it was
    // going to become already exists as a real file.
    const canonical = fullPath.replace(TEMP_SUFFIX_RE, '');
    try {
      return fs.statSync(canonical).isFile();
    } catch {
      return false;
    }
  }

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          // Skip hidden dirs, node_modules, .lsvault
          if (
            entry.name.startsWith('.') ||
            entry.name === 'node_modules'
          ) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile() && ORPHAN_TEMP_RE.test(entry.name)) {
          if (patterns.length > 0 && shouldIgnore(relativeDocPath(fullPath), patterns)) continue;
          if (!isSweepable(fullPath)) continue;
          try {
            fs.unlinkSync(fullPath);
            removed++;
          } catch {
            // Ignore individual unlink failures.
          }
        }
      } catch {
        // Ignore stat/access errors for individual entries.
      }
    }
  }

  walk(rootDir);
  return removed;
}
