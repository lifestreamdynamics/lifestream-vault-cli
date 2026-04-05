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
          list.map(d => ({ id: d.id, domain: d.domain, status: d.status, createdAt: d.createdAt })),
          {
            emptyMessage: 'No custom domains found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'domain', header: 'Domain' },
              { key: 'status', header: 'Status' },
              { key: 'createdAt', header: 'Created' },
            ],
            textFn: (d) => `${chalk.cyan(String(d.domain))} — ${d.status === 'verified' ? chalk.green('verified') : chalk.yellow(String(d.status))}`,
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
        out.record({ id: d.id, domain: d.domain, status: d.status, sslStatus: d.sslStatus, verificationToken: d.verificationToken, createdAt: d.createdAt });
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
          process.stdout.write(`  ${chalk.cyan('_lsv-verify.' + d.domain)} TXT ${chalk.green(d.verificationToken)}\n`);
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
    .argument('<domainId>', 'Domain ID')
    .option('-y, --yes', 'Skip confirmation prompt'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes) {
        out.status(chalk.yellow(`Pass --yes to remove custom domain ${domainId}.`));
        return;
      }
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
    .description('Trigger DNS verification check for a custom domain')
    .argument('<domainId>', 'Domain ID')
    .addHelpText('after', '\n  Submits a verification request to the server, which checks your DNS TXT record.\n  Use "check" to read the current verification status without triggering a new check.'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Verifying custom domain...');
      try {
        const client = await getClientAsync();
        const d = await client.customDomains.verify(domainId);
        out.success(`Domain ${d.status === 'verified' ? 'verified' : 'not yet verified'}: ${d.domain}`, { id: d.id, domain: d.domain, status: d.status });
      } catch (err) {
        handleError(out, err, 'Failed to verify custom domain');
      }
    });

  addGlobalFlags(domains.command('check')
    .description('Show current DNS verification status for a custom domain')
    .argument('<domainId>', 'Domain ID')
    .addHelpText('after', '\n  Returns the current verification status without triggering a new check.\n  Use "verify" to submit a fresh DNS verification request to the server.'))
    .action(async (domainId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Checking DNS...');
      try {
        const client = await getClientAsync();
        const result = await client.customDomains.checkDns(domainId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.record(result as unknown as Record<string, unknown>);
        } else {
          process.stdout.write(`Domain: ${chalk.cyan(result.domain)}\n\n`);
          for (const check of result.checks) {
            const icon = check.status === 'pass' ? chalk.green('✓') : chalk.red('✗');
            process.stdout.write(`${icon} ${chalk.bold(check.type)} — ${check.hostname}\n`);
            process.stdout.write(`  Expected : ${check.expected}\n`);
            process.stdout.write(`  Found    : ${check.found.length > 0 ? check.found.join(', ') : chalk.yellow('(none)')}\n`);
            process.stdout.write(`  Status   : ${check.status === 'pass' ? chalk.green('pass') : chalk.red('fail')}\n\n`);
          }
          const allPassed = result.checks.length > 0 && result.checks.every(c => c.status === 'pass');
          if (allPassed) {
            process.stdout.write(chalk.green('All DNS checks passed.\n'));
          } else {
            process.stdout.write(chalk.yellow('One or more DNS checks failed. Allow time for propagation and try again.\n'));
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to check DNS');
      }
    });
}
