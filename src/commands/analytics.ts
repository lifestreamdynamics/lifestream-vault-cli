import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerAnalyticsCommands(program: Command): void {
  const analytics = program.command('analytics').description('Analytics for published documents and share links');

  addGlobalFlags(analytics.command('published')
    .description('Summary of published document views'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching analytics...');
      try {
        const client = await getClientAsync();
        const summary = await client.analytics.getPublishedSummary();
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(summary, null, 2) + '\n');
        } else {
          process.stdout.write(`Total published: ${summary.totalPublished}, Total views: ${summary.totalViews}\n\n`);
          out.list(
            summary.documents.map(d => ({ slug: d.slug, title: d.title ?? '', viewCount: d.viewCount, publishedAt: d.publishedAt })),
            {
              emptyMessage: 'No published documents.',
              columns: [
                { key: 'slug', header: 'Slug' },
                { key: 'title', header: 'Title' },
                { key: 'viewCount', header: 'Views' },
                { key: 'publishedAt', header: 'Published' },
              ],
              textFn: (d) => `${chalk.cyan(String(d.slug))} — ${String(d.viewCount)} views`,
            },
          );
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch analytics');
      }
    });

  addGlobalFlags(analytics.command('share')
    .description('Analytics for a share link')
    .argument('<vaultId>', 'Vault ID')
    .argument('<shareId>', 'Share ID'))
    .action(async (vaultId: string, shareId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching share analytics...');
      try {
        const client = await getClientAsync();
        const data = await client.analytics.getShareAnalytics(vaultId, shareId);
        out.stopSpinner();
        out.record({
          shareId: data.shareId,
          viewCount: data.viewCount,
          uniqueViewers: data.uniqueViewers,
          lastViewedAt: data.lastViewedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch share analytics');
      }
    });

  addGlobalFlags(analytics.command('doc')
    .description('Analytics for a published document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<publishedDocId>', 'Published document ID'))
    .action(async (vaultId: string, publishedDocId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching document analytics...');
      try {
        const client = await getClientAsync();
        const data = await client.analytics.getPublishedDocAnalytics(vaultId, publishedDocId);
        out.stopSpinner();
        out.record({
          publishedDocId: data.publishedDocId,
          viewCount: data.viewCount,
          uniqueViewers: data.uniqueViewers,
          lastViewedAt: data.lastViewedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch document analytics');
      }
    });
}
