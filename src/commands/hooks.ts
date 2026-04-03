import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { CreateHookParams } from '@lifestreamdynamics/vault-sdk';
import { resolveVaultId } from '../utils/resolve-vault.js';

export function registerHookCommands(program: Command): void {
  const hooks = program.command('hooks').description('Manage vault event hooks');

  addGlobalFlags(hooks.command('list')
    .description('List all hooks for a vault')
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching hooks...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<name>', 'Hook name')
    .requiredOption('--trigger <event>', 'Trigger event (document.created, document.updated, document.deleted, document.moved, document.copied)')
    .requiredOption('--action <type>', 'Action type (webhook, ai_prompt, document_operation, auto_calendar_event, auto_booking_process)')
    .requiredOption('--config <json>', 'Action configuration as JSON')
    .option('--filter <json>', 'Trigger filter as JSON')
    .addHelpText('after', `
VALID TRIGGER EVENTS
  document.created        Document was created
  document.updated        Document content was updated
  document.deleted        Document was deleted
  document.moved          Document was moved or renamed
  document.copied         Document was copied

VALID ACTION TYPES
  webhook                 Send an HTTP notification to a URL
  ai_prompt               Run an AI prompt on the document
  document_operation      Perform a document operation (move, copy, tag)
  auto_calendar_event     Automatically create a calendar event
  auto_booking_process    Automatically process a booking

EXAMPLES
  lsvault hooks create <vaultId> my-hook --trigger document.created --action webhook --config '{"url":"https://example.com/hook"}'
  lsvault hooks create <vaultId> ai-tag --trigger document.created --action ai_prompt --config '{"prompt":"Suggest tags"}'
  lsvault hooks create <vaultId> move-docs --trigger document.created --action document_operation --config '{"operation":"move","targetPath":"inbox/"}'`))
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

      const VALID_TRIGGERS = ['document.created', 'document.updated', 'document.deleted', 'document.moved', 'document.copied'];
      const VALID_ACTIONS = ['webhook', 'ai_prompt', 'document_operation', 'auto_calendar_event', 'auto_booking_process'];

      const trigger = String(_opts.trigger);
      const action = String(_opts.action);

      if (!VALID_TRIGGERS.includes(trigger)) {
        out.error(`Invalid trigger "${trigger}". Valid values: document.created, document.updated, document.deleted, document.moved, document.copied`);
        process.exitCode = 1;
        return;
      }

      if (!VALID_ACTIONS.includes(action)) {
        out.error(`Invalid action "${action}". Valid values: webhook, ai_prompt, document_operation, auto_calendar_event, auto_booking_process`);
        process.exitCode = 1;
        return;
      }

      out.startSpinner('Creating hook...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<hookId>', 'Hook ID')
    .option('-y, --yes', 'Skip confirmation prompt'))
    .action(async (vaultId: string, hookId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes) {
        out.status(chalk.yellow(`Pass --yes to delete hook ${hookId}.`));
        return;
      }
      out.startSpinner('Deleting hook...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        await client.hooks.delete(vaultId, hookId);
        out.success('Hook deleted successfully', { id: hookId, deleted: true });
      } catch (err) {
        handleError(out, err, 'Failed to delete hook');
      }
    });

  addGlobalFlags(hooks.command('executions')
    .description('List recent executions for a hook')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<hookId>', 'Hook ID'))
    .action(async (vaultId: string, hookId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching executions...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
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
