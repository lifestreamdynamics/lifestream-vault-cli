import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { CreateHookParams } from '@lifestream-vault/sdk';

export function registerHookCommands(program: Command): void {
  const hooks = program.command('hooks').description('Manage vault event hooks (auto-tag, template, etc.)');

  addGlobalFlags(hooks.command('list')
    .description('List all hooks for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching hooks...');
      try {
        const client = getClient();
        const hookList = await client.hooks.list(vaultId);
        out.stopSpinner();
        out.list(
          hookList.map(hook => ({
            name: hook.name,
            id: hook.id,
            triggerEvent: hook.triggerEvent,
            actionType: hook.actionType,
            isActive: hook.isActive,
          })),
          {
            emptyMessage: 'No hooks found.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'triggerEvent', header: 'Trigger' },
              { key: 'actionType', header: 'Action' },
              { key: 'isActive', header: 'Active' },
            ],
            textFn: (hook) => {
              const lines = [chalk.cyan(`  ${String(hook.name)}`)];
              lines.push(`  ID:      ${String(hook.id)}`);
              lines.push(`  Trigger: ${String(hook.triggerEvent)}`);
              lines.push(`  Action:  ${String(hook.actionType)}`);
              lines.push(`  Active:  ${hook.isActive ? chalk.green('Yes') : chalk.red('No')}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch hooks');
      }
    });

  addGlobalFlags(hooks.command('create')
    .description('Create a new hook')
    .argument('<vaultId>', 'Vault ID')
    .argument('<name>', 'Hook name')
    .requiredOption('--trigger <event>', 'Trigger event (e.g., document.create)')
    .requiredOption('--action <type>', 'Action type (e.g., auto-tag, template)')
    .requiredOption('--config <json>', 'Action configuration as JSON')
    .option('--filter <json>', 'Trigger filter as JSON'))
    .action(async (vaultId: string, name: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      let actionConfig: Record<string, unknown>;
      try {
        actionConfig = JSON.parse(String(_opts.config));
      } catch {
        out.error('--config must be valid JSON');
        process.exitCode = 2;
        return;
      }

      let triggerFilter: Record<string, unknown> | undefined;
      if (_opts.filter) {
        try {
          triggerFilter = JSON.parse(String(_opts.filter));
        } catch {
          out.error('--filter must be valid JSON');
          process.exitCode = 2;
          return;
        }
      }

      out.startSpinner('Creating hook...');
      try {
        const client = getClient();
        const params: CreateHookParams = {
          name,
          triggerEvent: String(_opts.trigger),
          actionType: String(_opts.action),
          actionConfig,
        };
        if (triggerFilter) params.triggerFilter = triggerFilter;

        const hook = await client.hooks.create(vaultId, params);
        out.success('Hook created successfully!', {
          id: hook.id,
          name: hook.name,
          triggerEvent: hook.triggerEvent,
          actionType: hook.actionType,
        });
      } catch (err) {
        handleError(out, err, 'Failed to create hook');
      }
    });

  addGlobalFlags(hooks.command('delete')
    .description('Delete a hook')
    .argument('<vaultId>', 'Vault ID')
    .argument('<hookId>', 'Hook ID'))
    .action(async (vaultId: string, hookId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Deleting hook...');
      try {
        const client = getClient();
        await client.hooks.delete(vaultId, hookId);
        out.success('Hook deleted successfully', { id: hookId, deleted: true });
      } catch (err) {
        handleError(out, err, 'Failed to delete hook');
      }
    });

  addGlobalFlags(hooks.command('executions')
    .description('List recent executions for a hook')
    .argument('<vaultId>', 'Vault ID')
    .argument('<hookId>', 'Hook ID'))
    .action(async (vaultId: string, hookId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching executions...');
      try {
        const client = getClient();
        const executions = await client.hooks.listExecutions(vaultId, hookId);
        out.stopSpinner();
        out.list(
          executions.map(exec => ({
            id: exec.id,
            status: exec.status,
            durationMs: exec.durationMs,
            error: exec.error || null,
            createdAt: exec.createdAt,
          })),
          {
            emptyMessage: 'No executions found.',
            columns: [
              { key: 'status', header: 'Status' },
              { key: 'id', header: 'ID' },
              { key: 'durationMs', header: 'Duration (ms)' },
              { key: 'createdAt', header: 'Time' },
            ],
            textFn: (exec) => {
              const statusColor = String(exec.status) === 'success' ? chalk.green : chalk.red;
              const lines = [`  ${statusColor(String(exec.status).toUpperCase())}  ${String(exec.id)}`];
              if (exec.durationMs !== null) lines.push(`  Duration: ${String(exec.durationMs)}ms`);
              if (exec.error) lines.push(`  Error: ${chalk.red(String(exec.error))}`);
              lines.push(`  Time: ${new Date(String(exec.createdAt)).toLocaleString()}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch executions');
      }
    });
}
