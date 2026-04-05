import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { PublishDocumentParams, UpdatePublishParams } from '@lifestreamdynamics/vault-sdk';
import { resolveVaultId } from '../utils/resolve-vault.js';
import { loadConfigAsync } from '../config.js';

export function registerPublishCommands(program: Command): void {
  const publish = program.command('publish').description('Publish documents to public profile pages');

  addGlobalFlags(publish.command('list')
    .description('List your published documents')
    .argument('<vaultId>', 'Vault ID or slug (required by route)'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching published documents...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const docs = await client.publish.listMine(vaultId);
        out.stopSpinner();
        out.list(
          docs.map(doc => ({
            slug: doc.slug,
            documentPath: doc.documentPath,
            documentTitle: doc.documentTitle || '',
            isPublished: doc.isPublished,
            seoTitle: doc.seoTitle || '',
            updatedAt: doc.updatedAt,
          })),
          {
            emptyMessage: 'No published documents found.',
            columns: [
              { key: 'slug', header: 'Slug' },
              { key: 'documentPath', header: 'Path' },
              { key: 'isPublished', header: 'Published' },
              { key: 'seoTitle', header: 'SEO Title' },
            ],
            textFn: (doc) => {
              const lines = [chalk.cyan(`  ${String(doc.slug)}`)];
              lines.push(`  Path:      ${String(doc.documentPath)}`);
              if (doc.documentTitle) lines.push(`  Title:     ${String(doc.documentTitle)}`);
              lines.push(`  Published: ${doc.isPublished ? chalk.green('Yes') : chalk.red('No')}`);
              if (doc.seoTitle) lines.push(`  SEO Title: ${String(doc.seoTitle)}`);
              lines.push(`  Updated:   ${new Date(String(doc.updatedAt)).toLocaleString()}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch published documents');
      }
    });

  addGlobalFlags(publish.command('create')
    .description('Publish a document')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<docPath>', 'Document path (e.g., blog/post.md)')
    .requiredOption('--slug <slug>', 'URL-friendly slug for the published page')
    .option('--title <title>', 'SEO title')
    .option('--description <description>', 'SEO description')
    .option('--og-image <url>', 'Open Graph image URL'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Publishing document...');
      try {
        vaultId = await resolveVaultId(vaultId);
        out.debug(`API: POST publish ${vaultId}/${docPath}`);
        const client = await getClientAsync();
        const params: PublishDocumentParams = {
          slug: String(_opts.slug),
        };
        if (_opts.title) params.seoTitle = String(_opts.title);
        if (_opts.description) params.seoDescription = String(_opts.description);
        if (_opts.ogImage) params.ogImage = String(_opts.ogImage);

        const pub = await client.publish.create(vaultId, docPath, params);
        const config = await loadConfigAsync();
        const baseUrl = config.apiUrl.replace(/\/api\/v\d+\/?$/, '');
        out.success('Document published successfully!', {
          slug: pub.slug,
          url: `${baseUrl}/${pub.publishedBy}/${pub.slug}`,
          isPublished: pub.isPublished,
          seoTitle: pub.seoTitle || null,
          seoDescription: pub.seoDescription || null,
          publishedAt: pub.publishedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to publish document');
      }
    });

  addGlobalFlags(publish.command('update')
    .description('Update a published document')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<docPath>', 'Document path (e.g., blog/post.md)')
    .requiredOption('--slug <slug>', 'URL-friendly slug (required for updates)')
    .option('--title <title>', 'SEO title')
    .option('--description <description>', 'SEO description')
    .option('--og-image <url>', 'Open Graph image URL'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating published document...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const params: UpdatePublishParams = {
          slug: String(_opts.slug),
        };
        if (_opts.title) params.seoTitle = String(_opts.title);
        if (_opts.description) params.seoDescription = String(_opts.description);
        if (_opts.ogImage) params.ogImage = String(_opts.ogImage);

        const pub = await client.publish.update(vaultId, docPath, params);
        out.success('Published document updated successfully', {
          slug: pub.slug,
          seoTitle: pub.seoTitle || null,
          seoDescription: pub.seoDescription || null,
          updatedAt: pub.updatedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to update published document');
      }
    });

  addGlobalFlags(publish.command('delete')
    .description('Unpublish a document')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<docPath>', 'Document path (e.g., blog/post.md)')
    .option('-y, --yes', 'Skip confirmation prompt'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes) {
        out.status(chalk.yellow(`Pass --yes to unpublish document ${docPath}.`));
        return;
      }
      out.startSpinner('Unpublishing document...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        await client.publish.delete(vaultId, docPath);
        out.success('Document unpublished successfully', { path: docPath, unpublished: true });
      } catch (err) {
        handleError(out, err, 'Failed to unpublish document');
      }
    });

  const subdomain = publish.command('subdomain').description('Subdomain management for published vaults');

  addGlobalFlags(subdomain.command('get')
    .description('Get the subdomain for a published vault')
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching subdomain...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const result = await client.publish.getSubdomain(vaultId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.record({ subdomain: result.subdomain });
        } else if (result.subdomain == null) {
          out.status('No subdomain configured.');
        } else {
          out.record({ subdomain: result.subdomain });
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch subdomain');
      }
    });

  addGlobalFlags(subdomain.command('set')
    .description('Set a subdomain for a published vault')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<subdomain>', 'Subdomain to assign'))
    .action(async (vaultId: string, subdomainArg: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Setting subdomain...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const result = await client.publish.setSubdomain(vaultId, subdomainArg);
        out.success(`Subdomain set: ${result.subdomain}`, { subdomain: result.subdomain });
      } catch (err) {
        handleError(out, err, 'Failed to set subdomain');
      }
    });

  addGlobalFlags(subdomain.command('delete')
    .description('Remove the subdomain for a published vault')
    .argument('<vaultId>', 'Vault ID or slug')
    .option('-y, --yes', 'Skip confirmation prompt'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes) {
        out.status(chalk.yellow(`Pass --yes to remove the subdomain for vault ${vaultId}.`));
        return;
      }
      out.startSpinner('Removing subdomain...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const result = await client.publish.deleteSubdomain(vaultId);
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to delete subdomain');
      }
    });
}
