import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { CreateShareLinkParams } from '@lifestream-vault/sdk';

export function registerShareCommands(program: Command): void {
  const shares = program.command('shares').description('Create, list, and revoke document share links');

  addGlobalFlags(shares.command('list')
    .description('List share links for a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<docPath>', 'Document path (e.g., notes/meeting.md)'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching share links...');
      try {
        const client = getClient();
        const links = await client.shares.list(vaultId, docPath);
        out.stopSpinner();
        out.list(
          links.map(link => ({
            id: link.id,
            tokenPrefix: link.tokenPrefix,
            permission: link.permission,
            viewCount: link.viewCount,
            maxViews: link.maxViews || null,
            isActive: link.isActive,
            expiresAt: link.expiresAt || null,
            createdAt: link.createdAt,
          })),
          {
            emptyMessage: 'No share links found for this document.',
            columns: [
              { key: 'tokenPrefix', header: 'Token' },
              { key: 'permission', header: 'Permission' },
              { key: 'viewCount', header: 'Views' },
              { key: 'isActive', header: 'Active' },
            ],
            textFn: (link) => {
              const lines = [chalk.cyan(`  ${String(link.tokenPrefix)}...`)];
              lines.push(`  ID:         ${String(link.id)}`);
              lines.push(`  Permission: ${String(link.permission)}`);
              lines.push(`  Views:      ${String(link.viewCount)}${link.maxViews ? `/${String(link.maxViews)}` : ''}`);
              lines.push(`  Active:     ${link.isActive ? chalk.green('Yes') : chalk.red('No')}`);
              if (link.expiresAt) lines.push(`  Expires:    ${new Date(String(link.expiresAt)).toLocaleString()}`);
              lines.push(`  Created:    ${new Date(String(link.createdAt)).toLocaleString()}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch share links');
      }
    });

  addGlobalFlags(shares.command('create')
    .description('Create a share link for a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<docPath>', 'Document path (e.g., notes/meeting.md)')
    .option('--permission <perm>', 'Permission level: view or edit', 'view')
    .option('--password <password>', 'Password to protect the link')
    .option('--expires <date>', 'Expiration date (ISO 8601)')
    .option('--max-views <count>', 'Maximum number of views'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating share link...');
      try {
        const client = getClient();
        const params: CreateShareLinkParams = {};
        if (_opts.permission) params.permission = String(_opts.permission) as 'view' | 'edit';
        if (_opts.password) params.password = String(_opts.password);
        if (_opts.expires) params.expiresAt = String(_opts.expires);
        if (_opts.maxViews) params.maxViews = parseInt(String(_opts.maxViews), 10);

        const result = await client.shares.create(vaultId, docPath, params);
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({
            token: result.fullToken,
            id: result.shareLink.id,
            permission: result.shareLink.permission,
            expiresAt: result.shareLink.expiresAt || null,
            maxViews: result.shareLink.maxViews || null,
          });
        } else {
          out.warn('\nIMPORTANT: Save this token. It cannot be retrieved later.\n');
          process.stdout.write(chalk.green.bold(`Token: ${result.fullToken}\n`));
          process.stdout.write(`\nID:         ${result.shareLink.id}\n`);
          process.stdout.write(`Permission: ${result.shareLink.permission}\n`);
          if (result.shareLink.expiresAt) {
            process.stdout.write(`Expires:    ${new Date(result.shareLink.expiresAt).toLocaleString()}\n`);
          }
          if (result.shareLink.maxViews) {
            process.stdout.write(`Max views:  ${result.shareLink.maxViews}\n`);
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to create share link');
      }
    });

  addGlobalFlags(shares.command('revoke')
    .description('Revoke a share link')
    .argument('<vaultId>', 'Vault ID')
    .argument('<shareId>', 'Share link ID'))
    .action(async (vaultId: string, shareId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Revoking share link...');
      try {
        const client = getClient();
        await client.shares.revoke(vaultId, shareId);
        out.success('Share link revoked successfully', { id: shareId, revoked: true });
      } catch (err) {
        handleError(out, err, 'Failed to revoke share link');
      }
    });
}
