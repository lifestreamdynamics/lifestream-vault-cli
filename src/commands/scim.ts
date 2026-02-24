import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerScimCommands(program: Command): void {
  const scim = program.command('scim').description('SCIM 2.0 user provisioning management (requires scimToken)');

  // ── list-users ────────────────────────────────────────────────────────────

  addGlobalFlags(scim.command('list-users')
    .description('List SCIM-provisioned users')
    .option('--filter <expr>', 'SCIM filter expression (e.g. \'userName eq "user@example.com"\')')
    .option('--start-index <n>', 'Pagination start index (1-based)', parseInt)
    .option('--count <n>', 'Number of results per page (max 100)', parseInt))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching SCIM users...');
      try {
        const client = await getClientAsync();
        if (!client.scim) {
          out.error('SCIM resource is not configured. Provide a scimToken when creating the client.');
          process.exitCode = 1;
          return;
        }
        const result = await client.scim.listUsers({
          filter: _opts.filter as string | undefined,
          startIndex: _opts.startIndex as number | undefined,
          count: _opts.count as number | undefined,
        });
        out.stopSpinner();

        if (flags.output !== 'json') {
          out.status(chalk.dim(`Total: ${result.totalResults}  Start: ${result.startIndex}  Page: ${result.itemsPerPage}`));
        }

        out.list(
          result.Resources.map((u) => ({
            id: u.id,
            userName: u.userName,
            name: u.name.formatted,
            active: u.active ? 'yes' : 'no',
            externalId: u.externalId ?? '',
          })),
          {
            emptyMessage: 'No SCIM users found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'userName', header: 'Username' },
              { key: 'name', header: 'Name' },
              { key: 'active', header: 'Active' },
              { key: 'externalId', header: 'External ID' },
            ],
            textFn: (u) =>
              `${chalk.cyan(String(u.userName))} ${chalk.dim(`(${String(u.id)})`)} — ${u.name} — ${u.active === 'yes' ? chalk.green('active') : chalk.red('inactive')}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to list SCIM users');
      }
    });

  // ── get-user ──────────────────────────────────────────────────────────────

  addGlobalFlags(scim.command('get-user')
    .description('Get a SCIM user by internal ID')
    .argument('<id>', 'Internal user ID'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching SCIM user...');
      try {
        const client = await getClientAsync();
        if (!client.scim) {
          out.error('SCIM resource is not configured. Provide a scimToken when creating the client.');
          process.exitCode = 1;
          return;
        }
        const user = await client.scim.getUser(id);
        out.stopSpinner();
        out.record({
          id: user.id,
          userName: user.userName,
          givenName: user.name.givenName,
          familyName: user.name.familyName,
          email: user.emails[0]?.value ?? '',
          active: user.active,
          externalId: user.externalId,
          created: user.meta.created,
          lastModified: user.meta.lastModified,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch SCIM user');
      }
    });

  // ── create-user ───────────────────────────────────────────────────────────

  addGlobalFlags(scim.command('create-user')
    .description('Provision a new user via SCIM')
    .requiredOption('--user-name <userName>', 'Login name (email address)')
    .requiredOption('--email <email>', 'Primary email address')
    .option('--given-name <name>', 'First/given name')
    .option('--family-name <name>', 'Last/family name')
    .option('--external-id <id>', 'External IdP subject ID'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating SCIM user...');
      try {
        const client = await getClientAsync();
        if (!client.scim) {
          out.error('SCIM resource is not configured. Provide a scimToken when creating the client.');
          process.exitCode = 1;
          return;
        }
        const created = await client.scim.createUser({
          userName: _opts.userName as string,
          emails: [{ value: _opts.email as string, primary: true }],
          name: {
            givenName: _opts.givenName as string | undefined,
            familyName: _opts.familyName as string | undefined,
          },
          externalId: _opts.externalId as string | undefined,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(created, null, 2) + '\n');
        } else {
          out.raw(chalk.green(`SCIM user created: ${created.userName} (${created.id})`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to create SCIM user');
      }
    });

  // ── update-user ───────────────────────────────────────────────────────────

  addGlobalFlags(scim.command('update-user')
    .description('Update a SCIM user (full replace)')
    .argument('<id>', 'Internal user ID')
    .option('--user-name <userName>', 'Updated login name')
    .option('--email <email>', 'Updated primary email')
    .option('--given-name <name>', 'Updated first/given name')
    .option('--family-name <name>', 'Updated last/family name'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      const data: Record<string, unknown> = {};
      if (_opts.userName) data.userName = _opts.userName;
      if (_opts.email) data.emails = [{ value: _opts.email, primary: true }];
      if (_opts.givenName || _opts.familyName) {
        data.name = {
          givenName: _opts.givenName,
          familyName: _opts.familyName,
        };
      }

      if (Object.keys(data).length === 0) {
        out.error('No updates specified. Use --user-name, --email, --given-name, or --family-name.');
        process.exitCode = 2;
        return;
      }

      out.startSpinner('Updating SCIM user...');
      try {
        const client = await getClientAsync();
        if (!client.scim) {
          out.error('SCIM resource is not configured. Provide a scimToken when creating the client.');
          process.exitCode = 1;
          return;
        }
        const updated = await client.scim.updateUser(id, data);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.raw(chalk.green(`SCIM user updated: ${updated.userName} (${updated.id})`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to update SCIM user');
      }
    });

  // ── delete-user ───────────────────────────────────────────────────────────

  addGlobalFlags(scim.command('delete-user')
    .description('Deprovision a SCIM user (removes SSO bindings)')
    .argument('<id>', 'Internal user ID')
    .option('--force', 'Skip confirmation prompt'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.force) {
        out.raw(chalk.yellow(`Pass --force to deprovision SCIM user ${id}.`) + '\n');
        return;
      }
      out.startSpinner('Deprovisioning SCIM user...');
      try {
        const client = await getClientAsync();
        if (!client.scim) {
          out.error('SCIM resource is not configured. Provide a scimToken when creating the client.');
          process.exitCode = 1;
          return;
        }
        await client.scim.deleteUser(id);
        out.stopSpinner();
        out.raw(chalk.green(`SCIM user ${id} deprovisioned.`) + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to deprovision SCIM user');
      }
    });

  // ── service-config ────────────────────────────────────────────────────────

  addGlobalFlags(scim.command('service-config')
    .description('Show SCIM service provider capabilities'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching SCIM service provider config...');
      try {
        const client = await getClientAsync();
        if (!client.scim) {
          out.error('SCIM resource is not configured. Provide a scimToken when creating the client.');
          process.exitCode = 1;
          return;
        }
        const config = await client.scim.getServiceProviderConfig();
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(config, null, 2) + '\n');
        } else {
          out.record({
            patch: String(config.patch.supported),
            bulk: String(config.bulk.supported),
            filter: String(config.filter.supported),
            filterMaxResults: String(config.filter.maxResults),
            changePassword: String(config.changePassword.supported),
            sort: String(config.sort.supported),
          });
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch SCIM service provider config');
      }
    });
}
