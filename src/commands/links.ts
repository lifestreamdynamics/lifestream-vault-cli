import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { resolveVaultId } from '../utils/resolve-vault.js';

export function registerLinkCommands(program: Command): void {
  const links = program.command('links').description('Manage document links and backlinks');

  // lsvault links list <vaultId> <path> — forward links
  addGlobalFlags(links.command('list')
    .description('List forward links from a document')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<path>', 'Document path'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching links...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const linkList = await client.documents.getLinks(vaultId, docPath);
        out.stopSpinner();
        out.list(
          linkList.map(link => ({
            targetPath: link.targetPath,
            linkText: link.linkText,
            isResolved: link.isResolved,
          })),
          {
            emptyMessage: 'No forward links found.',
            columns: [
              { key: 'targetPath', header: 'Target' },
              { key: 'linkText', header: 'Link Text' },
              { key: 'isResolved', header: 'Resolved' },
            ],
            textFn: (link) => {
              const resolved = link.isResolved ? chalk.green('✓') : chalk.red('✗');
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<path>', 'Document path'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching backlinks...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const backlinks = await client.documents.getBacklinks(vaultId, docPath);
        out.stopSpinner();
        out.list(
          backlinks.map(bl => ({
            sourcePath: bl.sourceDocument.path,
            sourceTitle: bl.sourceDocument.title || null,
            linkText: bl.linkText,
            context: bl.contextSnippet || '',
          })),
          {
            emptyMessage: 'No backlinks found.',
            columns: [
              { key: 'sourcePath', header: 'Source Path' },
              { key: 'sourceTitle', header: 'Source Title' },
              { key: 'linkText', header: 'Link Text' },
              { key: 'context', header: 'Context' },
            ],
            textFn: (bl) => {
              const displayName = bl.sourceTitle ? String(bl.sourceTitle) : String(bl.sourcePath);
              const lines = [chalk.cyan(`  ${displayName}`)];
              if (bl.sourceTitle) lines.push(`  Path: ${String(bl.sourcePath)}`);
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
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching link graph...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const graph = await client.vaults.getGraph(vaultId);
        out.stopSpinner();
        if (flags.output === 'json') {
          process.stdout.write(JSON.stringify({ nodes: graph.nodes, edges: graph.edges }) + '\n');
        } else {
          process.stdout.write(chalk.bold(`Nodes: ${graph.nodes.length}  Edges: ${graph.edges.length}\n`));
          for (const node of graph.nodes) {
            process.stdout.write(`  ${chalk.cyan(String(node.path ?? node.id))}\n`);
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch link graph');
      }
    });

  // lsvault links broken <vaultId>
  addGlobalFlags(links.command('broken')
    .description('List unresolved (broken) links in a vault')
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching unresolved links...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const unresolved = await client.vaults.getUnresolvedLinks(vaultId);
        out.stopSpinner();
        if (flags.output === 'json') {
          process.stdout.write(JSON.stringify(unresolved) + '\n');
          return;
        }
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
