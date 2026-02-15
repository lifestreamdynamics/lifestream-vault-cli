import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { CreateWebhookParams, UpdateWebhookParams } from '@lifestreamdynamics/vault-sdk';

export function registerWebhookCommands(program: Command): void {
  const webhooks = program.command('webhooks').description('Manage vault webhooks');

  addGlobalFlags(webhooks.command('list')
    .description('List all webhooks for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching webhooks...');
      try {
        const client = await getClientAsync();
        const webhookList = await client.webhooks.list(vaultId);
        out.stopSpinner();
        out.list(
          webhookList.map(wh => ({
            url: wh.url,
            id: wh.id,
            events: wh.events.join(', '),
            isActive: wh.isActive,
          })),
          {
            emptyMessage: 'No webhooks found.',
            columns: [
              { key: 'url', header: 'URL' },
              { key: 'events', header: 'Events' },
              { key: 'isActive', header: 'Active' },
            ],
            textFn: (wh) => {
              const lines = [chalk.cyan(`  ${String(wh.url)}`)];
              lines.push(`  ID:     ${String(wh.id)}`);
              lines.push(`  Events: ${String(wh.events)}`);
              lines.push(`  Active: ${wh.isActive ? chalk.green('Yes') : chalk.red('No')}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch webhooks');
      }
    });

  addGlobalFlags(webhooks.command('create')
    .description('Create a new webhook')
    .argument('<vaultId>', 'Vault ID')
    .argument('<url>', 'Webhook endpoint URL')
    .option('--events <events>', 'Comma-separated events (e.g., create,update,delete)', 'create,update,delete'))
    .action(async (vaultId: string, url: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating webhook...');
      try {
        const client = await getClientAsync();
        const params: CreateWebhookParams = {
          url,
          events: String(_opts.events || 'create,update,delete').split(',').map((e: string) => e.trim()),
        };

        const webhook = await client.webhooks.create(vaultId, params);
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({
            id: webhook.id,
            url: webhook.url,
            events: webhook.events.join(', '),
            secret: webhook.secret,
          });
        } else {
          out.warn('\nIMPORTANT: Save this secret securely. It cannot be retrieved later.\n');
          process.stdout.write(chalk.green.bold(`Secret: ${webhook.secret}\n`));
          process.stdout.write(`\nID:     ${webhook.id}\n`);
          process.stdout.write(`URL:    ${webhook.url}\n`);
          process.stdout.write(`Events: ${webhook.events.join(', ')}\n`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to create webhook');
      }
    });

  addGlobalFlags(webhooks.command('update')
    .description('Update a webhook')
    .argument('<vaultId>', 'Vault ID')
    .argument('<webhookId>', 'Webhook ID')
    .option('--url <url>', 'New webhook URL')
    .option('--events <events>', 'Comma-separated events')
    .option('--active', 'Mark webhook as active')
    .option('--inactive', 'Mark webhook as inactive'))
    .action(async (vaultId: string, webhookId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      if (!_opts.url && !_opts.events && !_opts.active && !_opts.inactive) {
        out.error('Must specify at least one update option (--url, --events, --active, or --inactive)');
        process.exitCode = 2;
        return;
      }

      out.startSpinner('Updating webhook...');
      try {
        const client = await getClientAsync();
        const params: UpdateWebhookParams = {};
        if (_opts.url) params.url = String(_opts.url);
        if (_opts.events) params.events = String(_opts.events).split(',').map((e: string) => e.trim());
        if (_opts.active) params.isActive = true;
        if (_opts.inactive) params.isActive = false;

        const updated = await client.webhooks.update(vaultId, webhookId, params);
        out.success('Webhook updated successfully', {
          url: updated.url,
          events: updated.events.join(', '),
          isActive: updated.isActive,
        });
      } catch (err) {
        handleError(out, err, 'Failed to update webhook');
      }
    });

  addGlobalFlags(webhooks.command('delete')
    .description('Delete a webhook')
    .argument('<vaultId>', 'Vault ID')
    .argument('<webhookId>', 'Webhook ID'))
    .action(async (vaultId: string, webhookId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Deleting webhook...');
      try {
        const client = await getClientAsync();
        await client.webhooks.delete(vaultId, webhookId);
        out.success('Webhook deleted successfully', { id: webhookId, deleted: true });
      } catch (err) {
        handleError(out, err, 'Failed to delete webhook');
      }
    });

  addGlobalFlags(webhooks.command('deliveries')
    .description('List recent deliveries for a webhook')
    .argument('<vaultId>', 'Vault ID')
    .argument('<webhookId>', 'Webhook ID'))
    .action(async (vaultId: string, webhookId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching deliveries...');
      try {
        const client = await getClientAsync();
        const deliveries = await client.webhooks.listDeliveries(vaultId, webhookId);
        out.stopSpinner();
        out.list(
          deliveries.map(d => ({
            id: d.id,
            statusCode: d.statusCode,
            attempt: d.attempt,
            error: d.error || null,
            deliveredAt: d.deliveredAt || null,
            createdAt: d.createdAt,
          })),
          {
            emptyMessage: 'No deliveries found.',
            columns: [
              { key: 'statusCode', header: 'Status' },
              { key: 'id', header: 'ID' },
              { key: 'attempt', header: 'Attempt' },
              { key: 'createdAt', header: 'Time' },
            ],
            textFn: (d) => {
              const statusStr = d.statusCode !== null
                ? (Number(d.statusCode) < 300 ? chalk.green(String(d.statusCode)) : chalk.red(String(d.statusCode)))
                : chalk.red('FAILED');
              const lines = [`  ${statusStr}  ${String(d.id)}  (attempt ${String(d.attempt)})`];
              if (d.error) lines.push(`  Error: ${chalk.red(String(d.error))}`);
              if (d.deliveredAt) lines.push(`  Delivered: ${new Date(String(d.deliveredAt)).toLocaleString()}`);
              lines.push(`  Created: ${new Date(String(d.createdAt)).toLocaleString()}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch deliveries');
      }
    });
}
