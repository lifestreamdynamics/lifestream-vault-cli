/**
 * Background daemon process management.
 * Manages starting, stopping, and checking the status of the sync daemon.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DAEMON_DIR = path.join(os.homedir(), '.lsvault', 'daemon');
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');
const LOG_FILE = path.join(DAEMON_DIR, 'daemon.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_AGE_DAYS = 7;

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  logFile: string;
  uptime: number | null;
  startedAt: string | null;
}

/**
 * Ensure the daemon directory exists.
 */
function ensureDaemonDir(): void {
  if (!fs.existsSync(DAEMON_DIR)) {
    fs.mkdirSync(DAEMON_DIR, { recursive: true });
  }
}

/**
 * Read the daemon PID from the PID file.
 */
export function readPid(): number | null {
  if (!fs.existsSync(PID_FILE)) return null;
  try {
    const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Write the daemon PID to the PID file.
 */
export function writePid(pid: number): void {
  ensureDaemonDir();
  fs.writeFileSync(PID_FILE, String(pid) + '\n');
}

/**
 * Remove the PID file.
 */
export function removePid(): void {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }
}

/**
 * Check if a process with the given PID is running.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 doesn't kill, just checks
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current daemon status.
 */
export function getDaemonStatus(): DaemonStatus {
  const pid = readPid();
  const running = pid !== null && isProcessRunning(pid);

  // Clean up stale PID file
  if (pid !== null && !running) {
    removePid();
  }

  let startedAt: string | null = null;
  let uptime: number | null = null;

  if (running && pid !== null) {
    try {
      const pidStat = fs.statSync(PID_FILE);
      startedAt = pidStat.birthtime.toISOString();
      uptime = Math.floor((Date.now() - pidStat.birthtimeMs) / 1000);
    } catch {
      // Ignore stat errors
    }
  }

  return {
    running,
    pid: running ? pid : null,
    logFile: LOG_FILE,
    uptime,
    startedAt,
  };
}

/**
 * Rotate log files if they exceed the max size.
 */
export function rotateLogIfNeeded(logFile?: string): void {
  const targetLog = logFile ?? LOG_FILE;
  if (!fs.existsSync(targetLog)) return;

  try {
    const stat = fs.statSync(targetLog);
    if (stat.size > MAX_LOG_SIZE) {
      const rotated = `${targetLog}.${Date.now()}.old`;
      fs.renameSync(targetLog, rotated);
    }

    // Clean up old rotated logs
    const dir = path.dirname(targetLog);
    const baseName = path.basename(targetLog);
    const entries = fs.readdirSync(dir);
    const maxAge = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (entry.startsWith(baseName + '.') && entry.endsWith('.old')) {
        const entryPath = path.join(dir, entry);
        const entryStat = fs.statSync(entryPath);
        if (Date.now() - entryStat.mtimeMs > maxAge) {
          fs.unlinkSync(entryPath);
        }
      }
    }
  } catch {
    // Ignore rotation errors
  }
}

/**
 * Start the daemon as a detached child process.
 * Returns the PID of the spawned process.
 */
export function startDaemon(logFile?: string): number {
  const status = getDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon is already running (PID: ${status.pid})`);
  }

  ensureDaemonDir();
  const targetLog = logFile ?? LOG_FILE;
  rotateLogIfNeeded(targetLog);

  const logFd = fs.openSync(targetLog, 'a');

  // Spawn the daemon worker as a detached process
  const workerPath = path.join(import.meta.dirname, 'daemon-worker.js');
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, LSVAULT_DAEMON: '1' },
  });

  if (!child.pid) {
    fs.closeSync(logFd);
    throw new Error('Failed to spawn daemon process');
  }

  writePid(child.pid);
  child.unref();
  fs.closeSync(logFd);

  return child.pid;
}

/**
 * Stop the running daemon.
 */
export function stopDaemon(): boolean {
  const pid = readPid();
  if (pid === null || !isProcessRunning(pid)) {
    removePid();
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
    removePid();
    return true;
  } catch {
    removePid();
    return false;
  }
}

export { DAEMON_DIR, PID_FILE, LOG_FILE };
