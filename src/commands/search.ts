import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerSearchCommands(program: Command): void {
  addGlobalFlags(program.command('search')
    .description('Full-text search across all documents')
    .argument('<query>', 'Search query (PostgreSQL websearch syntax)')
    .option('--vault <vaultId>', 'Limit search to a specific vault')
    .option('--tags <tags>', 'Filter by tags (comma-separated)')
    .option('--limit <n>', 'Maximum number of results', '20')
    .addHelpText('after', `
EXAMPLES
  lsvault search "meeting notes"
  lsvault search "project plan" --vault abc123
  lsvault search "typescript" --tags dev,code --limit 5`))
    .action(async (query: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Searching...');
      try {
        const client = await getClientAsync();
        const response = await client.search.search({
          q: query,
          vault: _opts.vault as string | undefined,
          tags: _opts.tags as string | undefined,
          limit: parseInt(String(_opts.limit || '20'), 10),
        });
        out.stopSpinner();

        if (flags.output === 'text') {
          out.status(chalk.dim(`${response.total} result(s) for "${response.query}":\n`));
        }

        out.list(
          response.results.map(r => ({
            title: r.title || r.path,
            path: r.path,
            vaultName: r.vaultName,
            tags: r.tags.join(', '),
            snippet: r.snippet ? r.snippet.replace(/<[^>]+>/g, '') : '',
          })),
          {
            emptyMessage: 'No results found.',
            columns: [
              { key: 'title', header: 'Title' },
              { key: 'path', header: 'Path' },
              { key: 'vaultName', header: 'Vault' },
              { key: 'tags', header: 'Tags' },
            ],
            textFn: (r) => {
              const tags = r.tags ? chalk.blue(` [${String(r.tags)}]`) : '';
              const lines = [`${chalk.cyan(String(r.title))}${tags}`];
              lines.push(`  ${chalk.dim(String(r.vaultName))} / ${chalk.dim(String(r.path))}`);
              if (r.snippet) lines.push(`  ${String(r.snippet)}`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Search failed');
      }
    });
}
