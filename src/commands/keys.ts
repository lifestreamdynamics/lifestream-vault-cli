import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { CreateApiKeyParams, UpdateApiKeyParams } from '@lifestreamdynamics/vault-sdk';

export function registerKeyCommands(program: Command): void {
  const keys = program.command('keys').description('Create, list, update, and revoke API keys');

  addGlobalFlags(keys.command('list')
    .description('List all API keys for the current user'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching API keys...');
      try {
        const client = getClient();
        const apiKeys = await client.apiKeys.list();
        out.stopSpinner();
        out.list(
          apiKeys.map(key => ({
            name: key.name,
            prefix: key.prefix,
            scopes: key.scopes.join(', '),
            isActive: key.isActive,
            expiresAt: key.expiresAt || null,
            lastUsedAt: key.lastUsedAt || null,
          })),
          {
            emptyMessage: 'No API keys found.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'prefix', header: 'Prefix' },
              { key: 'scopes', header: 'Scopes' },
              { key: 'isActive', header: 'Active' },
            ],
            textFn: (key) => {
              const lines = [chalk.cyan(`  ${String(key.name)}`)];
              lines.push(`  Prefix: ${String(key.prefix)}`);
              lines.push(`  Scopes: ${String(key.scopes)}`);
              lines.push(`  Active: ${key.isActive ? chalk.green('Yes') : chalk.red('No')}`);
              if (key.expiresAt) lines.push(`  Expires: ${new Date(String(key.expiresAt)).toLocaleString()}`);
              if (key.lastUsedAt) lines.push(`  Last used: ${new Date(String(key.lastUsedAt)).toLocaleString()}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch API keys');
      }
    });

  addGlobalFlags(keys.command('get')
    .description('Show detailed information about an API key')
    .argument('<keyId>', 'API key ID'))
    .action(async (keyId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching API key...');
      try {
        const client = getClient();
        const key = await client.apiKeys.get(keyId);
        out.stopSpinner();
        out.record({
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          scopes: key.scopes.join(', '),
          isActive: key.isActive,
          vaultId: key.vaultId || null,
          expiresAt: key.expiresAt || null,
          lastUsedAt: key.lastUsedAt || null,
          createdAt: key.createdAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch API key');
      }
    });

  addGlobalFlags(keys.command('create')
    .description('Create a new API key and display it (shown only once)')
    .argument('<name>', 'Descriptive name for the API key')
    .option('--scopes <scopes>', 'Comma-separated scopes (e.g., read,write)', 'read,write')
    .option('--vault <vaultId>', 'Restrict key to a specific vault')
    .option('--expires <date>', 'Expiry date (ISO 8601 format, e.g., 2025-12-31)')
    .addHelpText('after', `
EXAMPLES
  lsvault keys create "CI Deploy Key" --scopes read,write
  lsvault keys create "Read Only" --scopes read --vault abc123
  lsvault keys create "Temp Key" --expires 2025-06-01`))
    .action(async (name: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating API key...');
      try {
        const client = getClient();
        const params: CreateApiKeyParams = {
          name,
          scopes: String(_opts.scopes || 'read,write').split(',').map((s: string) => s.trim()),
        };
        if (_opts.vault) params.vaultId = String(_opts.vault);
        if (_opts.expires) params.expiresAt = String(_opts.expires);

        const apiKey = await client.apiKeys.create(params);
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({ key: apiKey.key, name: apiKey.name, prefix: apiKey.prefix, scopes: apiKey.scopes.join(', ') });
        } else {
          out.warn('\nIMPORTANT: Save this key securely. It cannot be retrieved later.\n');
          process.stdout.write(chalk.green.bold(`API Key: ${apiKey.key}\n`));
          process.stdout.write(`\nName:   ${apiKey.name}\n`);
          process.stdout.write(`Prefix: ${apiKey.prefix}\n`);
          process.stdout.write(`Scopes: ${apiKey.scopes.join(', ')}\n`);
        }
      } catch (err) {
        handleError(out, err, 'Failed to create API key');
      }
    });

  addGlobalFlags(keys.command('update')
    .description('Update an API key name or active status')
    .argument('<keyId>', 'API key ID')
    .option('--name <name>', 'New name for the key')
    .option('--active', 'Re-enable the key')
    .option('--inactive', 'Disable the key without revoking it'))
    .action(async (keyId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      if (!_opts.name && !_opts.active && !_opts.inactive) {
        out.error('Must specify at least one update option (--name, --active, or --inactive)');
        process.exitCode = 2;
        return;
      }

      out.startSpinner('Updating API key...');
      try {
        const client = getClient();
        const params: UpdateApiKeyParams = {};
        if (_opts.name) params.name = String(_opts.name);
        if (_opts.active) params.isActive = true;
        if (_opts.inactive) params.isActive = false;

        const updated = await client.apiKeys.update(keyId, params);
        out.success('API key updated successfully', { name: updated.name, isActive: updated.isActive });
      } catch (err) {
        handleError(out, err, 'Failed to update API key');
      }
    });

  addGlobalFlags(keys.command('revoke')
    .description('Permanently revoke and delete an API key')
    .argument('<keyId>', 'API key ID'))
    .action(async (keyId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Revoking API key...');
      try {
        const client = getClient();
        await client.apiKeys.delete(keyId);
        out.success('API key revoked successfully', { id: keyId, revoked: true });
      } catch (err) {
        handleError(out, err, 'Failed to revoke API key');
      }
    });
}
