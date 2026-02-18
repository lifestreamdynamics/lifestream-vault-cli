import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerCustomDomainCommands(program: Command): void {
  const domains = program.command('custom-domains').description('Manage custom domains for published vaults');

  addGlobalFlags(domains.command('list')
    .description('List custom domains'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching custom domains...');
      try {
        const client = await getClientAsync();
        const list = await client.customDomains.list();
        out.stopSpinner();
        out.list(
          list.map(d => ({ id: d.id, domain: d.domain, verified: d.verified ? 'yes' : 'no', createdAt: d.createdAt })),
          {
            emptyMessage: 'No custom domains found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'domain', header: 'Domain' },
              { key: 'verified', header: 'Verified' },
              { key: 'createdAt', header: 'Created' },
            ],
            textFn: (d) => `${chalk.cyan(String(d.domain))} — ${d.verified === 'yes' ? chalk.green('verified') : chalk.yellow('unverified')}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch custom domains');
      }
    });

  addGlobalFlags(domains.command('get')
    .description('Get a custom domain')
    .argument('<domainId>', 'Domain ID'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching custom domain...');
      try {
        const client = await getClientAsync();
        const d = await client.customDomains.get(domainId);
        out.stopSpinner();
        out.record({ id: d.id, domain: d.domain, verified: d.verified, verificationToken: d.verificationToken, createdAt: d.createdAt });
      } catch (err) {
        handleError(out, err, 'Failed to fetch custom domain');
      }
    });

  addGlobalFlags(domains.command('add')
    .description('Add a custom domain')
    .argument('<domain>', 'Domain name (e.g., docs.example.com)'))
    .action(async (domain: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Adding custom domain...');
      try {
        const client = await getClientAsync();
        const d = await client.customDomains.create({ domain });
        out.success(`Domain added: ${d.domain}`, { id: d.id, domain: d.domain, verificationToken: d.verificationToken });
        if (flags.output !== 'json') {
          process.stdout.write(`\nTo verify, add this DNS TXT record:\n`);
          process.stdout.write(`  ${chalk.cyan('_lsvault-verification.' + d.domain)} TXT ${chalk.green(d.verificationToken)}\n`);
          process.stdout.write(`\nThen run: lsvault custom-domains verify ${d.id}\n`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to add custom domain');
      }
    });

  addGlobalFlags(domains.command('update')
    .description('Update a custom domain')
    .argument('<domainId>', 'Domain ID')
    .requiredOption('--domain <domain>', 'New domain name'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating custom domain...');
      try {
        const client = await getClientAsync();
        const d = await client.customDomains.update(domainId, { domain: _opts.domain as string });
        out.success(`Domain updated: ${d.domain}`, { id: d.id, domain: d.domain });
      } catch (err) {
        handleError(out, err, 'Failed to update custom domain');
      }
    });

  addGlobalFlags(domains.command('remove')
    .description('Remove a custom domain')
    .argument('<domainId>', 'Domain ID'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Removing custom domain...');
      try {
        const client = await getClientAsync();
        await client.customDomains.delete(domainId);
        out.success('Custom domain removed', { id: domainId });
      } catch (err) {
        handleError(out, err, 'Failed to remove custom domain');
      }
    });

  addGlobalFlags(domains.command('verify')
    .description('Verify a custom domain via DNS')
    .argument('<domainId>', 'Domain ID'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Verifying custom domain...');
      try {
        const client = await getClientAsync();
        const d = await client.customDomains.verify(domainId);
        out.success(`Domain ${d.verified ? 'verified' : 'not yet verified'}: ${d.domain}`, { id: d.id, domain: d.domain, verified: d.verified });
      } catch (err) {
        handleError(out, err, 'Failed to verify custom domain');
      }
    });

  addGlobalFlags(domains.command('check')
    .description('Check DNS configuration for a custom domain')
    .argument('<domainId>', 'Domain ID'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Checking DNS...');
      try {
        const client = await getClientAsync();
        const result = await client.customDomains.checkDns(domainId);
        out.stopSpinner();
        out.record({
          domain: result.domain,
          resolved: result.resolved,
          expectedValue: result.expectedValue,
          actualValue: result.actualValue ?? 'N/A',
        });
        if (flags.output !== 'json') {
          if (result.resolved) {
            process.stdout.write(chalk.green('\n✓ DNS configured correctly\n'));
          } else {
            process.stdout.write(chalk.yellow(`\n⚠ DNS not yet propagated. Expected: ${result.expectedValue}\n`));
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to check DNS');
      }
    });
}
