import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function registerSubscriptionCommands(program: Command): void {
  const sub = program.command('subscription').description('View plans, manage subscription, and access billing');

  addGlobalFlags(sub.command('status')
    .description('Show current plan, active status, and resource usage'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching subscription...');
      try {
        const client = getClient();
        const data = await client.subscription.get();
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({
            tier: data.subscription.tier,
            isActive: data.subscription.isActive,
            expiresAt: data.subscription.expiresAt,
            ...data.usage,
          });
        } else {
          const s = data.subscription;
          process.stdout.write(`Plan:       ${chalk.green(s.tier)}\n`);
          process.stdout.write(`Active:     ${s.isActive ? chalk.green('yes') : chalk.red('no')}\n`);
          process.stdout.write(`Expires:    ${s.expiresAt || chalk.dim('never')}\n`);
          process.stdout.write('\n');
          process.stdout.write(chalk.dim('Usage:') + '\n');
          process.stdout.write(`  Vaults:            ${data.usage.vaultCount}\n`);
          process.stdout.write(`  Storage:           ${formatBytes(data.usage.totalStorageBytes)}\n`);
          process.stdout.write(`  API calls today:   ${data.usage.apiCallsToday}\n`);
          process.stdout.write(`  AI tokens:         ${data.usage.aiTokens}\n`);
          process.stdout.write(`  Hook executions:   ${data.usage.hookExecutions}\n`);
          process.stdout.write(`  Webhook deliveries: ${data.usage.webhookDeliveries}\n`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch subscription');
      }
    });

  addGlobalFlags(sub.command('plans')
    .description('List available subscription plans and their limits'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching plans...');
      try {
        const client = getClient();
        const plans = await client.subscription.listPlans();
        out.stopSpinner();
        out.list(
          plans.map(p => ({ name: p.name, tier: p.tier, ...p.limits })),
          {
            emptyMessage: 'No plans available.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'tier', header: 'Tier' },
            ],
            textFn: (p) => {
              const lines = [`${chalk.cyan(String(p.name))} (${String(p.tier)})`];
              for (const [key, val] of Object.entries(p)) {
                if (key !== 'name' && key !== 'tier') {
                  lines.push(`  ${key}: ${String(val)}`);
                }
              }
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch plans');
      }
    });

  addGlobalFlags(sub.command('upgrade')
    .description('Start a checkout session to upgrade your plan')
    .argument('<tier>', 'Target tier: pro or business')
    .requiredOption('--return-url <url>', 'URL to redirect after checkout')
    .addHelpText('after', `
EXAMPLES
  lsvault subscription upgrade pro --return-url https://app.example.com/settings`))
    .action(async (tier: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating checkout session...');
      try {
        const client = getClient();
        const session = await client.subscription.createCheckoutSession(tier, String(_opts.returnUrl));
        out.success('Checkout session created', { url: session.url });
        if (flags.output === 'text') {
          process.stdout.write(`Open this URL to complete upgrade: ${chalk.cyan(session.url)}\n`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to create checkout session');
      }
    });

  addGlobalFlags(sub.command('cancel')
    .description('Cancel your current subscription')
    .option('--reason <text>', 'Reason for cancellation'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Cancelling subscription...');
      try {
        const client = getClient();
        await client.subscription.cancel(_opts.reason as string | undefined);
        out.success('Subscription cancelled', { cancelled: true });
      } catch (err) {
        handleError(out, err, 'Failed to cancel subscription');
      }
    });

  addGlobalFlags(sub.command('portal')
    .description('Get a URL to the billing management portal')
    .requiredOption('--return-url <url>', 'URL to redirect after portal session'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating portal session...');
      try {
        const client = getClient();
        const portal = await client.subscription.createPortalSession(String(_opts.returnUrl));
        out.success('Portal session created', { url: portal.url });
        if (flags.output === 'text') {
          process.stdout.write(`Open this URL to manage billing: ${chalk.cyan(portal.url)}\n`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to create portal session');
      }
    });

  addGlobalFlags(sub.command('invoices')
    .description('List past invoices and payment history'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching invoices...');
      try {
        const client = getClient();
        const invoices = await client.subscription.listInvoices();
        out.stopSpinner();
        out.list(
          invoices.map(inv => ({
            date: inv.createdAt,
            amount: `${(inv.amount / 100).toFixed(2)} ${inv.currency.toUpperCase()}`,
            status: inv.status,
            invoiceUrl: inv.invoiceUrl || null,
          })),
          {
            emptyMessage: 'No invoices found.',
            columns: [
              { key: 'date', header: 'Date' },
              { key: 'amount', header: 'Amount' },
              { key: 'status', header: 'Status' },
            ],
            textFn: (inv) => {
              const status = String(inv.status) === 'paid' ? chalk.green(String(inv.status)) : chalk.yellow(String(inv.status));
              return `${String(inv.date)}  ${String(inv.amount)}  ${status}${inv.invoiceUrl ? `  ${chalk.dim(String(inv.invoiceUrl))}` : ''}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch invoices');
      }
    });
}
