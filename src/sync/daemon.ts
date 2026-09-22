/**
 * Background daemon process management.
 * Manages starting, stopping, and checking the status of the sync daemon.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSyncConfigs } from './config.js';
import { getHttpTimeoutMs } from '../client.js';
import { SHUTDOWN_DRAIN_GRACE_MS } from './shutdown.js';

const DAEMON_DIR = path.join(os.homedir(), '.lsvault', 'daemon');
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');
const LOG_FILE = path.join(DAEMON_DIR, 'daemon.log');
const STATE_FILE = path.join(DAEMON_DIR, 'daemon-state.json');
const STARTUP_TIMEOUT_MS = 10_000;
// Watcher/poller drains allow HTTP timeout + SHUTDOWN_DRAIN_GRACE_MS. The
// controller waits another 5s so the worker can report a bounded drain
// failure and exit nonzero first.
const CONTROLLER_EXTRA_GRACE_MS = 5_000;
const SHUTDOWN_GRACE_MS = SHUTDOWN_DRAIN_GRACE_MS + CONTROLLER_EXTRA_GRACE_MS;
const PROCESS_POLL_INTERVAL_MS = 50;
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_AGE_DAYS = 7;

export interface DaemonStatus {
  running: boolean;
  /**
   * `running`: identity verified against a live process.
   * `stopped`: no daemon (missing or stale record, which is removed).
   * `unknown`: a live process matches the recorded PID but its start marker
   * could not be probed on this platform; the PID file is retained so no
   * second daemon is launched against the same roots.
   */
  state: 'running' | 'stopped' | 'unknown';
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
    fs.mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });
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
        && (identity.claimantPid as number) > 0
        && typeof identity.claimantStartId === 'string'
        && identity.claimantStartId.length > 0
        && typeof identity.createdAt === 'string'
      ) {
        return { kind: 'starting', claim: identity as DaemonStartupClaim };
      }
      if (
        identity.version === 1
        && Number.isInteger(identity.pid)
        && (identity.pid as number) > 0
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

/**
 * Result of probing a process start marker.
 *
 * `gone` is a positive signal that the process does not exist; `unknown`
 * means the probe itself failed (tool missing, timeout, permission), in
 * which case the process may well be alive and callers must not treat the
 * record as stale.
 */
type ProcessStartProbe =
  | { kind: 'ok'; startId: string }
  | { kind: 'gone' }
  | { kind: 'unknown'; reason: string };

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when a child-process failure means "no such process" rather than "could not ask". */
function childExitedNonZero(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; code?: unknown; signal?: unknown };
  // ENOENT (binary missing) and ETIMEDOUT/killed-by-timeout are probe failures.
  if (e.code === 'ENOENT' || e.code === 'ETIMEDOUT' || e.signal) return false;
  return typeof e.status === 'number' && e.status !== 0;
}

/** OS process start marker, stable for the lifetime of a process. */
function readProcessStartId(pid: number): ProcessStartProbe {
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') return { kind: 'gone' };
      return { kind: 'unknown', reason: describeError(err) };
    }
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return { kind: 'unknown', reason: 'unparseable /proc stat' };
    // After the command, index 0 is field 3 (state); starttime is field 22.
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTick = fields[19];
    return startTick ? { kind: 'ok', startId: `linux:${startTick}` } : { kind: 'unknown', reason: 'missing starttime field' };
  }
  try {
    if (process.platform === 'win32') {
      const ticks = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: 'utf-8', timeout: 1_000 }).trim();
      return ticks ? { kind: 'ok', startId: `win32:${ticks}` } : { kind: 'gone' };
    }
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 1_000,
    }).trim();
    return startedAt ? { kind: 'ok', startId: `${process.platform}:${startedAt}` } : { kind: 'gone' };
  } catch (err) {
    if (childExitedNonZero(err)) return { kind: 'gone' };
    return { kind: 'unknown', reason: describeError(err) };
  }
}

type IdentityMatch = 'match' | 'mismatch' | 'unknown';

function identityMatchesProcess(identity: DaemonProcessIdentity): IdentityMatch {
  if (!isProcessRunning(identity.pid)) return 'mismatch';
  const probe = readProcessStartId(identity.pid);
  if (probe.kind === 'unknown') return 'unknown';
  if (probe.kind === 'gone') return 'mismatch';
  return probe.startId === identity.processStartId ? 'match' : 'mismatch';
}

function claimMatchesProcess(claim: DaemonStartupClaim): IdentityMatch {
  if (!isProcessRunning(claim.claimantPid)) return 'mismatch';
  const probe = readProcessStartId(claim.claimantPid);
  if (probe.kind === 'unknown') return 'unknown';
  if (probe.kind === 'gone') return 'mismatch';
  return probe.startId === claim.claimantStartId ? 'match' : 'mismatch';
}

function createStartupClaim(nonce: string): DaemonStartupClaim {
  ensureDaemonDir();
  const probe = readProcessStartId(process.pid);
  if (probe.kind !== 'ok') {
    throw new Error(`Cannot verify daemon startup owner PID ${process.pid} on this platform.`);
  }
  const claim: DaemonStartupClaim = {
    version: 1,
    status: 'starting',
    nonce,
    claimantPid: process.pid,
    claimantStartId: probe.startId,
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
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Refusing to record invalid daemon PID ${String(pid)}.`);
  }
  ensureDaemonDir();
  const probe = readProcessStartId(pid);
  if (probe.kind !== 'ok') {
    throw new Error(`Cannot verify daemon process identity for PID ${pid} on this platform.`);
  }
  const identity: DaemonProcessIdentity = {
    version: 1,
    pid,
    nonce,
    processStartId: probe.startId,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(PID_FILE, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });
  return identity;
}

/**
 * Remove the PID file, but only when it still records the identity whose
 * nonce the caller holds. Fails closed: without a matching nonce nothing is
 * removed, so a daemon that lost track of its own identity can never delete
 * a newer daemon's ownership record.
 */
export function removePid(identityNonce: string): void {
  if (!identityNonce) return;
  if (!fs.existsSync(PID_FILE)) return;
  const stored = readStoredPid();
  if (stored.kind !== 'current' || stored.identity.nonce !== identityNonce) return;
  fs.unlinkSync(PID_FILE);
}

/** Remove a legacy (PID-only) record. Never touches a versioned identity. */
function removeLegacyPidFile(): void {
  if (!fs.existsSync(PID_FILE)) return;
  if (readStoredPid().kind !== 'legacy') return;
  fs.unlinkSync(PID_FILE);
}

export function writeDaemonState(state: DaemonStartupState): void {
  ensureDaemonDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function readDaemonState(): DaemonStartupState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as DaemonStartupState;
    if ((state.status !== 'ready' && state.status !== 'failed') || !Number.isInteger(state.pid) || state.pid <= 0) return null;
    return state;
  } catch {
    return null;
  }
}

/** Remove the startup-state file only when it carries the caller's nonce. */
export function removeDaemonState(identityNonce: string): void {
  if (!identityNonce) return;
  if (!fs.existsSync(STATE_FILE)) return;
  if (readDaemonState()?.identityNonce !== identityNonce) return;
  fs.unlinkSync(STATE_FILE);
}

/**
 * Discard whatever startup state exists. Only the controller that holds the
 * startup claim may call this, immediately before spawning a new worker.
 */
function discardDaemonState(): void {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
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
  const match: IdentityMatch = identity !== null && processExists ? identityMatchesProcess(identity) : 'mismatch';
  const running = match === 'match';
  const state: DaemonStatus['state'] = running ? 'running' : match === 'unknown' ? 'unknown' : 'stopped';

  // Dead or PID-reused records are stale. A live legacy record is retained so
  // callers can fail safely without ever signaling an unverifiable process.
  // An `unknown` probe result also retains the record: the process is alive
  // and may be ours, so its ownership file must survive.
  if (identity !== null && !processExists) {
    removePid(identity.nonce);
  } else if (stored.kind === 'legacy' && !processExists) {
    removeLegacyPidFile();
  } else if (identity !== null && processExists && match === 'mismatch') {
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
    state,
    pid: running || state === 'unknown' ? pid : null,
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
    const claimMatch = claimMatchesProcess(stored.claim);
    if (claimMatch === 'match') {
      throw new Error('Another daemon start is already in progress.');
    }
    if (claimMatch === 'unknown') {
      throw new Error(`Cannot verify whether daemon startup by PID ${stored.claim.claimantPid} is still in progress; refusing to start another daemon.`);
    }
    removeStartupClaim(stored.claim.nonce);
  }
  const status = getDaemonStatus();
  if (status.running) {
    throw new Error(`Daemon is already running (PID: ${status.pid})`);
  }
  if (status.state === 'unknown') {
    throw new Error(`A process with the recorded daemon PID ${status.pid} is alive but cannot be verified on this platform; refusing to start another daemon.`);
  }

  if (!loadSyncConfigs().some(config => config.autoSync)) {
    throw new Error('No auto-sync configurations found. Enable auto-sync on at least one sync before starting the daemon.');
  }

  ensureDaemonDir();
  const identityNonce = randomUUID();
  const startupClaim = createStartupClaim(identityNonce);
  discardDaemonState();
  const targetLog = logFile ?? LOG_FILE;
  rotateLogIfNeeded(targetLog);

  let logFd: number;
  try {
    logFd = fs.openSync(targetLog, 'a', 0o600);
  } catch (err) {
    removeStartupClaim(startupClaim.nonce);
    throw err;
  }

  // Spawn the daemon worker as a detached process. fileURLToPath handles
  // percent-encoded characters and Windows drive letters that a raw
  // URL.pathname would mangle.
  const workerPath = fileURLToPath(new URL('./daemon-worker.js', import.meta.url));
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
  if (ready?.status !== 'ready' || ready.pid !== child.pid || ready.identityNonce !== identity.nonce || identityMatchesProcess(identity) !== 'match') {
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
  if (status.state === 'unknown' && status.pid !== process.pid) {
    throw new Error(`A process with the recorded daemon PID ${status.pid} is alive but cannot be verified on this platform; refusing to run another daemon.`);
  }
  if (!loadSyncConfigs().some(config => config.autoSync)) {
    throw new Error('No auto-sync configurations found. Enable auto-sync on at least one sync before running the daemon.');
  }
  ensureDaemonDir();
  const startupClaim = createStartupClaim(randomUUID());
  discardDaemonState();
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
    const claimMatch = claimMatchesProcess(stored.claim);
    if (claimMatch === 'mismatch') {
      removeStartupClaim(stored.claim.nonce);
      return false;
    }
    if (claimMatch === 'unknown') {
      throw new Error(`Cannot verify whether daemon startup by PID ${stored.claim.claimantPid} is still in progress; refusing to signal it.`);
    }
    throw new Error('Daemon startup is still in progress; refusing to signal its controller process.');
  }
  const pid = stored.kind === 'current' ? stored.identity.pid : stored.pid;
  if (!isProcessRunning(pid)) {
    if (stored.kind === 'current') removePid(stored.identity.nonce);
    else removeLegacyPidFile();
    return false;
  }
  if (stored.kind === 'legacy') {
    throw new Error(`Cannot verify ownership of legacy daemon PID ${pid}; refusing to signal it.`);
  }
  const match = identityMatchesProcess(stored.identity);
  if (match === 'unknown') {
    throw new Error(`Daemon PID ${pid} is alive but its identity cannot be verified on this platform; refusing to signal it.`);
  }
  if (match === 'mismatch') {
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
