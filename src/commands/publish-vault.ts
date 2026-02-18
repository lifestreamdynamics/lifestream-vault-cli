import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerPublishVaultCommands(program: Command): void {
  const pv = program.command('publish-vault').description('Manage whole-vault publishing (public sites)');

  addGlobalFlags(pv.command('list')
    .description('List your published vault sites'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching published vaults...');
      try {
        const client = await getClientAsync();
        const list = await client.publishVault.listMine();
        out.stopSpinner();
        out.list(
          list.map(pv => ({ slug: pv.slug, title: pv.title, isPublished: pv.isPublished ? 'yes' : 'no', createdAt: pv.createdAt })),
          {
            emptyMessage: 'No published vault sites found.',
            columns: [
              { key: 'slug', header: 'Slug' },
              { key: 'title', header: 'Title' },
              { key: 'isPublished', header: 'Published' },
              { key: 'createdAt', header: 'Created' },
            ],
            textFn: (pv) => `${chalk.cyan(String(pv.slug))} — ${String(pv.title)} [${pv.isPublished === 'yes' ? chalk.green('live') : chalk.dim('draft')}]`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch published vaults');
      }
    });

  addGlobalFlags(pv.command('publish')
    .description('Publish a vault as a public site')
    .argument('<vaultId>', 'Vault ID')
    .requiredOption('--slug <slug>', 'URL slug for the site')
    .requiredOption('--title <title>', 'Site title')
    .option('--description <desc>', 'Site description')
    .option('--show-sidebar', 'Show sidebar navigation')
    .option('--enable-search', 'Enable search on the site')
    .option('--theme <theme>', 'Site theme')
    .option('--domain <domainId>', 'Custom domain ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Publishing vault...');
      try {
        const client = await getClientAsync();
        const published = await client.publishVault.publish(vaultId, {
          slug: _opts.slug as string,
          title: _opts.title as string,
          description: _opts.description as string | undefined,
          showSidebar: _opts.showSidebar === true,
          enableSearch: _opts.enableSearch === true,
          theme: _opts.theme as string | undefined,
          customDomainId: _opts.domain as string | undefined,
        });
        out.success(`Vault published at /${published.slug}`, { id: published.id, slug: published.slug, title: published.title });
      } catch (err) {
        handleError(out, err, 'Failed to publish vault');
      }
    });

  addGlobalFlags(pv.command('update')
    .description('Update a published vault site')
    .argument('<vaultId>', 'Vault ID')
    .option('--slug <slug>', 'URL slug')
    .option('--title <title>', 'Site title')
    .option('--description <desc>', 'Site description')
    .option('--show-sidebar', 'Show sidebar')
    .option('--enable-search', 'Enable search')
    .option('--theme <theme>', 'Site theme')
    .option('--domain <domainId>', 'Custom domain ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating published vault...');
      try {
        const client = await getClientAsync();
        const params: Record<string, unknown> = {};
        if (_opts.slug) params.slug = _opts.slug;
        if (_opts.title) params.title = _opts.title;
        if (_opts.description) params.description = _opts.description;
        if (_opts.showSidebar !== undefined) params.showSidebar = _opts.showSidebar === true;
        if (_opts.enableSearch !== undefined) params.enableSearch = _opts.enableSearch === true;
        if (_opts.theme) params.theme = _opts.theme;
        if (_opts.domain) params.customDomainId = _opts.domain;
        const published = await client.publishVault.update(vaultId, params);
        out.success('Published vault updated', { id: published.id, slug: published.slug });
      } catch (err) {
        handleError(out, err, 'Failed to update published vault');
      }
    });

  addGlobalFlags(pv.command('unpublish')
    .description('Unpublish a vault site')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Unpublishing vault...');
      try {
        const client = await getClientAsync();
        await client.publishVault.unpublish(vaultId);
        out.success('Vault unpublished', { vaultId });
      } catch (err) {
        handleError(out, err, 'Failed to unpublish vault');
      }
    });
}
