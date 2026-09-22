import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { confirmAction } from '../utils/confirm.js';
import { formatUptime } from '../utils/format.js';
import {
  loadSyncConfigs,
  createSyncConfig,
  deleteSyncConfig,
  getSyncConfig,
  trustSyncRoot,
} from '../sync/config.js';
import { deleteSyncState, loadSyncState, saveSyncState, hashFileContent, buildRemoteFileState, pruneDeniedDeletes } from '../sync/state.js';
import { resolveIgnorePatterns } from '../sync/ignore.js';
import {
  scanLocalFiles,
  scanRemoteFiles,
  executePull,
  executePush,
  computePullDiff,
  computePushDiff,
  resolveConcurrency,
  sweepOrphanedTempFiles,
  type ScanRemoteResult,
} from '../sync/engine.js';
import { formatDiff } from '../sync/diff.js';
import {
  clearDeletionAnomaly,
  massDeleteOverrideHint,
  recordDeletionAnomaly,
} from '../sync/mass-delete-guard.js';
import type { DeletionAnomaly, DeletionTarget, SyncState } from '../sync/types.js';
import { createConflictFile } from '../sync/conflict.js';
import { atomicWriteFileSync } from '../sync/atomic-write.js';
import { createWatcher } from '../sync/watcher.js';
import { createRemotePoller } from '../sync/remote-poller.js';
import { runDaemonForeground, startDaemon, stopDaemon, getDaemonStatus } from '../sync/daemon.js';
import { assertSyncRoot, prepareSyncRoot } from '../sync/root-marker.js';
import { isSyncMode, isConflictStrategy, SYNC_MODES, CONFLICT_STRATEGIES } from '../sync/types.js';
import { resolveWithinSyncRoot } from '../sync/safe-path.js';
import { resolvePathFold } from '../sync/path-collision.js';

/**
 * Warn about, and persist, a deletion batch the mass-delete guard refused —
 * or clear a marker that no longer applies.
 *
 * A refusal is not a transient console line: the vault is not converging until
 * someone acts on it, so it goes into the sync state for `lsvault sync status`
 * and is re-surfaced on every run until that side's listing recovers.
 *
 * @returns true when the state was modified and needs saving.
 */
function reportDeletionAnomaly(
  out: ReturnType<typeof createOutput>,
  state: SyncState,
  anomaly: DeletionAnomaly | undefined,
  target: DeletionTarget,
): boolean {
  if (anomaly) {
    recordDeletionAnomaly(state, anomaly);
    out.stopSpinner();
    out.warn(`Refused ${anomaly.removedCount} ${target} deletion(s): ${anomaly.reason} ${massDeleteOverrideHint(target)}`);
    return true;
  }
  if (clearDeletionAnomaly(state, target)) {
    out.debug(`Deletion guard cleared for ${target}: that side's listing is consistent again.`);
    return true;
  }
  return false;
}

/** Remove a directory that `sync init --create-dir` created but could not finish setting up. */
function removeCreatedDir(dir: string): void {
  try {
    // Only an empty leaf is removed; anything the user put there stays.
    fs.rmdirSync(dir);
  } catch {
    // Best effort: a non-empty or already-removed directory is left alone.
  }
}

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
    .option('--auto-sync', 'Enable auto-sync')
    .option('--create-dir', 'Create the local directory when it does not exist')
    .addHelpText('after', `
Examples:
  lsvault sync init <vaultId> ~/my-vault
  lsvault sync init <vaultId> ~/mirror --mode pull --on-conflict remote
  lsvault sync init <vaultId> ~/docs --mode push --on-conflict local --auto-sync

Sync modes:
  pull   Download remote changes only (ideal for cron/automation)
  push   Upload local changes only (ideal for CI pipelines)
  sync   Bidirectional with conflict detection (default)`))
    .action(async (vaultId: string, localPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Initializing sync...');
      let createdDir: string | null = null;
      try {
        const mode = _opts.mode ?? 'sync';
        if (!isSyncMode(mode)) {
          throw new Error(`--mode must be one of ${SYNC_MODES.join(', ')} (got ${String(mode)})`);
        }
        const onConflict = _opts.onConflict ?? 'newer';
        if (!isConflictStrategy(onConflict)) {
          throw new Error(`--on-conflict must be one of ${CONFLICT_STRATEGIES.join(', ')} (got ${String(onConflict)})`);
        }

        const absPath = path.resolve(localPath);
        const createDir = _opts.createDir === true;
        const existedBefore = fs.existsSync(absPath);
        prepareSyncRoot(absPath, {
          createDir,
          requireUnmarked: true,
        });
        if (createDir && !existedBefore) createdDir = absPath;
        const client = await getClientAsync();
        const vault = await client.vaults.get(vaultId);

        if (!_opts.onConflict) {
          out.warn('No --on-conflict strategy specified; defaulting to "newer" (keeps the file with the more recent modification time). Use --on-conflict local|remote to override.');
        }
        if (onConflict === 'ask') {
          out.warn('--on-conflict ask never resolves conflicts automatically: conflicting files are reported and left for `lsvault sync resolve`.');
        }
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
        }, {
          markRoot: true,
          createDir,
        });
        createdDir = null;

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
        if (createdDir) removeCreatedDir(createdDir);
        handleError(out, err, 'Failed to initialize sync');
      }
    });

  // sync trust-root <syncId>
  addGlobalFlags(sync.command('trust-root')
    .description('Trust and mark the local root of a legacy sync configuration')
    .argument('<syncId>', 'Sync configuration ID')
    .option('-y, --yes', 'Skip confirmation prompt'))
    .action(async (syncId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const existing = getSyncConfig(syncId);
        if (!existing) {
          out.error(`Sync configuration not found: ${syncId}`);
          process.exitCode = 1;
          return;
        }
        // Trusting a root turns every later local deletion into a remote
        // deletion, so show exactly what would be tracked before marking it.
        const ignorePatterns = resolveIgnorePatterns(existing.ignore, existing.localPath);
        const fileCount = Object.keys(scanLocalFiles(existing.localPath, ignorePatterns)).length;
        out.status(`Sync root: ${existing.localPath}`);
        out.status(`Vault:     ${existing.vaultId}`);
        out.status(`Markdown files that will be tracked: ${fileCount}`);
        const confirmed = await confirmAction(
          `Trust this directory as the sync root for ${syncId}?`,
          { yes: _opts.yes as boolean | undefined },
        );
        if (!confirmed) {
          out.status('Trust cancelled.');
          return;
        }
        const config = trustSyncRoot(syncId);
        out.success('Sync root trusted', {
          id: config.id,
          vaultId: config.vaultId,
          localPath: config.localPath,
          rootMarkerVersion: config.rootMarkerVersion,
        });
      } catch (err) {
        handleError(out, err, 'Failed to trust sync root');
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
    .argument('<syncId>', 'Sync configuration ID')
    .option('-y, --yes', 'Skip confirmation prompt'))
    .action(async (syncId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const confirmed = await confirmAction(`Delete sync configuration ${syncId}?`, { yes: _opts.yes as boolean | undefined });
        if (!confirmed) {
          out.status('Delete cancelled.');
          return;
        }
        out.startSpinner('Deleting sync configuration...');
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
    .argument('<syncId>', 'Sync configuration ID')
    .option('--concurrency <n>', 'Max concurrent file transfers (1-16, default 4)', (v) => parseInt(v, 10))
    .option('--allow-mass-delete', 'Apply a deletion batch the safety guard would otherwise refuse'))
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

        assertSyncRoot(config);
        const client = await getClientAsync();
        const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
        const lastState = loadSyncState(config.id);

        // Clean up any orphaned temp files left by a prior interrupted pull.
        const swept = sweepOrphanedTempFiles(config.localPath, { ignorePatterns });
        if (swept > 0) {
          out.debug(`Removed ${swept} orphaned temp file(s) from ${config.localPath}`);
        }

        out.startSpinner('Scanning local files...');
        const localFiles = scanLocalFiles(config.localPath, ignorePatterns, lastState);
        out.debug(`Found ${Object.keys(localFiles).length} local files`);

        out.startSpinner('Scanning remote files...');
        const remoteResult: ScanRemoteResult = await scanRemoteFiles(
          client, config.vaultId, ignorePatterns,
          { remote: lastState.remote ?? {}, remoteListEtag: lastState.remoteListEtag },
        );
        const remoteFiles = remoteResult.files;
        out.debug(`Found ${Object.keys(remoteFiles).length} remote files`);

        out.startSpinner('Computing diff...');
        const allowMassDelete = _opts.allowMassDelete === true;
        const diff = computePullDiff(localFiles, remoteFiles, lastState, {
          allowMassDelete,
          fold: resolvePathFold(config.localPath),
        });

        const unchanged = Object.keys(remoteFiles).length - diff.downloads.length;
        const totalOps = diff.downloads.length + diff.deletes.length;

        // Persist the new list ETag regardless of whether there are changes
        if (remoteResult.listEtag) {
          lastState.remoteListEtag = remoteResult.listEtag;
        }

        // A refused deletion batch is not a transient console warning: the vault
        // is not converging until someone looks at it, so it is persisted for
        // `lsvault sync status` and re-surfaced on every run until it clears.
        const clearedDenials = pruneDeniedDeletes(lastState, remoteFiles, localFiles);
        let stateDirty = clearedDenials.length > 0;
        if (reportDeletionAnomaly(out, lastState, diff.deletionAnomaly, 'local')) stateDirty = true;

        if (totalOps === 0) {
          if (remoteResult.listEtag || stateDirty) {
            saveSyncState(lastState);
          }
          out.succeedSpinner('Everything is up to date');
          if (flags.output === 'json') {
            out.record({
              status: 'up-to-date',
              downloaded: 0,
              deleted: 0,
              unchanged: Object.keys(remoteFiles).length,
              bytesTransferred: 0,
              errors: 0,
              ...(diff.deletionAnomaly ? { deletionAnomaly: diff.deletionAnomaly } : {}),
            });
          }
          return;
        }

        out.stopSpinner();

        if (flags.dryRun) {
          if (flags.output === 'json') {
            out.record({
              dryRun: true,
              downloads: diff.downloads.length,
              deletes: diff.deletes.length,
              unchanged,
              totalBytes: diff.totalBytes,
              ...(diff.deletionAnomaly ? { deletionAnomaly: diff.deletionAnomaly } : {}),
            });
          } else {
            out.status(chalk.yellow('Dry run — no changes will be made:'));
            out.status(formatDiff(diff));
          }
          return;
        }

        if (flags.verbose) {
          out.status(formatDiff(diff));
        }

        const concurrency = resolveConcurrency(_opts.concurrency as number | undefined);

        if (stateDirty) saveSyncState(lastState);

        out.startSpinner(`Pulling ${totalOps} file(s)...`);
        const conflictCopies: Array<{ path: string; conflictFile: string }> = [];
        const result = await executePull(client, config, diff, (progress) => {
          if (progress.phase === 'transferring' && progress.currentFile) {
            out.startSpinner(`[${progress.current}/${progress.total}] ${progress.currentFile}`);
          }
        }, concurrency, (file) => {
          out.startSpinner(`Rate limited — waiting and retrying… (${file})`);
        }, (docPath, conflictFile) => {
          conflictCopies.push({ path: docPath, conflictFile });
        });

        if (result.errors.length > 0) {
          out.failSpinner(`Pull completed with ${result.errors.length} error(s)`);
          for (const err of result.errors) {
            out.error(`  ${err.path}: ${err.error}`);
          }
          process.exitCode = 1;
        } else {
          out.succeedSpinner('Pull complete');
        }

        for (const copy of conflictCopies) {
          out.warn(`Kept your local edit of ${copy.path} as ${copy.conflictFile} before applying the remote deletion.`);
        }

        out.success('', {
          downloaded: result.filesDownloaded,
          deleted: result.filesDeleted,
          unchanged,
          bytesTransferred: result.bytesTransferred,
          errors: result.errors.length,
          ...(conflictCopies.length > 0 ? { conflictCopies } : {}),
          ...(diff.deletionAnomaly ? { deletionAnomaly: diff.deletionAnomaly } : {}),
        });
      } catch (err) {
        handleError(out, err, 'Pull failed');
      }
    });

  // sync push <syncId>
  addGlobalFlags(sync.command('push')
    .description('Push local changes to remote vault')
    .argument('<syncId>', 'Sync configuration ID')
    .option('--concurrency <n>', 'Max concurrent file transfers (1-16, default 4)', (v) => parseInt(v, 10))
    .option('--allow-mass-delete', 'Apply a deletion batch the safety guard would otherwise refuse'))
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

        assertSyncRoot(config);
        const client = await getClientAsync();
        const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
        const lastState = loadSyncState(config.id);

        // An interrupted pull leaves temp files behind that a later push would
        // otherwise be free to upload; the sweep is not pull-specific.
        const swept = sweepOrphanedTempFiles(config.localPath, { ignorePatterns });
        if (swept > 0) {
          out.debug(`Removed ${swept} orphaned temp file(s) from ${config.localPath}`);
        }

        out.startSpinner('Scanning local files...');
        const localFiles = scanLocalFiles(config.localPath, ignorePatterns, lastState);
        out.debug(`Found ${Object.keys(localFiles).length} local files`);

        out.startSpinner('Scanning remote files...');
        const remoteResult: ScanRemoteResult = await scanRemoteFiles(
          client, config.vaultId, ignorePatterns,
          { remote: lastState.remote ?? {}, remoteListEtag: lastState.remoteListEtag },
        );
        const remoteFiles = remoteResult.files;
        out.debug(`Found ${Object.keys(remoteFiles).length} remote files`);

        const clearedDenials = pruneDeniedDeletes(lastState, remoteFiles, localFiles);
        let stateDirty = clearedDenials.length > 0;
        if (clearedDenials.length > 0) {
          out.debug(`Cleared ${clearedDenials.length} stale denied-delete marker(s)`);
        }

        out.startSpinner('Computing diff...');
        // The mirror of the pull guard, and the more destructive direction: a
        // local scan that came back short deletes documents from the vault every
        // other client syncs from.
        const allowMassDelete = _opts.allowMassDelete === true;
        const diff = computePushDiff(localFiles, remoteFiles, lastState, {
          allowMassDelete,
          fold: resolvePathFold(config.localPath),
        });
        if (reportDeletionAnomaly(out, lastState, diff.deletionAnomaly, 'remote')) stateDirty = true;

        const unchanged = Object.keys(localFiles).length - diff.uploads.length;
        const totalOps = diff.uploads.length + diff.deletes.length;

        // Persist the new list ETag regardless of whether there are changes
        if (remoteResult.listEtag) {
          lastState.remoteListEtag = remoteResult.listEtag;
        }

        if (totalOps === 0) {
          if (remoteResult.listEtag || stateDirty) {
            saveSyncState(lastState);
          }
          out.succeedSpinner('Everything is up to date');
          if (flags.output === 'json') {
            out.record({
              status: 'up-to-date',
              uploaded: 0,
              deleted: 0,
              unchanged: Object.keys(localFiles).length,
              bytesTransferred: 0,
              errors: 0,
              ...(diff.deletionAnomaly ? { deletionAnomaly: diff.deletionAnomaly } : {}),
            });
          }
          return;
        }

        out.stopSpinner();

        if (flags.dryRun) {
          if (flags.output === 'json') {
            out.record({
              dryRun: true,
              uploads: diff.uploads.length,
              deletes: diff.deletes.length,
              unchanged,
              totalBytes: diff.totalBytes,
              ...(diff.deletionAnomaly ? { deletionAnomaly: diff.deletionAnomaly } : {}),
            });
          } else {
            out.status(chalk.yellow('Dry run — no changes will be made:'));
            out.status(formatDiff(diff));
          }
          return;
        }

        if (flags.verbose) {
          out.status(formatDiff(diff));
        }

        const concurrency = resolveConcurrency(_opts.concurrency as number | undefined);

        if (stateDirty) saveSyncState(lastState);

        out.startSpinner(`Pushing ${totalOps} file(s)...`);
        const result = await executePush(client, config, diff, (progress) => {
          if (progress.phase === 'transferring' && progress.currentFile) {
            out.startSpinner(`[${progress.current}/${progress.total}] ${progress.currentFile}`);
          }
        }, concurrency, (file) => {
          out.startSpinner(`Rate limited — waiting and retrying… (${file})`);
        });

        if (result.errors.length > 0) {
          out.failSpinner(`Push completed with ${result.errors.length} error(s)`);
          for (const err of result.errors) {
            out.error(`  ${err.path}: ${err.error}`);
          }
          process.exitCode = 1;
        } else {
          out.succeedSpinner('Push complete');
        }

        out.success('', {
          uploaded: result.filesUploaded,
          deleted: result.filesDeleted,
          unchanged,
          bytesTransferred: result.bytesTransferred,
          errors: result.errors.length,
          ...(diff.deletionAnomaly ? { deletionAnomaly: diff.deletionAnomaly } : {}),
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

        assertSyncRoot(config);
        const client = await getClientAsync();
        const ignorePatterns = resolveIgnorePatterns(config.ignore, config.localPath);
        const lastState = loadSyncState(config.id);

        out.startSpinner('Scanning...');
        const localFiles = scanLocalFiles(config.localPath, ignorePatterns, lastState);
        const remoteResult: ScanRemoteResult = await scanRemoteFiles(
          client, config.vaultId, ignorePatterns,
          { remote: lastState.remote ?? {}, remoteListEtag: lastState.remoteListEtag },
        );
        const remoteFiles = remoteResult.files;

        const fold = resolvePathFold(config.localPath);
        const pullDiff = computePullDiff(localFiles, remoteFiles, lastState, { fold });
        const pushDiff = computePushDiff(localFiles, remoteFiles, lastState, { fold });

        out.stopSpinner();

        const pullOps = pullDiff.downloads.length + pullDiff.deletes.length;
        const pushOps = pushDiff.uploads.length + pushDiff.deletes.length;
        // A persisted anomaly is what a refusing daemon left behind; a freshly
        // computed one is what this scan sees right now. Report either, per side:
        // "your local nearly got wiped" and "your remote nearly got wiped" need
        // different responses from the operator.
        const deletionAnomalies = [
          pullDiff.deletionAnomaly ?? lastState.deletionAnomalies?.local,
          pushDiff.deletionAnomaly ?? lastState.deletionAnomalies?.remote,
        ].filter((a): a is DeletionAnomaly => a !== undefined);
        const deniedDeletes = Object.entries(lastState.deniedDeletes ?? {});

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
            ...(deletionAnomalies.length > 0 ? { deletionAnomalies } : {}),
            ...(deniedDeletes.length > 0
              ? { deniedDeletes: deniedDeletes.map(([docPath, entry]) => ({ path: docPath, ...entry })) }
              : {}),
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

        for (const anomaly of deletionAnomalies) {
          out.status('');
          out.status(chalk.red(
            `Deletion guard active on the ${anomaly.target} side since ${anomaly.detectedAt}: ${anomaly.reason}`,
          ));
          out.status(chalk.red(`  ${massDeleteOverrideHint(anomaly.target)}`));
        }

        if (deniedDeletes.length > 0) {
          out.status('');
          out.status(chalk.yellow(`${deniedDeletes.length} local deletion(s) the server refused:`));
          for (const [docPath, entry] of deniedDeletes) {
            out.status(chalk.yellow(`  - ${docPath} (since ${entry.deniedAt}): ${entry.reason}`));
          }
          out.status(chalk.yellow('  These paths are not restored by pull. Ask a vault admin to delete them, or restore the file locally to clear the marker.'));
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

        assertSyncRoot(config);
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
        const {
          ready: watcherReady,
          markLocalWrite,
          serialize,
          stop: stopWatcher,
        } = createWatcher(client, config, {
          ignorePatterns,
          onLog: logHandler,
          onConflictLog: conflictHandler,
          onError: errorHandler,
        });

        try {
          await watcherReady;
        } catch (err) {
          await stopWatcher().catch(() => undefined);
          throw err;
        }

        // Start remote poller (only for sync and pull modes)
        let stopPoller: (() => Promise<void>) | undefined;
        if (config.mode === 'sync') {
          const poller = createRemotePoller(client, config, {
            ignorePatterns,
            intervalMs: pollInterval,
            onLog: logHandler,
            onConflictLog: conflictHandler,
            onError: errorHandler,
            onLocalWrite: markLocalWrite,
            serialize,
          });
          stopPoller = poller.stop;
        }

        // Handle graceful shutdown
        let shutdownPromise: Promise<void> | null = null;
        const performShutdown = async (): Promise<void> => {
          out.status('\nStopping...');
          const results = await Promise.allSettled([
            stopPoller?.() ?? Promise.resolve(),
            stopWatcher(),
          ]);
          const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
          if (errors.length > 0) throw new Error(`Sync watch did not drain cleanly: ${errors.join('; ')}`);
          out.status('Sync watch stopped.');
        };

        const shutdown = () => {
          process.removeListener('SIGINT', shutdown);
          process.removeListener('SIGTERM', shutdown);
          shutdownPromise ??= performShutdown();
          void shutdownPromise.then(
            () => process.exit(0),
            err => {
              out.error(err instanceof Error ? err.message : String(err));
              process.exit(1);
            },
          );
        };

        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);

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

        assertSyncRoot(config);
        const useVersion = String(_opts.use);
        if (useVersion !== 'local' && useVersion !== 'remote') {
          out.failSpinner('--use must be "local" or "remote"');
          process.exitCode = 1;
          return;
        }

        const client = await getClientAsync();
        const localFile = resolveWithinSyncRoot(config.localPath, docPath);
        const state = loadSyncState(config.id);

        if (useVersion === 'local') {
          assertSyncRoot(config);
          if (!fs.existsSync(localFile)) {
            out.failSpinner(`Local file not found: ${localFile}`);
            process.exitCode = 1;
            return;
          }
          const content = fs.readFileSync(localFile, 'utf-8');
          assertSyncRoot(config);
          // Condition the overwrite on the remote bytes this sync last saw. If
          // the server has moved on again since the conflict was recorded, the
          // 412 is the right answer — resolving a stale conflict must not
          // destroy an edit that arrived after it.
          const knownRemoteHash = state.remote[docPath]?.hash;
          await client.documents.put(config.vaultId, docPath, content,
            knownRemoteHash ? { ifMatch: knownRemoteHash } : undefined);

          state.local[docPath] = {
            path: docPath,
            hash: hashFileContent(content),
            mtime: new Date().toISOString(),
            size: Buffer.byteLength(content),
          };
          state.remote[docPath] = buildRemoteFileState(docPath, content, new Date().toISOString());
        } else {
          const { content } = await client.documents.get(config.vaultId, docPath);
          assertSyncRoot(config);
          const mutationTarget = resolveWithinSyncRoot(config.localPath, docPath);
          const dir = path.dirname(mutationTarget);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          assertSyncRoot(config);
          // The local side is about to be discarded, so keep a copy first —
          // `--use remote` is a one-way door otherwise, and the file being
          // resolved is by definition one the user edited.
          if (fs.existsSync(mutationTarget)) {
            const localContent = fs.readFileSync(mutationTarget, 'utf-8');
            if (localContent !== content) {
              const backup = createConflictFile(config.localPath, docPath, localContent, 'local');
              out.warn(`Saved the local version as ${backup} before overwriting it.`);
            }
          }
          // Atomic, like every other local write in the sync engine: a crash
          // mid-write must not leave a truncated document at the target path.
          atomicWriteFileSync(mutationTarget, content, 'utf-8');

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
        const { pid, lingerWarning } = await startDaemon(logFile);
        out.success('Daemon started', { pid, status: 'running' });
        if (lingerWarning) {
          out.warn(`Warning: ${lingerWarning}`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to start daemon');
      }
    });

  addGlobalFlags(daemon.command('run')
    .description('Run the sync daemon in the foreground (for systemd/launchd)'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        await runDaemonForeground();
      } catch (err) {
        handleError(out, err, 'Daemon failed');
      }
    });

  addGlobalFlags(daemon.command('stop')
    .description('Stop the background sync daemon'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const stopped = await stopDaemon();
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
            state: status.state,
            pid: status.pid,
            logFile: status.logFile,
            uptime: status.uptime,
            startedAt: status.startedAt,
          });
          return;
        }

        if (status.state === 'unknown') {
          out.status(chalk.yellow(`Daemon status unknown: PID ${status.pid} is alive but could not be verified on this platform.`));
          out.status(`  Log file:   ${status.logFile}`);
          process.exitCode = 1;
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
