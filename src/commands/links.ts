import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerLinkCommands(program: Command): void {
  const links = program.command('links').description('Manage document links and backlinks');

  // lsvault links list <vaultId> <path> — forward links
  addGlobalFlags(links.command('list')
    .description('List forward links from a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching links...');
      try {
        const client = await getClientAsync();
        const linkList = await client.documents.getLinks(vaultId, docPath);
        out.stopSpinner();
        out.list(
          linkList.map(link => ({
            targetPath: link.targetPath,
            linkText: link.linkText,
            resolved: link.isResolved ? 'Yes' : 'No',
          })),
          {
            emptyMessage: 'No forward links found.',
            columns: [
              { key: 'targetPath', header: 'Target' },
              { key: 'linkText', header: 'Link Text' },
              { key: 'resolved', header: 'Resolved' },
            ],
            textFn: (link) => {
              const resolved = link.resolved === 'Yes' ? chalk.green('✓') : chalk.red('✗');
              return `  ${resolved} [[${String(link.linkText)}]] → ${String(link.targetPath)}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch links');
      }
    });

  // lsvault links backlinks <vaultId> <path>
  addGlobalFlags(links.command('backlinks')
    .description('List backlinks pointing to a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching backlinks...');
      try {
        const client = await getClientAsync();
        const backlinks = await client.documents.getBacklinks(vaultId, docPath);
        out.stopSpinner();
        out.list(
          backlinks.map(bl => ({
            source: bl.sourceDocument.title || bl.sourceDocument.path,
            linkText: bl.linkText,
            context: bl.contextSnippet || '',
          })),
          {
            emptyMessage: 'No backlinks found.',
            columns: [
              { key: 'source', header: 'Source' },
              { key: 'linkText', header: 'Link Text' },
              { key: 'context', header: 'Context' },
            ],
            textFn: (bl) => {
              const lines = [chalk.cyan(`  ${String(bl.source)}`)];
              lines.push(`  Link: [[${String(bl.linkText)}]]`);
              if (bl.context) lines.push(`  Context: ...${String(bl.context)}...`);
              return lines.join('\n');
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch backlinks');
      }
    });

  // lsvault links graph <vaultId>
  addGlobalFlags(links.command('graph')
    .description('Get the link graph for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching link graph...');
      try {
        const client = await getClientAsync();
        const graph = await client.vaults.getGraph(vaultId);
        out.stopSpinner();
        // For graph, output as JSON structure
        process.stdout.write(JSON.stringify({ nodes: graph.nodes, edges: graph.edges }) + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to fetch link graph');
      }
    });

  // lsvault links broken <vaultId>
  addGlobalFlags(links.command('broken')
    .description('List unresolved (broken) links in a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching unresolved links...');
      try {
        const client = await getClientAsync();
        const unresolved = await client.vaults.getUnresolvedLinks(vaultId);
        out.stopSpinner();
        if (unresolved.length === 0) {
          out.success('No broken links found!');
          return;
        }
        // Format as grouped output
        for (const group of unresolved) {
          process.stdout.write(chalk.red(`  ✗ ${group.targetPath}`) + '\n');
          for (const ref of group.references) {
            process.stdout.write(`    ← ${ref.sourcePath} (${chalk.dim(ref.linkText)})` + '\n');
          }
        }
        process.stdout.write(`\n  ${chalk.yellow(`${unresolved.length} broken link target(s) found`)}` + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to fetch unresolved links');
      }
    });
}
