import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerVersionCommands(program: Command): void {
  const versions = program.command('versions').description('View and manage document version history');

  addGlobalFlags(versions.command('list')
    .description('List version history for a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path (e.g., notes/todo.md)')
    .addHelpText('after', `
EXAMPLES
  lsvault versions list abc123 notes/todo.md`))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching versions...');
      try {
        const client = getClient();
        const versionList = await client.documents.listVersions(vaultId, docPath);
        out.stopSpinner();
        out.list(
          versionList.map(v => ({
            version: v.versionNum,
            source: v.changeSource,
            sizeBytes: v.sizeBytes,
            pinned: v.isPinned ? 'yes' : 'no',
            createdAt: v.createdAt,
          })),
          {
            emptyMessage: 'No versions found.',
            columns: [
              { key: 'version', header: 'Version' },
              { key: 'source', header: 'Source' },
              { key: 'sizeBytes', header: 'Size' },
              { key: 'pinned', header: 'Pinned' },
              { key: 'createdAt', header: 'Created' },
            ],
            textFn: (v) => {
              const pin = v.pinned === 'yes' ? chalk.yellow(' [pinned]') : '';
              return `v${String(v.version)} ${chalk.dim(String(v.source))} ${chalk.dim(String(v.sizeBytes) + 'B')} ${chalk.dim(String(v.createdAt))}${pin}`;
            },
          },
        );
        if (flags.output === 'text' && versionList.length > 0) {
          out.status(chalk.dim(`\n${versionList.length} version(s)`));
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch versions');
      }
    });

  addGlobalFlags(versions.command('view')
    .description('View content of a specific version')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .argument('<version>', 'Version number')
    .addHelpText('after', `
EXAMPLES
  lsvault versions view abc123 notes/todo.md 3`))
    .action(async (vaultId: string, docPath: string, versionStr: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const versionNum = parseInt(versionStr, 10);
      if (isNaN(versionNum)) {
        out.error('Version must be a number');
        process.exitCode = 1;
        return;
      }
      try {
        const client = getClient();
        const version = await client.documents.getVersion(vaultId, docPath, versionNum);
        if (version.content === null) {
          out.error('Version content is no longer available (expired or pruned)');
          process.exitCode = 1;
          return;
        }
        out.raw(version.content);
      } catch (err) {
        handleError(out, err, 'Failed to get version');
      }
    });

  addGlobalFlags(versions.command('diff')
    .description('Show diff between two versions')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .argument('<from>', 'Source version number')
    .argument('<to>', 'Target version number')
    .addHelpText('after', `
EXAMPLES
  lsvault versions diff abc123 notes/todo.md 1 3`))
    .action(async (vaultId: string, docPath: string, fromStr: string, toStr: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const from = parseInt(fromStr, 10);
      const to = parseInt(toStr, 10);
      if (isNaN(from) || isNaN(to)) {
        out.error('Version numbers must be integers');
        process.exitCode = 1;
        return;
      }
      out.startSpinner('Computing diff...');
      try {
        const client = getClient();
        const diff = await client.documents.diffVersions(vaultId, docPath, from, to);
        out.stopSpinner();

        if (flags.output === 'json') {
          out.raw(JSON.stringify(diff, null, 2));
        } else {
          out.status(`Diff: v${diff.fromVersion} -> v${diff.toVersion}\n`);
          for (const change of diff.changes) {
            if (change.added) {
              out.raw(chalk.green(`+ ${change.value.replace(/\n$/, '')}`));
            } else if (change.removed) {
              out.raw(chalk.red(`- ${change.value.replace(/\n$/, '')}`));
            } else {
              out.raw(chalk.dim(`  ${change.value.replace(/\n$/, '')}`));
            }
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to compute diff');
      }
    });

  addGlobalFlags(versions.command('restore')
    .description('Restore a document to a previous version')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .argument('<version>', 'Version number to restore')
    .addHelpText('after', `
EXAMPLES
  lsvault versions restore abc123 notes/todo.md 2`))
    .action(async (vaultId: string, docPath: string, versionStr: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const versionNum = parseInt(versionStr, 10);
      if (isNaN(versionNum)) {
        out.error('Version must be a number');
        process.exitCode = 1;
        return;
      }
      out.startSpinner(`Restoring to version ${versionNum}...`);
      try {
        const client = getClient();
        const doc = await client.documents.restoreVersion(vaultId, docPath, versionNum);
        out.success(`Restored ${chalk.cyan(docPath)} to version ${versionNum}`, {
          path: doc.path,
          version: versionNum,
        });
      } catch (err) {
        handleError(out, err, 'Failed to restore version');
      }
    });

  addGlobalFlags(versions.command('pin')
    .description('Pin a version to prevent pruning')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .argument('<version>', 'Version number to pin')
    .addHelpText('after', `
EXAMPLES
  lsvault versions pin abc123 notes/todo.md 5`))
    .action(async (vaultId: string, docPath: string, versionStr: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const versionNum = parseInt(versionStr, 10);
      if (isNaN(versionNum)) {
        out.error('Version must be a number');
        process.exitCode = 1;
        return;
      }
      out.startSpinner(`Pinning version ${versionNum}...`);
      try {
        const client = getClient();
        await client.documents.pinVersion(vaultId, docPath, versionNum);
        out.success(`Pinned version ${versionNum} of ${chalk.cyan(docPath)}`, {
          path: docPath,
          version: versionNum,
          pinned: true,
        });
      } catch (err) {
        handleError(out, err, 'Failed to pin version');
      }
    });

  addGlobalFlags(versions.command('unpin')
    .description('Unpin a version, allowing it to be pruned')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .argument('<version>', 'Version number to unpin')
    .addHelpText('after', `
EXAMPLES
  lsvault versions unpin abc123 notes/todo.md 5`))
    .action(async (vaultId: string, docPath: string, versionStr: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const versionNum = parseInt(versionStr, 10);
      if (isNaN(versionNum)) {
        out.error('Version must be a number');
        process.exitCode = 1;
        return;
      }
      out.startSpinner(`Unpinning version ${versionNum}...`);
      try {
        const client = getClient();
        await client.documents.unpinVersion(vaultId, docPath, versionNum);
        out.success(`Unpinned version ${versionNum} of ${chalk.cyan(docPath)}`, {
          path: docPath,
          version: versionNum,
          pinned: false,
        });
      } catch (err) {
        handleError(out, err, 'Failed to unpin version');
      }
    });
}
