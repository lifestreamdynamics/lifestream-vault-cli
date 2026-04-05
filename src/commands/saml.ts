import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerSamlCommands(program: Command): void {
  const saml = program.command('saml')
    .description('SAML SSO configuration management (requires admin role)')
    .addHelpText('after', '\nNOTE: SAML commands require JWT authentication with admin role.\nRun "lsvault auth login" to authenticate first.');

  // ── list-configs ─────────────────────────────────────────────────────────

  addGlobalFlags(saml.command('list-configs')
    .description('List all SSO configurations'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching SSO configs...');
      try {
        const client = await getClientAsync();
        const configs = await client.saml.listConfigs();
        out.stopSpinner();
        if (configs.length === 0 && flags.output !== 'json') {
          out.raw('No SSO configurations found.\n');
        } else {
          out.list(
            configs.map((c) => ({
              id: c.id,
              domain: c.domain,
              slug: c.slug,
              entityId: c.entityId,
              ssoUrl: c.ssoUrl,
            })),
            {
              columns: [
                { key: 'id', header: 'ID' },
                { key: 'domain', header: 'Domain' },
                { key: 'slug', header: 'Slug' },
                { key: 'entityId', header: 'Entity ID' },
                { key: 'ssoUrl', header: 'SSO URL' },
              ],
              textFn: (c) =>
                `${chalk.cyan(String(c.domain))} ${chalk.dim(`[${String(c.slug)}]`)} — ${chalk.dim(String(c.ssoUrl))}`,
            },
          );
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch SSO configs');
      }
    });

  // ── get-config ───────────────────────────────────────────────────────────

  addGlobalFlags(saml.command('get-config')
    .description('Get a single SSO configuration by ID')
    .argument('<id>', 'SSO config ID'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching SSO config...');
      try {
        const client = await getClientAsync();
        const config = await client.saml.getConfig(id);
        out.stopSpinner();
        out.record({
          id: config.id,
          domain: config.domain,
          slug: config.slug,
          entityId: config.entityId,
          ssoUrl: config.ssoUrl,
          spEntityId: config.spEntityId,
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch SSO config');
      }
    });

  // ── create-config ─────────────────────────────────────────────────────────

  addGlobalFlags(saml.command('create-config')
    .description('Create a new SSO configuration')
    .requiredOption('--domain <domain>', 'Customer/tenant domain (e.g. acmecorp.com)')
    .requiredOption('--slug <slug>', 'URL slug for SAML endpoints (e.g. acmecorp)')
    .requiredOption('--entity-id <entityId>', 'Identity Provider entity ID URI')
    .requiredOption('--sso-url <ssoUrl>', 'Identity Provider Single Sign-On URL')
    .requiredOption('--certificate <cert>', 'X.509 certificate (PEM-encoded)')
    .option('--sp-entity-id <spEntityId>', 'Optional Service Provider entity ID override'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating SSO config...');
      try {
        const client = await getClientAsync();
        const created = await client.saml.createConfig({
          domain: _opts.domain as string,
          slug: _opts.slug as string,
          entityId: _opts.entityId as string,
          ssoUrl: _opts.ssoUrl as string,
          certificate: _opts.certificate as string,
          spEntityId: _opts.spEntityId as string | undefined,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(created, null, 2) + '\n');
        } else {
          out.raw(chalk.green(`SSO config created for ${created.domain} (${created.id})`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to create SSO config');
      }
    });

  // ── update-config ─────────────────────────────────────────────────────────

  addGlobalFlags(saml.command('update-config')
    .description('Update an existing SSO configuration')
    .argument('<id>', 'SSO config ID')
    .option('--domain <domain>', 'Updated customer domain')
    .option('--slug <slug>', 'Updated URL slug')
    .option('--entity-id <entityId>', 'Updated Identity Provider entity ID')
    .option('--sso-url <ssoUrl>', 'Updated Identity Provider SSO URL')
    .option('--certificate <cert>', 'Updated X.509 certificate')
    .option('--sp-entity-id <spEntityId>', 'Updated Service Provider entity ID'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      const data: Record<string, string> = {};
      if (_opts.domain) data.domain = _opts.domain as string;
      if (_opts.slug) data.slug = _opts.slug as string;
      if (_opts.entityId) data.entityId = _opts.entityId as string;
      if (_opts.ssoUrl) data.ssoUrl = _opts.ssoUrl as string;
      if (_opts.certificate) data.certificate = _opts.certificate as string;
      if (_opts.spEntityId) data.spEntityId = _opts.spEntityId as string;

      if (Object.keys(data).length === 0) {
        out.error('No updates specified. Use --domain, --slug, --entity-id, --sso-url, --certificate, or --sp-entity-id.');
        process.exitCode = 2;
        return;
      }

      out.startSpinner('Updating SSO config...');
      try {
        const client = await getClientAsync();
        const updated = await client.saml.updateConfig(id, data);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.raw(chalk.green(`SSO config updated: ${updated.domain} (${updated.id})`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to update SSO config');
      }
    });

  // ── delete-config ─────────────────────────────────────────────────────────

  addGlobalFlags(saml.command('delete-config')
    .description('Delete an SSO configuration')
    .argument('<id>', 'SSO config ID')
    .option('--force', 'Skip confirmation prompt')
    .option('-y, --yes', 'Alias for --force'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.force && !_opts.yes) {
        out.warn(`Pass --force to delete SSO config ${id}.`);
        process.exitCode = 1;
        return;
      }
      out.startSpinner('Deleting SSO config...');
      try {
        const client = await getClientAsync();
        await client.saml.deleteConfig(id);
        out.stopSpinner();
        out.raw(chalk.green(`SSO config ${id} deleted.`) + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to delete SSO config');
      }
    });

  // ── metadata ──────────────────────────────────────────────────────────────

  addGlobalFlags(saml.command('metadata')
    .description('Show Service Provider metadata XML for an IdP slug')
    .argument('<slug>', 'IdP slug'))
    .action(async (slug: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching SP metadata...');
      try {
        const client = await getClientAsync();
        const xml = await client.saml.getMetadata(slug);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify({ xml }, null, 2) + '\n');
        } else {
          out.raw(xml + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch SP metadata');
      }
    });

  // ── login-url ─────────────────────────────────────────────────────────────

  addGlobalFlags(saml.command('login-url')
    .description('Show the IdP login redirect URL for a slug')
    .argument('<slug>', 'IdP slug'))
    .action(async (slug: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!slug || !slug.trim()) {
        out.error('Slug cannot be empty.');
        process.exitCode = 1;
        return;
      }
      try {
        const client = await getClientAsync();
        const url = client.saml.getLoginUrl(slug);
        if (flags.output === 'json') {
          out.raw(JSON.stringify({ url }, null, 2) + '\n');
        } else {
          out.raw(url + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to build login URL');
      }
    });
}
