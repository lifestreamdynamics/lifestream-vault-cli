import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { formatUptime } from '../utils/format.js';
import {
  loadSyncConfigs,
  createSyncConfig,
  deleteSyncConfig,
  getSyncConfig,
} from '../sync/config.js';
import { deleteSyncState, loadSyncState, saveSyncState, hashFileContent, buildRemoteFileState } from '../sync/state.js';
import { resolveIgnorePatterns } from '../sync/ignore.js';
import {
  scanLocalFiles,
  scanRemoteFiles,
  executePull,
  executePush,
  computePullDiff,
  computePushDiff,
} from '../sync/engine.js';
import { formatDiff } from '../sync/diff.js';
import { createWatcher } from '../sync/watcher.js';
import { createRemotePoller } from '../sync/remote-poller.js';
import { startDaemon, stopDaemon, getDaemonStatus } from '../sync/daemon.js';
import type { SyncMode, ConflictStrategy } from '../sync/types.js';

export function registerSyncCommands(program: Command): void {
  const sync = program.command('sync').description('Configure and manage vault sync');

  // sync init <vaultId> <localPath>
  addGlobalFlags(sync.command('init')
    .description('Initialize sync for a vault to a local directory')
    .argument('<vaultId>', 'Vault ID to sync')
    .argument('<localPath>', 'Local directory path')
    .option('--mode <mode>', 'Sync mode: pull, push, sync (default: sync)')
    .option('--on-conflict <strategy>', 'Conflict strategy: newer, local, remote, ask (default: newer)')
    .option('--ignore <patterns...>', 'Glob patterns to ignore')
    .option('--interval <interval>', 'Auto-sync interval (e.g., 5m, 1h)')
    .option('--auto-sync', 'Enable auto-sync'))
    .action(async (vaultId: string, localPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Initializing sync...');
      try {
        const client = await getClientAsync();
        const vault = await client.vaults.get(vaultId);
        const absPath = path.resolve(localPath);

        const mode = (_opts.mode as SyncMode | undefined) ?? 'sync';
        const onConflict = (_opts.onConflict as ConflictStrategy | undefined) ?? 'newer';
        const ignore = _opts.ignore as string[] | undefined;
        const syncInterval = _opts.interval as string | undefined;
        const autoSync = _opts.autoSync === true;

        const config = createSyncConfig({
          vaultId,
          localPath: absPath,
          mode,
          onConflict,
          ignore,
          syncInterval,
          autoSync,
        });

        out.success(`Sync initialized for vault "${vault.name}"`, {
          id: config.id,
          vaultId: config.vaultId,
          localPath: config.localPath,
          mode: config.mode,
          onConflict: config.onConflict,
          autoSync: config.autoSync,
        });

        if (flags.output === 'text' && !flags.quiet) {
          out.status('');
          out.status(`Run ${chalk.cyan(`lsvault sync pull ${config.id}`)} or ${chalk.cyan(`lsvault sync push ${config.id}`)} to perform the first sync.`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to initialize sync');
      }
    });

  // sync list
  addGlobalFlags(sync.command('list')
    .description('List all sync configurations'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const configs = loadSyncConfigs();
        out.list(
          configs.map(c => ({
            id: c.id,
            vaultId: c.vaultId,
            localPath: c.localPath,
            mode: c.mode,
            autoSync: c.autoSync,
            lastSyncAt: c.lastSyncAt,
          })),
          {
            emptyMessage: 'No sync configurations found. Run `lsvault sync init` to create one.',
            columns: [
              { key: 'id', header: 'ID', width: 36 },
              { key: 'vaultId', header: 'Vault' },
              { key: 'localPath', header: 'Local Path' },
              { key: 'mode', header: 'Mode' },
              { key: 'autoSync', header: 'Auto' },
            ],
            textFn: (c) => {
              const lines = [chalk.cyan(`  ${String(c.id)}`)];
              lines.push(`  Vault:     ${String(c.vaultId)}`);
              lines.push(`  Path:      ${String(c.localPath)}`);
              lines.push(`  Mode:      ${String(c.mode)}`);
              lines.push(`  Auto-sync: ${c.autoSync ? chalk.green('enabled') : chalk.dim('disabled')}`);
              if (c.lastSyncAt && c.lastSyncAt !== '1970-01-01T00:00:00.000Z') {
                lines.push(`  Last sync: ${new Date(String(c.lastSyncAt)).toLocaleString()}`);
              } else {
                lines.push(`  Last sync: ${chalk.dim('never')}`);
              }
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to list sync configs');
      }
    });

  // sync delete <syncId>
  addGlobalFlags(sync.command('delete')
    .description('Delete a sync configuration')
    .argument('<syncId>', 'Sync configuration ID'))
    .action(async (syncId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Deleting sync configuration...');
      try {
        const deleted = deleteSyncConfig(syncId);
        if (!deleted) {
          out.failSpinner('Sync configuration not found');
          process.exitCode = 1;
          return;
        }
        deleteSyncState(syncId);
        out.success('Sync configuration deleted', { id: syncId, deleted: true });
      } catch (err) {
        handleError(out, err, 'Failed to delete sync configuration');
      }
    });

  // sync pull <syncId>
  addGlobalFlags(sync.command('pull')
    .description('Pull remote changes to local directory')
    .argument('<syncId>', 'Sync configuration ID'))
    .action(async (syncId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const config = getSyncConfig(syncId);
        if (!config) {
          out.error(`Sync configuration not found: ${syncId}`);
          process.exitCode = 1;
          return;
        }

        const client = await getClientAsync();
        const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
        const lastState = loadSyncState(config.id);

        out.startSpinner('Scanning local files...');
        const localFiles = scanLocalFiles(config.localPath, ignorePatterns);
        out.debug(`Found ${Object.keys(localFiles).length} local files`);

        out.startSpinner('Scanning remote files...');
        const remoteFiles = await scanRemoteFiles(client, config.vaultId, ignorePatterns);
        out.debug(`Found ${Object.keys(remoteFiles).length} remote files`);

        out.startSpinner('Computing diff...');
        const diff = computePullDiff(localFiles, remoteFiles, lastState);

        const totalOps = diff.downloads.length + diff.deletes.length;
        if (totalOps === 0) {
          out.succeedSpinner('Everything is up to date');
          if (flags.output === 'json') {
            out.record({ status: 'up-to-date', changes: 0 });
          }
          return;
        }

        out.stopSpinner();

        if (flags.dryRun) {
          out.status(chalk.yellow('Dry run — no changes will be made:'));
          out.status(formatDiff(diff));
          if (flags.output === 'json') {
            out.record({
              dryRun: true,
              downloads: diff.downloads.length,
              deletes: diff.deletes.length,
              totalBytes: diff.totalBytes,
            });
          }
          return;
        }

        if (flags.verbose) {
          out.status(formatDiff(diff));
        }

        out.startSpinner(`Pulling ${totalOps} file(s)...`);
        const result = await executePull(client, config, diff, (progress) => {
          if (progress.phase === 'transferring' && progress.currentFile) {
            out.startSpinner(`[${progress.current}/${progress.total}] ${progress.currentFile}`);
          }
        });

        if (result.errors.length > 0) {
          out.failSpinner(`Pull completed with ${result.errors.length} error(s)`);
          for (const err of result.errors) {
            out.error(`  ${err.path}: ${err.error}`);
          }
        } else {
          out.succeedSpinner('Pull complete');
        }

        out.success('', {
          downloaded: result.filesDownloaded,
          deleted: result.filesDeleted,
          bytesTransferred: result.bytesTransferred,
          errors: result.errors.length,
        });
      } catch (err) {
        handleError(out, err, 'Pull failed');
      }
    });

  // sync push <syncId>
  addGlobalFlags(sync.command('push')
    .description('Push local changes to remote vault')
    .argument('<syncId>', 'Sync configuration ID'))
    .action(async (syncId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const config = getSyncConfig(syncId);
        if (!config) {
          out.error(`Sync configuration not found: ${syncId}`);
          process.exitCode = 1;
          return;
        }

        const client = await getClientAsync();
        const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
        const lastState = loadSyncState(config.id);

        out.startSpinner('Scanning local files...');
        const localFiles = scanLocalFiles(config.localPath, ignorePatterns);
        out.debug(`Found ${Object.keys(localFiles).length} local files`);

        out.startSpinner('Scanning remote files...');
        const remoteFiles = await scanRemoteFiles(client, config.vaultId, ignorePatterns);
        out.debug(`Found ${Object.keys(remoteFiles).length} remote files`);

        out.startSpinner('Computing diff...');
        const diff = computePushDiff(localFiles, remoteFiles, lastState);

        const totalOps = diff.uploads.length + diff.deletes.length;
        if (totalOps === 0) {
          out.succeedSpinner('Everything is up to date');
          if (flags.output === 'json') {
            out.record({ status: 'up-to-date', changes: 0 });
          }
          return;
        }

        out.stopSpinner();

        if (flags.dryRun) {
          out.status(chalk.yellow('Dry run — no changes will be made:'));
          out.status(formatDiff(diff));
          if (flags.output === 'json') {
            out.record({
              dryRun: true,
              uploads: diff.uploads.length,
              deletes: diff.deletes.length,
              totalBytes: diff.totalBytes,
            });
          }
          return;
        }

        if (flags.verbose) {
          out.status(formatDiff(diff));
        }

        out.startSpinner(`Pushing ${totalOps} file(s)...`);
        const result = await executePush(client, config, diff, (progress) => {
          if (progress.phase === 'transferring' && progress.currentFile) {
            out.startSpinner(`[${progress.current}/${progress.total}] ${progress.currentFile}`);
          }
        });

        if (result.errors.length > 0) {
          out.failSpinner(`Push completed with ${result.errors.length} error(s)`);
          for (const err of result.errors) {
            out.error(`  ${err.path}: ${err.error}`);
          }
        } else {
          out.succeedSpinner('Push complete');
        }

        out.success('', {
          uploaded: result.filesUploaded,
          deleted: result.filesDeleted,
          bytesTransferred: result.bytesTransferred,
          errors: result.errors.length,
        });
      } catch (err) {
        handleError(out, err, 'Push failed');
      }
    });

  // sync status <syncId>
  addGlobalFlags(sync.command('status')
    .description('Show sync status and pending changes')
    .argument('<syncId>', 'Sync configuration ID'))
    .action(async (syncId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const config = getSyncConfig(syncId);
        if (!config) {
          out.error(`Sync configuration not found: ${syncId}`);
          process.exitCode = 1;
          return;
        }

        const client = await getClientAsync();
        const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
        const lastState = loadSyncState(config.id);

        out.startSpinner('Scanning...');
        const localFiles = scanLocalFiles(config.localPath, ignorePatterns);
        const remoteFiles = await scanRemoteFiles(client, config.vaultId, ignorePatterns);

        const pullDiff = computePullDiff(localFiles, remoteFiles, lastState);
        const pushDiff = computePushDiff(localFiles, remoteFiles, lastState);

        out.stopSpinner();

        const pullOps = pullDiff.downloads.length + pullDiff.deletes.length;
        const pushOps = pushDiff.uploads.length + pushDiff.deletes.length;

        if (flags.output === 'json') {
          out.record({
            syncId: config.id,
            vaultId: config.vaultId,
            localPath: config.localPath,
            mode: config.mode,
            localFiles: Object.keys(localFiles).length,
            remoteFiles: Object.keys(remoteFiles).length,
            pendingPull: pullOps,
            pendingPush: pushOps,
            lastSyncAt: config.lastSyncAt,
          });
          return;
        }

        out.status(`Sync: ${chalk.cyan(config.id)}`);
        out.status(`Vault: ${config.vaultId}`);
        out.status(`Path:  ${config.localPath}`);
        out.status(`Mode:  ${config.mode}`);
        out.status('');
        out.status(`Local files:  ${Object.keys(localFiles).length}`);
        out.status(`Remote files: ${Object.keys(remoteFiles).length}`);
        out.status('');

        if (pullOps > 0) {
          out.status(chalk.yellow(`${pullOps} pending pull operation(s):`));
          out.status(formatDiff(pullDiff));
        } else {
          out.status(chalk.green('Pull: up to date'));
        }

        out.status('');

        if (pushOps > 0) {
          out.status(chalk.yellow(`${pushOps} pending push operation(s):`));
          out.status(formatDiff(pushDiff));
        } else {
          out.status(chalk.green('Push: up to date'));
        }

        if (config.lastSyncAt !== '1970-01-01T00:00:00.000Z') {
          out.status('');
          out.status(`Last sync: ${new Date(config.lastSyncAt).toLocaleString()}`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to get sync status');
      }
    });

  // sync watch <syncId>
  addGlobalFlags(sync.command('watch')
    .description('Watch for changes and sync continuously')
    .argument('<syncId>', 'Sync configuration ID')
    .option('--poll-interval <ms>', 'Remote poll interval in milliseconds', '30000'))
    .action(async (syncId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const config = getSyncConfig(syncId);
        if (!config) {
          out.error(`Sync configuration not found: ${syncId}`);
          process.exitCode = 1;
          return;
        }

        if (config.mode === 'pull') {
          out.error('Watch mode is not supported for pull-only configurations. Use "sync" or "push" mode.');
          process.exitCode = 1;
          return;
        }

        const client = await getClientAsync();
        const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
        const pollInterval = parseInt(String(_opts.pollInterval ?? '30000'), 10);

        out.status(`Watching sync ${chalk.cyan(syncId.slice(0, 8))}...`);
        out.status(`  Vault:     ${config.vaultId}`);
        out.status(`  Path:      ${config.localPath}`);
        out.status(`  Mode:      ${config.mode}`);
        out.status(`  Conflict:  ${config.onConflict}`);
        out.status(`  Poll:      ${pollInterval / 1000}s`);
        out.status('');
        out.status('Press Ctrl+C to stop.');
        out.status('');

        const logHandler = (msg: string) => out.debug(msg);
        const conflictHandler = (msg: string) => out.warn(msg);
        const errorHandler = (err: Error) => out.error(err.message);

        // Start local watcher
        const { stop: stopWatcher } = createWatcher(client, config, {
          ignorePatterns,
          onLog: logHandler,
          onConflictLog: conflictHandler,
          onError: errorHandler,
        });

        // Start remote poller (only for sync and pull modes)
        let stopPoller: (() => void) | undefined;
        if (config.mode === 'sync') {
          const poller = createRemotePoller(client, config, {
            ignorePatterns,
            intervalMs: pollInterval,
            onLog: logHandler,
            onConflictLog: conflictHandler,
            onError: errorHandler,
          });
          stopPoller = poller.stop;
        }

        // Handle graceful shutdown
        const shutdown = async () => {
          out.status('\nStopping...');
          stopPoller?.();
          await stopWatcher();
          out.status('Sync watch stopped.');
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Keep process alive
        await new Promise(() => {}); // Never resolves — relies on signal handlers
      } catch (err) {
        handleError(out, err, 'Watch failed');
      }
    });

  // sync resolve <syncId> <path> --use <local|remote>
  addGlobalFlags(sync.command('resolve')
    .description('Manually resolve a sync conflict')
    .argument('<syncId>', 'Sync configuration ID')
    .argument('<docPath>', 'Document path to resolve')
    .requiredOption('--use <version>', 'Which version to keep: local or remote'))
    .action(async (syncId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Resolving conflict...');
      try {
        const config = getSyncConfig(syncId);
        if (!config) {
          out.failSpinner('Sync configuration not found');
          process.exitCode = 1;
          return;
        }

        const useVersion = String(_opts.use);
        if (useVersion !== 'local' && useVersion !== 'remote') {
          out.failSpinner('--use must be "local" or "remote"');
          process.exitCode = 1;
          return;
        }

        const client = await getClientAsync();
        const localFile = path.join(config.localPath, docPath);
        const state = loadSyncState(config.id);

        if (useVersion === 'local') {
          if (!fs.existsSync(localFile)) {
            out.failSpinner(`Local file not found: ${localFile}`);
            process.exitCode = 1;
            return;
          }
          const content = fs.readFileSync(localFile, 'utf-8');
          await client.documents.put(config.vaultId, docPath, content);

          state.local[docPath] = {
            path: docPath,
            hash: hashFileContent(content),
            mtime: new Date().toISOString(),
            size: Buffer.byteLength(content),
          };
          state.remote[docPath] = buildRemoteFileState(docPath, content, new Date().toISOString());
        } else {
          const { content } = await client.documents.get(config.vaultId, docPath);
          const dir = path.dirname(localFile);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(localFile, content, 'utf-8');

          state.local[docPath] = {
            path: docPath,
            hash: hashFileContent(content),
            mtime: new Date().toISOString(),
            size: Buffer.byteLength(content),
          };
          state.remote[docPath] = buildRemoteFileState(docPath, content, new Date().toISOString());
        }

        saveSyncState(state);
        out.success(`Conflict resolved: ${docPath} — using ${useVersion}`, {
          docPath,
          resolved: useVersion,
        });
      } catch (err) {
        handleError(out, err, 'Failed to resolve conflict');
      }
    });

  // sync daemon <start|stop|status>
  const daemon = sync.command('daemon').description('Manage the background sync daemon');

  addGlobalFlags(daemon.command('start')
    .description('Start the background sync daemon')
    .option('--log-file <path>', 'Custom log file path'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const logFile = _opts.logFile as string | undefined;
        const { pid, lingerWarning } = startDaemon(logFile);
        out.success('Daemon started', { pid, status: 'running' });
        if (lingerWarning) {
          out.warn(`Warning: ${lingerWarning}`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to start daemon');
      }
    });

  addGlobalFlags(daemon.command('stop')
    .description('Stop the background sync daemon'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const stopped = stopDaemon();
        if (stopped) {
          out.success('Daemon stopped', { status: 'stopped' });
        } else {
          out.status('Daemon is not running.');
        }
      } catch (err) {
        handleError(out, err, 'Failed to stop daemon');
      }
    });

  addGlobalFlags(daemon.command('status')
    .description('Show daemon status'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const status = getDaemonStatus();

        if (flags.output === 'json') {
          out.record({
            running: status.running,
            pid: status.pid,
            logFile: status.logFile,
            uptime: status.uptime,
            startedAt: status.startedAt,
          });
          return;
        }

        if (status.running) {
          out.status(chalk.green('Daemon is running'));
          out.status(`  PID:        ${status.pid}`);
          out.status(`  Log file:   ${status.logFile}`);
          if (status.uptime !== null) {
            out.status(`  Uptime:     ${formatUptime(status.uptime)}`);
          }
          if (status.startedAt) {
            out.status(`  Started at: ${new Date(status.startedAt).toLocaleString()}`);
          }
        } else {
          out.status(chalk.dim('Daemon is not running'));
        }
      } catch (err) {
        handleError(out, err, 'Failed to get daemon status');
      }
    });
}
