import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getClient } from '../client.js';

export function registerSearchCommands(program: Command): void {
  program.command('search')
    .description('Search documents')
    .argument('<query>', 'Search query')
    .option('--vault <vaultId>', 'Limit search to a specific vault')
    .option('--tags <tags>', 'Filter by tags (comma-separated)')
    .option('--limit <n>', 'Maximum number of results', '20')
    .action(async (query: string, opts: { vault?: string; tags?: string; limit?: string }) => {
      const spinner = ora('Searching...').start();
      try {
        const client = getClient();
        const response = await client.search.search({
          q: query,
          vault: opts.vault,
          tags: opts.tags,
          limit: parseInt(opts.limit || '20', 10),
        });
        spinner.stop();

        if (response.results.length === 0) {
          console.log(chalk.yellow('No results found.'));
          return;
        }

        console.log(chalk.dim(`${response.total} result(s) for "${response.query}":\n`));

        for (const result of response.results) {
          const title = result.title || result.path;
          const tags = result.tags.length > 0 ? chalk.blue(` [${result.tags.join(', ')}]`) : '';
          console.log(`${chalk.cyan(title)}${tags}`);
          console.log(`  ${chalk.dim(result.vaultName)} / ${chalk.dim(result.path)}`);
          if (result.snippet) {
            // Strip HTML tags from snippet for terminal display
            const cleanSnippet = result.snippet.replace(/<[^>]+>/g, '');
            console.log(`  ${cleanSnippet}`);
          }
          console.log();
        }
      } catch (err) {
        spinner.fail('Search failed');
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
