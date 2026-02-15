/**
 * Daemon worker process.
 * Runs as a detached background process, managing watchers for all autoSync syncs.
 * Designed to be spawned by daemon.ts startDaemon().
 */
import { loadSyncConfigs } from './config.js';
import { resolveIgnorePatterns } from './ignore.js';
import { createWatcher } from './watcher.js';
import { createRemotePoller } from './remote-poller.js';
import { removePid } from './daemon.js';
import { loadConfig } from '../config.js';
import { LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import type { FSWatcher } from 'chokidar';
import { scanLocalFiles, scanRemoteFiles, computePushDiff, computePullDiff, executePush, executePull } from './engine.js';
import { loadSyncState } from './state.js';

interface ManagedSync {
  syncId: string;
  watcher: FSWatcher;
  stopWatcher: () => Promise<void>;
  stopPoller?: () => void;
}

const managed: ManagedSync[] = [];

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function createClient(): LifestreamVaultClient {
  const config = loadConfig();
  if (!config.apiKey) {
    throw new Error('No API key configured. Run `lsvault auth login` first.');
  }
  return new LifestreamVaultClient({
    baseUrl: config.apiUrl,
    apiKey: config.apiKey,
  });
}

async function start(): Promise<void> {
  log('Daemon starting...');

  const configs = loadSyncConfigs().filter(c => c.autoSync);
  if (configs.length === 0) {
    log('No auto-sync configurations found. Daemon has nothing to do.');
    removePid();
    process.exit(0);
  }

  log(`Found ${configs.length} auto-sync configuration(s)`);

  const client = createClient();

  // Startup reconciliation: catch changes made while daemon was stopped
  for (const config of configs) {
    try {
      log(`Reconciling ${config.id.slice(0, 8)} (${config.mode} mode)...`);
      const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
      const lastState = loadSyncState(config.id);
      const localFiles = scanLocalFiles(config.localPath, ignorePatterns);
      const remoteFiles = await scanRemoteFiles(client, config.vaultId, ignorePatterns);

      let pushed = 0;
      let pulled = 0;
      let deleted = 0;

      if (config.mode === 'push' || config.mode === 'sync') {
        const pushDiff = computePushDiff(localFiles, remoteFiles, lastState);
        const pushOps = pushDiff.uploads.length + pushDiff.deletes.length;
        if (pushOps > 0) {
          const result = await executePush(client, config, pushDiff);
          pushed = result.filesUploaded;
          deleted += result.filesDeleted;
          if (result.errors.length > 0) {
            for (const err of result.errors) {
              log(`  Push error: ${err.path}: ${err.error}`);
            }
          }
        }
      }

      if (config.mode === 'pull' || config.mode === 'sync') {
        const pullDiff = computePullDiff(localFiles, remoteFiles, lastState);
        const pullOps = pullDiff.downloads.length + pullDiff.deletes.length;
        if (pullOps > 0) {
          const result = await executePull(client, config, pullDiff);
          pulled = result.filesDownloaded;
          deleted += result.filesDeleted;
          if (result.errors.length > 0) {
            for (const err of result.errors) {
              log(`  Pull error: ${err.path}: ${err.error}`);
            }
          }
        }
      }

      const total = pushed + pulled + deleted;
      if (total > 0) {
        const parts: string[] = [];
        if (pushed > 0) parts.push(`${pushed} uploaded`);
        if (pulled > 0) parts.push(`${pulled} downloaded`);
        if (deleted > 0) parts.push(`${deleted} deleted`);
        log(`Reconciled ${config.id.slice(0, 8)}: ${parts.join(', ')}`);
      } else {
        log(`Reconciled ${config.id.slice(0, 8)}: up to date`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Reconciliation failed for ${config.id.slice(0, 8)}: ${msg}`);
      // Continue — still start the watcher even if reconciliation fails
    }
  }

  for (const config of configs) {
    try {
      const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);

      const { watcher, stop: stopWatcher } = createWatcher(client, config, {
        ignorePatterns,
        onLog: (msg) => log(msg),
        onConflictLog: (msg) => log(`CONFLICT: ${msg}`),
        onError: (err) => log(`ERROR [${config.id.slice(0, 8)}]: ${err.message}`),
      });

      let stopPoller: (() => void) | undefined;
      if (config.mode === 'sync') {
        const pollIntervalMs = parseSyncInterval(config.syncInterval) || 30000;
        const poller = createRemotePoller(client, config, {
          ignorePatterns,
          intervalMs: pollIntervalMs,
          onLog: (msg) => log(msg),
          onConflictLog: (msg) => log(`CONFLICT: ${msg}`),
          onError: (err) => log(`ERROR [${config.id.slice(0, 8)}]: ${err.message}`),
        });
        stopPoller = poller.stop;
      }

      managed.push({ syncId: config.id, watcher, stopWatcher, stopPoller });
      log(`Started sync: ${config.id.slice(0, 8)} (${config.localPath})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Failed to start sync ${config.id.slice(0, 8)}: ${msg}`);
    }
  }

  if (managed.length === 0) {
    log('No syncs could be started. Exiting.');
    removePid();
    process.exit(1);
  }

  log(`Daemon running with ${managed.length} sync(s)`);
}

async function shutdown(): Promise<void> {
  log('Daemon shutting down...');

  for (const sync of managed) {
    try {
      sync.stopPoller?.();
      await sync.stopWatcher();
      log(`Stopped sync: ${sync.syncId.slice(0, 8)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Error stopping sync ${sync.syncId.slice(0, 8)}: ${msg}`);
    }
  }

  removePid();
  log('Daemon stopped.');
  process.exit(0);
}

/**
 * Parse a human-readable sync interval string to milliseconds.
 * Supports: "30s", "5m", "1h", or plain number (ms).
 */
function parseSyncInterval(interval?: string): number | null {
  if (!interval) return null;
  const match = interval.match(/^(\d+)(s|m|h)?$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return value;
  }
}

// Signal handlers
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Uncaught error recovery
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT ERROR: ${err.message}`);
  log(err.stack ?? '');
  // Try to recover — don't exit
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log(`UNHANDLED REJECTION: ${msg}`);
  // Try to recover — don't exit
});

// Start
start().catch((err) => {
  log(`FATAL: ${err.message}`);
  removePid();
  process.exit(1);
});
