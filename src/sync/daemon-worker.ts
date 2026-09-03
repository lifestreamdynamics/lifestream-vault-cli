/** Daemon worker with per-root fail-closed startup and readiness reporting. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSyncConfigs } from './config.js';
import { resolveIgnorePatterns } from './ignore.js';
import { createWatcher, type SyncOperationSerializer } from './watcher.js';
import { createRemotePoller } from './remote-poller.js';
import { removeDaemonState, removePid, writeDaemonState } from './daemon.js';
import { getClientAsync } from '../client.js';
import type { FSWatcher } from 'chokidar';
import { scanLocalFiles, scanRemoteFiles, computePushDiff, computePullDiff, executePush, executePull, sweepOrphanedTempFiles } from './engine.js';
import { loadSyncState, saveSyncState } from './state.js';
import { assertSyncRoot } from './root-marker.js';
import type { SyncConfig } from './types.js';

interface ManagedSync {
  syncId: string;
  watcher: FSWatcher;
  stopWatcher: () => Promise<void>;
  stopPoller?: () => Promise<void>;
}

const managed: ManagedSync[] = [];
let signalHandlersInstalled = false;
let shutdownPromise: Promise<void> | null = null;
let daemonIdentityNonce: string | undefined;
let fatalShutdownStarted = false;

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function reconcile(client: Awaited<ReturnType<typeof getClientAsync>>, config: SyncConfig): Promise<void> {
  assertSyncRoot(config);
  log(`Reconciling ${config.id.slice(0, 8)} (${config.mode} mode)...`);
  const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
  const lastState = loadSyncState(config.id);
  const localFiles = scanLocalFiles(config.localPath, ignorePatterns, lastState);
  assertSyncRoot(config);
  const remoteResult = await scanRemoteFiles(client, config.vaultId, ignorePatterns, {
    remote: lastState.remote ?? {}, remoteListEtag: lastState.remoteListEtag,
  });
  const remoteFiles = remoteResult.files;
  if (remoteResult.listEtag) {
    lastState.remoteListEtag = remoteResult.listEtag;
    saveSyncState(lastState);
  }

  let pushed = 0;
  let pulled = 0;
  let deleted = 0;
  let pushFailed = false;
  let pushChangedRemote = false;
  if (config.mode === 'push' || config.mode === 'sync') {
    const diff = computePushDiff(localFiles, remoteFiles, lastState);
    if (diff.uploads.length + diff.deletes.length > 0) {
      const result = await executePush(client, config, diff);
      pushed = result.filesUploaded;
      deleted += result.filesDeleted;
      for (const err of result.errors) log(`  Push error: ${err.path}: ${err.error}`);
      // Only a retryable failure (network, exhausted rate limit, skipped
      // work) blocks the pull phase: the next reconciliation will retry it and
      // a stale pull plan could otherwise delete the only surviving copy. A
      // permanent rejection (403 on an admin-only delete, a 4xx) would recur
      // forever and must not freeze pulls for the whole root.
      pushFailed = result.errors.some(err => err.retryable);
      pushChangedRemote = result.filesUploaded + result.filesDeleted > 0;
    }
  }
  if (config.mode === 'pull' || config.mode === 'sync') {
    // Both diffs were derived from the same pre-push snapshot. If any push
    // failed, that snapshot is no longer safe for pull deletes: a remotely
    // deleted file may still be the only surviving local copy. Leave all pull
    // work for the next reconciliation, which will recompute from current
    // state after the failed path can be retried.
    if (pushFailed) {
      log('  Skipping pull after failed push; preserving local files until the next reconciliation.');
    } else {
      // A successful push also invalidates the pre-push remote snapshot. Scan
      // again before planning pull work so a restored remote file is not
      // immediately treated as deleted locally by a stale pull diff.
      const pullState = pushChangedRemote ? loadSyncState(config.id) : lastState;
      const pullLocalFiles = pushChangedRemote
        ? scanLocalFiles(config.localPath, ignorePatterns, pullState)
        : localFiles;
      const pullRemoteFiles = pushChangedRemote
        ? (await scanRemoteFiles(client, config.vaultId, ignorePatterns, {
            remote: pullState.remote ?? {},
            remoteListEtag: pullState.remoteListEtag,
          })).files
        : remoteFiles;
      const diff = computePullDiff(pullLocalFiles, pullRemoteFiles, pullState);
      if (diff.downloads.length + diff.deletes.length > 0) {
        const result = await executePull(client, config, diff);
        pulled = result.filesDownloaded;
        deleted += result.filesDeleted;
        for (const err of result.errors) log(`  Pull error: ${err.path}: ${err.error}`);
      }
    }
  }
  const parts: string[] = [];
  if (pushed) parts.push(`${pushed} uploaded`);
  if (pulled) parts.push(`${pulled} downloaded`);
  if (deleted) parts.push(`${deleted} deleted`);
  log(`Reconciled ${config.id.slice(0, 8)}: ${parts.length ? parts.join(', ') : 'up to date'}`);
}

/**
 * Start every valid auto-sync. Resolves once readiness has been reported.
 *
 * Ordering matters for supervisors: signal handlers go in first so a stop
 * request during a slow start is honoured; every watcher must be listening
 * before `ready` is written; the initial reconciliation runs *after* that,
 * through each root's serializer, so a large first sync cannot make a
 * systemd/launchd readiness watchdog time out and kill a healthy worker.
 */
export async function runDaemonWorker(options: { installSignalHandlers?: boolean; identityNonce?: string } = {}): Promise<void> {
  daemonIdentityNonce = options.identityNonce ?? process.env.LSVAULT_DAEMON_IDENTITY;
  log('Daemon starting...');
  if (options.installSignalHandlers !== false) installSignalHandlers();
  const configs = loadSyncConfigs().filter(c => c.autoSync);
  if (configs.length === 0) throw new Error('No auto-sync configurations found. Daemon has nothing to do.');
  log(`Found ${configs.length} auto-sync configuration(s)`);

  const validConfigs: SyncConfig[] = [];
  for (const config of configs) {
    try {
      assertSyncRoot(config);
      validConfigs.push(config);
    } catch (err) {
      log(`Skipping sync ${config.id.slice(0, 8)}: ${describe(err)}`);
    }
  }
  if (validConfigs.length === 0) throw new Error('No auto-sync configurations have a valid, trusted sync root.');

  for (const config of validConfigs) {
    try {
      assertSyncRoot(config);
      const swept = sweepOrphanedTempFiles(config.localPath);
      if (swept > 0) log(`Swept ${swept} orphaned temp file(s) from ${config.localPath}`);
    } catch (err) {
      // The root is re-asserted before every later mutation, so this only
      // needs to be visible, not fatal.
      log(`Temp-file sweep skipped for ${config.id.slice(0, 8)}: ${describe(err)}`);
    }
  }

  const client = await getClientAsync();
  const serializers = new Map<string, SyncOperationSerializer>();

  for (const config of validConfigs) {
    let created: ReturnType<typeof createWatcher> | undefined;
    try {
      assertSyncRoot(config);
      const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
      created = createWatcher(client, config, {
        ignorePatterns,
        onLog: log,
        onConflictLog: msg => log(`CONFLICT: ${msg}`),
        onError: err => log(`ERROR [${config.id.slice(0, 8)}]: ${err.message}`),
      });
      const { watcher, ready, markLocalWrite, serialize, stop: stopWatcher } = created;
      // Do not report daemon readiness until the local watcher is actually
      // listening. A pre-ready Chokidar error is treated as a failed sync and
      // is skipped without masking healthy configurations.
      await ready;
      let stopPoller: (() => Promise<void>) | undefined;
      if (config.mode === 'sync' || config.mode === 'pull') {
        const poller = createRemotePoller(client, config, {
          ignorePatterns,
          intervalMs: parseSyncInterval(config.syncInterval) ?? undefined,
          onLog: log,
          onConflictLog: msg => log(`CONFLICT: ${msg}`),
          onError: err => log(`ERROR [${config.id.slice(0, 8)}]: ${err.message}`),
          onLocalWrite: markLocalWrite,
          serialize,
        });
        stopPoller = poller.stop;
      }
      managed.push({ syncId: config.id, watcher, stopWatcher, stopPoller });
      serializers.set(config.id, serialize);
      log(`Started sync: ${config.id.slice(0, 8)} (${config.localPath})`);
    } catch (err) {
      // Anything that fails after the watcher was constructed must release
      // its OS handles, or the failed root keeps a live watcher forever.
      if (created) await created.stop().catch(stopErr => log(`Watcher cleanup failed for ${config.id.slice(0, 8)}: ${describe(stopErr)}`));
      log(`Failed to start sync ${config.id.slice(0, 8)}: ${describe(err)}`);
    }
  }

  if (managed.length === 0) throw new Error('No syncs could be started.');
  writeDaemonState({
    status: 'ready', pid: process.pid, identityNonce: daemonIdentityNonce, timestamp: new Date().toISOString(),
    startedSyncs: managed.length, skippedSyncs: configs.length - managed.length,
  });
  log(`Daemon running with ${managed.length} sync(s)`);

  // Initial reconciliation, after readiness. Each root's serializer orders it
  // ahead of any poller/watcher work that has already queued up behind it.
  for (const config of validConfigs) {
    const serialize = serializers.get(config.id);
    if (!serialize) continue;
    try {
      await serialize(() => reconcile(client, config));
    } catch (err) {
      log(`Reconciliation failed for ${config.id.slice(0, 8)}: ${describe(err)}`);
    }
  }
}

async function performShutdown(): Promise<void> {
  log('Daemon shutting down...');
  const syncs = managed.splice(0);
  const failures: string[] = [];
  await Promise.all(syncs.map(async sync => {
    const results = await Promise.allSettled([
      sync.stopPoller?.() ?? Promise.resolve(),
      sync.stopWatcher(),
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => describe(result.reason));
    if (errors.length === 0) {
      log(`Stopped sync: ${sync.syncId.slice(0, 8)}`);
    } else {
      const message = errors.join('; ');
      failures.push(`${sync.syncId.slice(0, 8)}: ${message}`);
      log(`Error stopping sync ${sync.syncId.slice(0, 8)}: ${message}`);
    }
  }));
  if (failures.length > 0) {
    throw new Error(`Daemon shutdown did not drain cleanly: ${failures.join('; ')}`);
  }
  if (daemonIdentityNonce) {
    removePid(daemonIdentityNonce);
    removeDaemonState(daemonIdentityNonce);
  } else {
    log('No daemon identity nonce; leaving PID/state files for the controller to reconcile.');
  }
  log('Daemon stopped.');
}

/** Drain each managed sync once; repeated signals share the same shutdown. */
export function shutdownDaemonWorker(): Promise<void> {
  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const stop = () => {
    shutdownDaemonWorker().then(
      () => process.exit(fatalShutdownStarted ? 1 : 0),
      err => {
        log(`FATAL: ${describe(err)}`);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('uncaughtException', err => handleFatalRuntimeError('UNCAUGHT ERROR', err));
  process.on('unhandledRejection', reason => handleFatalRuntimeError('UNHANDLED REJECTION', reason));
}

/** Best-effort bounded drain for fatal runtime errors; always exits nonzero. */
export function handleFatalRuntimeError(kind: string, reason: unknown): void {
  log(`${kind}: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  if (fatalShutdownStarted) return;
  fatalShutdownStarted = true;
  void shutdownDaemonWorker().then(
    () => process.exit(1),
    err => {
      log(`FATAL SHUTDOWN ERROR: ${describe(err)}`);
      process.exit(1);
    },
  );
}

/** Parse `30s` / `5m` / `1h` (bare digits are milliseconds); null when absent or malformed. */
function parseSyncInterval(interval?: string): number | null {
  if (!interval) return null;
  const match = interval.match(/^(\d+)(s|m|h)?$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1_000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: return value;
  }
}

const isDirectWorker = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isDirectWorker) {
  runDaemonWorker().catch(err => {
    const message = describe(err);
    log(`FATAL: ${message}`);
    const identityNonce = process.env.LSVAULT_DAEMON_IDENTITY;
    writeDaemonState({ status: 'failed', pid: process.pid, identityNonce, timestamp: new Date().toISOString(), error: message });
    if (identityNonce) removePid(identityNonce);
    process.exit(1);
  });
}
