import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerConnectorCommands(program: Command): void {
  const connectors = program.command('connectors').description('Manage external service connectors (e.g., Google Drive)');

  addGlobalFlags(connectors.command('list')
    .description('List connectors')
    .option('--vault <vaultId>', 'Filter by vault ID'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching connectors...');
      try {
        const client = await getClientAsync();
        const connectorList = await client.connectors.list(_opts.vault as string | undefined);
        out.stopSpinner();
        out.list(
          connectorList.map(c => ({
            name: c.name,
            id: c.id,
            provider: c.provider,
            status: c.status,
            syncDirection: c.syncDirection,
          })),
          {
            emptyMessage: 'No connectors found.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'provider', header: 'Provider' },
              { key: 'status', header: 'Status' },
              { key: 'syncDirection', header: 'Direction' },
            ],
            textFn: (c) => {
              const status = String(c.status) === 'active' ? chalk.green(String(c.status)) :
                String(c.status) === 'error' ? chalk.red(String(c.status)) : chalk.dim(String(c.status));
              return `${chalk.cyan(String(c.name))} ${chalk.dim(`(${String(c.id)})`)} -- ${String(c.provider)} ${status} [${String(c.syncDirection)}]`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch connectors');
      }
    });

  addGlobalFlags(connectors.command('get')
    .description('Get connector details')
    .argument('<connectorId>', 'Connector ID'))
    .action(async (connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching connector...');
      try {
        const client = await getClientAsync();
        const c = await client.connectors.get(connectorId);
        out.stopSpinner();
        out.record({
          name: c.name,
          id: c.id,
          provider: c.provider,
          vaultId: c.vaultId,
          syncDirection: c.syncDirection,
          syncPath: c.syncPath,
          status: c.status,
          isActive: c.isActive,
          lastSyncAt: c.lastSyncAt,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch connector');
      }
    });

  addGlobalFlags(connectors.command('create')
    .description('Create a connector')
    .argument('<provider>', 'Provider (e.g., google_drive)')
    .argument('<name>', 'Connector name')
    .requiredOption('--vault <vaultId>', 'Vault ID')
    .requiredOption('-d, --direction <direction>', 'Sync direction (pull, push, bidirectional)')
    .option('-p, --sync-path <path>', 'Sync path prefix'))
    .action(async (provider: string, name: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating connector...');
      try {
        const client = await getClientAsync();
        const connector = await client.connectors.create({
          provider: provider as 'google_drive',
          name,
          vaultId: String(_opts.vault),
          syncDirection: String(_opts.direction) as 'pull' | 'push' | 'bidirectional',
          syncPath: _opts.syncPath as string | undefined,
        });
        out.success(`Connector created: ${chalk.cyan(connector.name)} (${connector.id})`, {
          id: connector.id,
          name: connector.name,
          provider: connector.provider,
        });
      } catch (err) {
        handleError(out, err, 'Failed to create connector');
      }
    });

  addGlobalFlags(connectors.command('update')
    .description('Update a connector')
    .argument('<connectorId>', 'Connector ID')
    .option('-n, --name <name>', 'New name')
    .option('-d, --direction <direction>', 'New sync direction'))
    .action(async (connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating connector...');
      try {
        const client = await getClientAsync();
        const params: Record<string, unknown> = {};
        if (_opts.name) params.name = _opts.name;
        if (_opts.direction) params.syncDirection = _opts.direction;
        const connector = await client.connectors.update(connectorId, params);
        out.success(`Connector updated: ${chalk.cyan(connector.name)}`, {
          id: connector.id,
          name: connector.name,
        });
      } catch (err) {
        handleError(out, err, 'Failed to update connector');
      }
    });

  addGlobalFlags(connectors.command('delete')
    .description('Delete a connector')
    .argument('<connectorId>', 'Connector ID'))
    .action(async (connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Deleting connector...');
      try {
        const client = await getClientAsync();
        await client.connectors.delete(connectorId);
        out.success('Connector deleted.', { id: connectorId, deleted: true });
      } catch (err) {
        handleError(out, err, 'Failed to delete connector');
      }
    });

  addGlobalFlags(connectors.command('test')
    .description('Test a connector connection')
    .argument('<connectorId>', 'Connector ID'))
    .action(async (connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Testing connection...');
      try {
        const client = await getClientAsync();
        const result = await client.connectors.test(connectorId);
        if (result.success) {
          out.success('Connection test passed.', { success: true });
        } else {
          out.failSpinner(`Connection test failed: ${result.error || 'Unknown error'}`);
          if (flags.output === 'json') {
            out.record({ success: false, error: result.error });
          }
          process.exitCode = 1;
        }
      } catch (err) {
        handleError(out, err, 'Failed to test connection');
      }
    });

  addGlobalFlags(connectors.command('sync')
    .description('Trigger a sync for a connector')
    .argument('<connectorId>', 'Connector ID'))
    .action(async (connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Triggering sync...');
      try {
        const client = await getClientAsync();
        const result = await client.connectors.sync(connectorId);
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to trigger sync');
      }
    });

  addGlobalFlags(connectors.command('logs')
    .description('View sync logs for a connector')
    .argument('<connectorId>', 'Connector ID'))
    .action(async (connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching sync logs...');
      try {
        const client = await getClientAsync();
        const logs = await client.connectors.logs(connectorId);
        out.stopSpinner();
        out.list(
          logs.map(log => ({
            status: log.status,
            createdAt: log.createdAt,
            filesAdded: log.filesAdded,
            filesUpdated: log.filesUpdated,
            filesDeleted: log.filesDeleted,
            durationMs: log.durationMs,
          })),
          {
            emptyMessage: 'No sync logs found.',
            columns: [
              { key: 'status', header: 'Status' },
              { key: 'createdAt', header: 'Time' },
              { key: 'filesAdded', header: 'Added' },
              { key: 'filesUpdated', header: 'Updated' },
              { key: 'filesDeleted', header: 'Deleted' },
              { key: 'durationMs', header: 'Duration (ms)' },
            ],
            textFn: (log) => {
              const status = String(log.status) === 'success' ? chalk.green(String(log.status)) : chalk.red(String(log.status));
              const duration = log.durationMs ? `${String(log.durationMs)}ms` : 'n/a';
              return `${status} ${chalk.dim(String(log.createdAt))} -- +${String(log.filesAdded)} ~${String(log.filesUpdated)} -${String(log.filesDeleted)} (${duration})`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch sync logs');
      }
    });
}
