import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { generateVaultKey } from '@lifestreamdynamics/vault-sdk';
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
        const client = await getClientAsync();
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
        const client = await getClientAsync();
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
        const client = await getClientAsync();
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

  // vault tree
  addGlobalFlags(vaults.command('tree')
    .description('Show vault file tree')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching vault tree...');
      try {
        const client = await getClientAsync();
        const tree = await client.vaults.getTree(vaultId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(tree, null, 2) + '\n');
        } else {
          function printNode(node: { name: string; type: string; path: string; children?: typeof tree }, depth: number): void {
            const indent = '  '.repeat(depth);
            const icon = node.type === 'directory' ? chalk.yellow('📁') : chalk.cyan('📄');
            process.stdout.write(`${indent}${icon} ${node.name}\n`);
            if (node.children) {
              for (const child of node.children) printNode(child, depth + 1);
            }
          }
          for (const node of tree) printNode(node, 0);
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch vault tree');
      }
    });

  // vault archive
  addGlobalFlags(vaults.command('archive')
    .description('Archive a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Archiving vault...');
      try {
        const client = await getClientAsync();
        const vault = await client.vaults.archive(vaultId);
        out.success(`Vault archived: ${vault.name}`, { id: vault.id, name: vault.name, isArchived: vault.isArchived });
      } catch (err) {
        handleError(out, err, 'Failed to archive vault');
      }
    });

  // vault unarchive
  addGlobalFlags(vaults.command('unarchive')
    .description('Unarchive a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Unarchiving vault...');
      try {
        const client = await getClientAsync();
        const vault = await client.vaults.unarchive(vaultId);
        out.success(`Vault unarchived: ${vault.name}`, { id: vault.id, name: vault.name, isArchived: vault.isArchived });
      } catch (err) {
        handleError(out, err, 'Failed to unarchive vault');
      }
    });

  // vault transfer
  addGlobalFlags(vaults.command('transfer')
    .description('Transfer vault ownership to another user')
    .argument('<vaultId>', 'Vault ID')
    .argument('<targetEmail>', 'Email of the user to transfer to'))
    .action(async (vaultId: string, targetEmail: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Transferring vault...');
      try {
        const client = await getClientAsync();
        const vault = await client.vaults.transfer(vaultId, targetEmail);
        out.success(`Vault transferred to ${targetEmail}`, { id: vault.id, name: vault.name });
      } catch (err) {
        handleError(out, err, 'Failed to transfer vault');
      }
    });

  // vault export-vault subgroup
  const exportVault = vaults.command('export-vault').description('Vault export operations');

  addGlobalFlags(exportVault.command('create')
    .description('Create a vault export')
    .argument('<vaultId>', 'Vault ID')
    .option('--metadata', 'Include metadata in export')
    .option('--format <fmt>', 'Export format', 'zip'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating export...');
      try {
        const client = await getClientAsync();
        const exp = await client.vaults.createExport(vaultId, {
          includeMetadata: _opts.metadata === true,
          format: (_opts.format as 'zip') || 'zip',
        });
        out.success('Export created', { id: exp.id, status: exp.status, format: exp.format });
      } catch (err) {
        handleError(out, err, 'Failed to create export');
      }
    });

  addGlobalFlags(exportVault.command('list')
    .description('List vault exports')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching exports...');
      try {
        const client = await getClientAsync();
        const exports = await client.vaults.listExports(vaultId);
        out.stopSpinner();
        out.list(
          exports.map(e => ({ id: e.id, status: e.status, format: e.format, createdAt: e.createdAt, completedAt: e.completedAt || '' })),
          {
            emptyMessage: 'No exports found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'status', header: 'Status' },
              { key: 'format', header: 'Format' },
              { key: 'createdAt', header: 'Created' },
              { key: 'completedAt', header: 'Completed' },
            ],
            textFn: (e) => `${chalk.cyan(String(e.id))} [${String(e.status)}] ${String(e.format)} created: ${String(e.createdAt)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to list exports');
      }
    });

  addGlobalFlags(exportVault.command('download')
    .description('Download a vault export')
    .argument('<vaultId>', 'Vault ID')
    .argument('<exportId>', 'Export ID')
    .requiredOption('--file <path>', 'Output file path'))
    .action(async (vaultId: string, exportId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Downloading export...');
      try {
        const { writeFile } = await import('node:fs/promises');
        const client = await getClientAsync();
        const blob = await client.vaults.downloadExport(vaultId, exportId);
        const buffer = Buffer.from(await blob.arrayBuffer());
        await writeFile(_opts.file as string, buffer);
        out.success(`Export downloaded to ${String(_opts.file)}`, { path: _opts.file, size: buffer.length });
      } catch (err) {
        handleError(out, err, 'Failed to download export');
      }
    });

  // vault mfa subgroup
  const mfa = vaults.command('mfa').description('Vault MFA configuration');

  addGlobalFlags(mfa.command('get')
    .description('Get vault MFA configuration')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching MFA config...');
      try {
        const client = await getClientAsync();
        const config = await client.vaults.getMfaConfig(vaultId);
        out.stopSpinner();
        out.record({
          mfaRequired: config.mfaRequired,
          sessionWindowMinutes: config.sessionWindowMinutes,
          userVerified: config.userVerified,
          verificationExpiresAt: config.verificationExpiresAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch MFA config');
      }
    });

  addGlobalFlags(mfa.command('set')
    .description('Set vault MFA configuration')
    .argument('<vaultId>', 'Vault ID')
    .option('--require', 'Require MFA for vault access')
    .option('--no-require', 'Disable MFA requirement')
    .option('--window <minutes>', 'Session window in minutes', '60'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating MFA config...');
      try {
        const client = await getClientAsync();
        const config = await client.vaults.setMfaConfig(vaultId, {
          mfaRequired: _opts.require !== false,
          sessionWindowMinutes: parseInt(String(_opts.window || '60'), 10),
        });
        out.success('MFA config updated', { mfaRequired: config.mfaRequired, sessionWindowMinutes: config.sessionWindowMinutes });
      } catch (err) {
        handleError(out, err, 'Failed to update MFA config');
      }
    });

  addGlobalFlags(mfa.command('verify')
    .description('Verify MFA for vault access')
    .argument('<vaultId>', 'Vault ID')
    .requiredOption('--method <totp|backup_code>', 'MFA method')
    .requiredOption('--code <code>', 'MFA code'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Verifying MFA...');
      try {
        const client = await getClientAsync();
        const result = await client.vaults.verifyMfa(vaultId, {
          method: _opts.method as 'totp' | 'backup_code',
          code: _opts.code as string,
        });
        out.success('MFA verified', { verified: result.verified, expiresAt: result.expiresAt });
      } catch (err) {
        handleError(out, err, 'Failed to verify MFA');
      }
    });
}
