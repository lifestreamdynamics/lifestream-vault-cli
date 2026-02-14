import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { generateVaultKey } from '@lifestream-vault/sdk';
import { createCredentialManager } from '../lib/credential-manager.js';

export function registerVaultCommands(program: Command): void {
  const vaults = program.command('vaults').description('Create, list, and inspect document vaults');

  addGlobalFlags(vaults.command('list')
    .description('List all vaults accessible to the current user'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching vaults...');
      try {
        const client = getClient();
        const vaultList = await client.vaults.list();
        out.stopSpinner();
        out.list(
          vaultList.map(v => ({ name: v.name, slug: v.slug, encrypted: v.encryptionEnabled ? 'yes' : 'no', description: v.description || 'No description', id: v.id })),
          {
            emptyMessage: 'No vaults found.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'slug', header: 'Slug' },
              { key: 'encrypted', header: 'Encrypted' },
              { key: 'description', header: 'Description' },
              { key: 'id', header: 'ID' },
            ],
            textFn: (v) => {
              const encIcon = v.encrypted === 'yes' ? chalk.green(' [encrypted]') : '';
              return `${chalk.cyan(String(v.name))} ${chalk.dim(`(${String(v.slug)})`)}${encIcon} -- ${String(v.description)}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch vaults');
      }
    });

  addGlobalFlags(vaults.command('get')
    .description('Show detailed information about a vault')
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching vault...');
      try {
        const client = getClient();
        const vault = await client.vaults.get(vaultId);
        out.stopSpinner();
        out.record({
          name: vault.name,
          slug: vault.slug,
          id: vault.id,
          description: vault.description,
          encrypted: vault.encryptionEnabled ? 'yes' : 'no',
          createdAt: vault.createdAt,
          updatedAt: vault.updatedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch vault');
      }
    });

  addGlobalFlags(vaults.command('create')
    .description('Create a new vault')
    .argument('<name>', 'Vault name (used to generate the URL slug)')
    .option('-d, --description <desc>', 'Vault description')
    .option('--encrypted', 'Enable client-side encryption (AES-256-GCM)')
    .addHelpText('after', `
EXAMPLES
  lsvault vaults create "My Notes"
  lsvault vaults create "Work Journal" --description "Daily work log"
  lsvault vaults create "Secrets" --encrypted`))
    .action(async (name: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating vault...');
      try {
        const client = getClient();
        const isEncrypted = _opts.encrypted === true;
        const vault = await client.vaults.create({
          name,
          description: _opts.description as string | undefined,
          encryptionEnabled: isEncrypted,
        });

        if (isEncrypted) {
          const key = generateVaultKey();
          const credManager = createCredentialManager();
          await credManager.saveVaultKey(vault.id, key);

          out.success(`Encrypted vault created: ${chalk.cyan(vault.name)} (${vault.slug})`, {
            id: vault.id,
            name: vault.name,
            slug: vault.slug,
            encrypted: true,
            vaultKey: key,
          });
          out.warn('IMPORTANT: Save this encryption key securely. If lost, your data cannot be recovered.');
          out.status(`Vault Key: ${chalk.green(key)}`);
          out.status(chalk.dim('The key has been saved to your credential store.'));
          out.status(chalk.dim('You can export it later with: lsvault vaults export-key ' + vault.id));
          out.warn('Encrypted vaults disable: full-text search, AI features, hooks, and webhooks.');
        } else {
          out.success(`Vault created: ${chalk.cyan(vault.name)} (${vault.slug})`, {
            id: vault.id,
            name: vault.name,
            slug: vault.slug,
          });
        }
      } catch (err) {
        handleError(out, err, 'Failed to create vault');
      }
    });

  addGlobalFlags(vaults.command('export-key')
    .description('Export the encryption key for an encrypted vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const credManager = createCredentialManager();
        const key = await credManager.getVaultKey(vaultId);
        if (!key) {
          out.error('No encryption key found for vault ' + vaultId);
          out.status(chalk.dim('Keys can be imported with: lsvault vaults import-key <vaultId> --key <key>'));
          process.exitCode = 1;
          return;
        }
        out.raw(key + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to export vault key');
      }
    });

  addGlobalFlags(vaults.command('import-key')
    .description('Import an encryption key for an encrypted vault')
    .argument('<vaultId>', 'Vault ID')
    .requiredOption('--key <key>', 'Encryption key (64-character hex string)'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const keyValue = _opts.key as string;
        if (!/^[0-9a-f]{64}$/.test(keyValue)) {
          out.error('Invalid key format. Expected a 64-character hex string (256 bits).');
          process.exitCode = 1;
          return;
        }
        const credManager = createCredentialManager();
        await credManager.saveVaultKey(vaultId, keyValue);
        out.success('Vault encryption key saved successfully.', { vaultId });
      } catch (err) {
        handleError(out, err, 'Failed to import vault key');
      }
    });
}
