import type { Command } from 'commander';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { PublishDocumentParams, UpdatePublishParams } from '@lifestreamdynamics/vault-sdk';
import chalk from 'chalk';

export function registerPublishCommands(program: Command): void {
  const publish = program.command('publish').description('Publish documents to public profile pages');

  addGlobalFlags(publish.command('list')
    .description('List your published documents')
    .argument('<vaultId>', 'Vault ID (required by route)'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching published documents...');
      try {
        const client = getClient();
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
    .argument('<vaultId>', 'Vault ID')
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
        const client = getClient();
        const params: PublishDocumentParams = {
          slug: String(_opts.slug),
        };
        if (_opts.title) params.seoTitle = String(_opts.title);
        if (_opts.description) params.seoDescription = String(_opts.description);
        if (_opts.ogImage) params.ogImage = String(_opts.ogImage);

        const pub = await client.publish.create(vaultId, docPath, params);
        out.success('Document published successfully!', {
          slug: pub.slug,
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
    .argument('<vaultId>', 'Vault ID')
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
        const client = getClient();
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
    .argument('<vaultId>', 'Vault ID')
    .argument('<docPath>', 'Document path (e.g., blog/post.md)'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Unpublishing document...');
      try {
        const client = getClient();
        await client.publish.delete(vaultId, docPath);
        out.success('Document unpublished successfully', { path: docPath, unpublished: true });
      } catch (err) {
        handleError(out, err, 'Failed to unpublish document');
      }
    });
}
