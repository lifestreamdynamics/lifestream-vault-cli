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

/**
 * Write `content` to `targetPath` atomically.
 *
 * A uniquely named temp file is created alongside the target.  On success it
 * is renamed to the target (atomic on POSIX).  If the write or rename throws,
 * the temp file is best-effort deleted before the original error is re-thrown,
 * guaranteeing no orphaned `.tmp.<hash>` files are left behind.
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8',
  options: { mode?: number } = {},
): void {
  const tmpFile = targetPath + '.tmp.' + randomBytes(4).toString('hex');
  try {
    if (options.mode !== undefined) {
      fs.writeFileSync(tmpFile, content, { encoding, mode: options.mode });
    } else {
      fs.writeFileSync(tmpFile, content, encoding);
    }
    fs.renameSync(tmpFile, targetPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore — the file may not exist if writeFileSync was what threw.
    }
    throw err;
  }
}

/**
 * Regex that matches both forms of orphaned temp-file suffix:
 *   - `.tmp`           (static suffix used by the legacy inline write in remote-poller)
 *   - `.tmp.<8hex>`    (randomised suffix used by atomicWriteFileSync)
 */
const ORPHAN_TEMP_RE = /\.tmp(\.[0-9a-f]{8})?$/;

/**
 * Recursively walk `rootDir` and delete orphaned temp files.
 *
 * A temp file is considered orphaned when its canonical counterpart — the
 * path with the `.tmp[.<hash>]` suffix stripped — already exists on disk.
 * This guard ensures only leftover cruft is removed, never unique content.
 *
 * Dirs named `.git`, `node_modules`, or starting with `.` (hidden dirs) and
 * the `.lsvault` dir are skipped, matching the sync engine's own exclusions.
 *
 * Any individual fs error (unreadable dir, permission denied, etc.) is caught
 * and skipped so a single bad entry cannot abort the sweep.
 *
 * @returns the number of orphaned temp files deleted.
 */
export function sweepOrphanedTempFiles(rootDir: string): number {
  let removed = 0;

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
          // Derive the canonical sibling path by stripping the temp suffix.
          const canonical = fullPath.replace(ORPHAN_TEMP_RE, '');
          if (fs.existsSync(canonical)) {
            try {
              fs.unlinkSync(fullPath);
              removed++;
            } catch {
              // Ignore individual unlink failures.
            }
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
