/**
 * Background daemon process management.
 * Manages starting, stopping, and checking the status of the sync daemon.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { loadSyncConfigs } from './config.js';
import { getHttpTimeoutMs } from '../client.js';

const DAEMON_DIR = path.join(os.homedir(), '.lsvault', 'daemon');
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');
const LOG_FILE = path.join(DAEMON_DIR, 'daemon.log');
const STATE_FILE = path.join(DAEMON_DIR, 'daemon-state.json');
const STARTUP_TIMEOUT_MS = 10_000;
// Watcher/poller drains allow HTTP timeout + 5s. The controller waits another
// 5s so the worker can report a bounded drain failure and exit nonzero first.
const SHUTDOWN_GRACE_MS = 10_000;
const PROCESS_POLL_INTERVAL_MS = 50;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_AGE_DAYS = 7;

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  logFile: string;
  uptime: number | null;
  startedAt: string | null;
}

export type DaemonStartupState =
  | { status: 'ready'; pid: number; identityNonce?: string; timestamp: string; startedSyncs: number; skippedSyncs: number }
  | { status: 'failed'; pid: number; identityNonce?: string; timestamp: string; error: string };

export interface DaemonProcessIdentity {
  version: 1;
  pid: number;
  nonce: string;
  /** OS process start tick, which changes when a PID is reused. */
  processStartId: string;
  createdAt: string;
}

interface DaemonStartupClaim {
  version: 1;
  status: 'starting';
  nonce: string;
  claimantPid: number;
  claimantStartId: string;
  createdAt: string;
}

type StoredPid =
  | { kind: 'current'; identity: DaemonProcessIdentity }
  | { kind: 'starting'; claim: DaemonStartupClaim }
  | { kind: 'legacy'; pid: number }
  | { kind: 'invalid' }
  | { kind: 'missing' };

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
function readStoredPid(): StoredPid {
  if (!fs.existsSync(PID_FILE)) return { kind: 'missing' };
  try {
    const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
    if (content.startsWith('{')) {
      const identity = JSON.parse(content) as Partial<DaemonProcessIdentity & DaemonStartupClaim>;
      if (
        identity.version === 1
        && identity.status === 'starting'
        && typeof identity.nonce === 'string'
        && identity.nonce.length >= 16
        && Number.isInteger(identity.claimantPid)
        && typeof identity.claimantStartId === 'string'
        && identity.claimantStartId.length > 0
        && typeof identity.createdAt === 'string'
      ) {
        return { kind: 'starting', claim: identity as DaemonStartupClaim };
      }
      if (
        identity.version === 1
        && Number.isInteger(identity.pid)
        && typeof identity.nonce === 'string'
        && identity.nonce.length >= 16
        && typeof identity.processStartId === 'string'
        && identity.processStartId.length > 0
        && typeof identity.createdAt === 'string'
      ) {
        return { kind: 'current', identity: identity as DaemonProcessIdentity };
      }
      return { kind: 'invalid' };
    }
    if (!/^\d+$/.test(content)) return { kind: 'invalid' };
    const pid = Number(content);
    return Number.isSafeInteger(pid) && pid > 0 ? { kind: 'legacy', pid } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Read the numeric PID from either current or legacy storage. */
export function readPid(): number | null {
  const stored = readStoredPid();
  if (stored.kind === 'current') return stored.identity.pid;
  if (stored.kind === 'legacy') return stored.pid;
  return null;
}

/** OS process start marker, stable for the lifetime of a process. */
function readProcessStartId(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return null;
      // After the command, index 0 is field 3 (state); starttime is field 22.
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTick = fields[19];
      return startTick ? `linux:${startTick}` : null;
    }
    if (process.platform === 'win32') {
      const ticks = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: 'utf-8', timeout: 1_000 }).trim();
      return ticks ? `win32:${ticks}` : null;
    }
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 1_000,
    }).trim();
    return startedAt ? `${process.platform}:${startedAt}` : null;
  } catch {
    return null;
  }
}

function identityMatchesProcess(identity: DaemonProcessIdentity): boolean {
  if (!isProcessRunning(identity.pid)) return false;
  const currentStartId = readProcessStartId(identity.pid);
  return currentStartId !== null && currentStartId === identity.processStartId;
}

function claimMatchesProcess(claim: DaemonStartupClaim): boolean {
  if (!isProcessRunning(claim.claimantPid)) return false;
  return readProcessStartId(claim.claimantPid) === claim.claimantStartId;
}

function createStartupClaim(nonce: string): DaemonStartupClaim {
  ensureDaemonDir();
  const claimantStartId = readProcessStartId(process.pid);
  if (!claimantStartId) {
    throw new Error(`Cannot verify daemon startup owner PID ${process.pid} on this platform.`);
  }
  const claim: DaemonStartupClaim = {
    version: 1,
    status: 'starting',
    nonce,
    claimantPid: process.pid,
    claimantStartId,
    createdAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify(claim, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
    if (code === 'EEXIST') throw new Error('Another daemon start is already in progress.');
    throw err;
  }
  return claim;
}

function removeStartupClaim(nonce: string): void {
  const stored = readStoredPid();
  if (stored.kind === 'starting' && stored.claim.nonce === nonce) fs.unlinkSync(PID_FILE);
}

function finalizeStartupClaim(claim: DaemonStartupClaim, pid: number): DaemonProcessIdentity {
  const stored = readStoredPid();
  if (stored.kind !== 'starting' || stored.claim.nonce !== claim.nonce) {
    throw new Error('Daemon startup ownership was lost before the worker identity could be persisted.');
  }
  return writePid(pid, claim.nonce);
}

/**
 * Write the daemon PID to the PID file.
 */
export function writePid(pid: number, nonce: string = randomUUID()): DaemonProcessIdentity {
  ensureDaemonDir();
  const processStartId = readProcessStartId(pid);
  if (!processStartId) {
    throw new Error(`Cannot verify daemon process identity for PID ${pid} on this platform.`);
  }
  const identity: DaemonProcessIdentity = {
    version: 1,
    pid,
    nonce,
    processStartId,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(PID_FILE, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  return identity;
}

/**
 * Remove the PID file.
 */
export function removePid(identityNonce?: string): void {
  if (fs.existsSync(PID_FILE)) {
    if (identityNonce) {
      const stored = readStoredPid();
      if (stored.kind !== 'current' || stored.identity.nonce !== identityNonce) return;
    }
    fs.unlinkSync(PID_FILE);
  }
}

export function writeDaemonState(state: DaemonStartupState): void {
  ensureDaemonDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function readDaemonState(): DaemonStartupState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as DaemonStartupState;
    if ((state.status !== 'ready' && state.status !== 'failed') || !Number.isInteger(state.pid)) return null;
    return state;
  } catch {
    return null;
  }
}

export function removeDaemonState(identityNonce?: string): void {
  if (!fs.existsSync(STATE_FILE)) return;
  if (identityNonce && readDaemonState()?.identityNonce !== identityNonce) return;
  fs.unlinkSync(STATE_FILE);
}

function removeDaemonFilesForIdentity(identity: DaemonProcessIdentity): void {
  // A separately invoked `start` may win the small gap between process exit
  // and this caller's cleanup. Never remove its PID/state files.
  const stored = readStoredPid();
  if (stored.kind === 'current' && stored.identity.nonce === identity.nonce) removePid(identity.nonce);
  const state = readDaemonState();
  if (state?.pid === identity.pid && state.identityNonce === identity.nonce) removeDaemonState(identity.nonce);
}

async function waitForProcessExit(pid: number, timeoutMs = getHttpTimeoutMs() + SHUTDOWN_GRACE_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, PROCESS_POLL_INTERVAL_MS));
  }
  return !isProcessRunning(pid);
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
  const stored = readStoredPid();
  const identity = stored.kind === 'current' ? stored.identity : null;
  const pid = identity?.pid ?? (stored.kind === 'legacy' ? stored.pid : null);
  const processExists = pid !== null && isProcessRunning(pid);
  const running = identity !== null && processExists && identityMatchesProcess(identity);

  // Dead or PID-reused records are stale. A live legacy record is retained so
  // callers can fail safely without ever signaling an unverifiable process.
  if (identity !== null && !processExists) {
    removePid(identity.nonce);
  } else if (stored.kind === 'legacy' && !processExists) {
    removePid();
  } else if (identity !== null && processExists && !running) {
    removePid(identity.nonce);
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
export async function startDaemon(logFile?: string): Promise<{ pid: number; lingerWarning?: string }> {
  const stored = readStoredPid();
  if (stored.kind === 'invalid') {
    throw new Error('Daemon identity file is invalid; refusing to start another daemon until it is inspected.');
  }
  if (stored.kind === 'legacy' && isProcessRunning(stored.pid)) {
    throw new Error(`Cannot verify ownership of legacy daemon PID ${stored.pid}; refusing to start another daemon.`);
  }
  if (stored.kind === 'starting') {
    if (claimMatchesProcess(stored.claim)) {
      throw new Error('Another daemon start is already in progress.');
    }
    removeStartupClaim(stored.claim.nonce);
  }
  const status = getDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon is already running (PID: ${status.pid})`);
  }

  if (!loadSyncConfigs().some(config => config.autoSync)) {
    throw new Error('No auto-sync configurations found. Enable auto-sync on at least one sync before starting the daemon.');
  }

  ensureDaemonDir();
  const identityNonce = randomUUID();
  const startupClaim = createStartupClaim(identityNonce);
  removeDaemonState();
  const targetLog = logFile ?? LOG_FILE;
  rotateLogIfNeeded(targetLog);

  let logFd: number;
  try {
    logFd = fs.openSync(targetLog, 'a');
  } catch (err) {
    removeStartupClaim(startupClaim.nonce);
    throw err;
  }

  // Spawn the daemon worker as a detached process
  // Use URL constructor for Node 20.0-20.10 compatibility (import.meta.dirname was added in 20.11).
  const workerPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'daemon-worker.js');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, LSVAULT_DAEMON: '1', LSVAULT_DAEMON_IDENTITY: identityNonce },
    });
  } catch (err) {
    fs.closeSync(logFd);
    removeStartupClaim(startupClaim.nonce);
    throw err;
  }

  if (!child.pid) {
    fs.closeSync(logFd);
    removeStartupClaim(startupClaim.nonce);
    throw new Error('Failed to spawn daemon process');
  }

  let identity: DaemonProcessIdentity;
  try {
    identity = finalizeStartupClaim(startupClaim, child.pid);
  } catch (err) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* spawned child already stopped */ }
    fs.closeSync(logFd);
    removeStartupClaim(startupClaim.nonce);
    throw err;
  }
  child.unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readDaemonState();
    if (state?.pid === child.pid && state.identityNonce === identity.nonce) {
      if (state.status === 'failed') {
        removePid(identity.nonce);
        throw new Error(`Daemon failed during startup: ${state.error}`);
      }
      if (state.status === 'ready' && isProcessRunning(child.pid)) break;
    }
    if (!isProcessRunning(child.pid)) {
      removePid(identity.nonce);
      throw new Error(`Daemon exited before becoming ready. Check ${targetLog}.`);
    }
    await new Promise(resolve => setTimeout(resolve, PROCESS_POLL_INTERVAL_MS));
  }

  const ready = readDaemonState();
  if (ready?.status !== 'ready' || ready.pid !== child.pid || ready.identityNonce !== identity.nonce || !identityMatchesProcess(identity)) {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already stopped */ }
    removePid(identity.nonce);
    throw new Error(`Timed out waiting for daemon readiness after ${STARTUP_TIMEOUT_MS / 1000}s. Check ${targetLog}.`);
  }

  const result: { pid: number; lingerWarning?: string } = { pid: child.pid };
  const lingerStatus = checkLingerStatus();
  if (lingerStatus === 'disabled') {
    result.lingerWarning = 'systemd lingering is not enabled for your user. The daemon will stop when you log out. To fix:\n  sudo loginctl enable-linger $(whoami)';
  }
  return result;
}

/** Run the daemon worker in this process for an external service supervisor. */
export async function runDaemonForeground(): Promise<void> {
  const status = getDaemonStatus();
  if (status.running && status.pid !== process.pid) {
    throw new Error(`Daemon is already running (PID: ${status.pid})`);
  }
  if (!loadSyncConfigs().some(config => config.autoSync)) {
    throw new Error('No auto-sync configurations found. Enable auto-sync on at least one sync before running the daemon.');
  }
  ensureDaemonDir();
  const startupClaim = createStartupClaim(randomUUID());
  removeDaemonState();
  let identity: DaemonProcessIdentity;
  try {
    identity = finalizeStartupClaim(startupClaim, process.pid);
  } catch (err) {
    removeStartupClaim(startupClaim.nonce);
    throw err;
  }
  try {
    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ identityNonce: identity.nonce });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeDaemonState({ status: 'failed', pid: process.pid, identityNonce: identity.nonce, timestamp: new Date().toISOString(), error: message });
    removePid(identity.nonce);
    throw err;
  }
}

/**
 * Stop the running daemon.
 */
export async function stopDaemon(): Promise<boolean> {
  const stored = readStoredPid();
  if (stored.kind === 'missing') return false;
  if (stored.kind === 'invalid') {
    throw new Error('Daemon identity file is invalid; refusing to signal any process.');
  }
  if (stored.kind === 'starting') {
    if (!claimMatchesProcess(stored.claim)) {
      removeStartupClaim(stored.claim.nonce);
      return false;
    }
    throw new Error('Daemon startup is still in progress; refusing to signal its controller process.');
  }
  const pid = stored.kind === 'current' ? stored.identity.pid : stored.pid;
  if (!isProcessRunning(pid)) {
    if (stored.kind === 'current') removePid(stored.identity.nonce);
    else removePid();
    return false;
  }
  if (stored.kind === 'legacy') {
    throw new Error(`Cannot verify ownership of legacy daemon PID ${pid}; refusing to signal it.`);
  }
  if (!identityMatchesProcess(stored.identity)) {
    removePid(stored.identity.nonce);
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    // Leave the PID/state files intact: the process may still be alive and a
    // subsequent start must not overlap it.
    throw new Error(`Unable to stop daemon PID ${pid}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (await waitForProcessExit(pid)) {
    removeDaemonFilesForIdentity(stored.identity);
    return true;
  }

  // The process remains live, so retain both files. `startDaemon()` will see
  // the live PID and refuse to launch a second daemon against the same roots.
  const timeoutMs = getHttpTimeoutMs() + SHUTDOWN_GRACE_MS;
  throw new Error(`Daemon PID ${pid} did not exit within ${timeoutMs / 1000}s and may still be stopping.`);
}

/**
 * Check if systemd linger is enabled for the current user (Linux only).
 * When linger is disabled, user services stop when the SSH session ends.
 */
export function checkLingerStatus(): 'enabled' | 'disabled' | 'unknown' {
  if (process.platform !== 'linux') return 'unknown';
  try {
    const username = os.userInfo().username;
    const lingerFile = `/var/lib/systemd/linger/${username}`;
    return fs.existsSync(lingerFile) ? 'enabled' : 'disabled';
  } catch {
    return 'unknown';
  }
}

export { DAEMON_DIR, PID_FILE, LOG_FILE, STATE_FILE };
