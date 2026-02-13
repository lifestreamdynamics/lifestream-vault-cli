import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getClient } from '../client.js';

export function registerDocCommands(program: Command): void {
  const docs = program.command('docs').description('Document operations');

  docs.command('list')
    .description('List documents in a vault')
    .argument('<vaultId>', 'Vault ID')
    .option('--dir <path>', 'Filter by directory path')
    .action(async (vaultId: string, opts: { dir?: string }) => {
      const spinner = ora('Fetching documents...').start();
      try {
        const client = getClient();
        const documents = await client.documents.list(vaultId, opts.dir);
        spinner.stop();
        if (documents.length === 0) {
          console.log(chalk.yellow('No documents found.'));
          return;
        }
        for (const doc of documents) {
          const title = doc.title ? chalk.dim(` -- ${doc.title}`) : '';
          const tags = doc.tags.length > 0 ? chalk.blue(` [${doc.tags.join(', ')}]`) : '';
          console.log(`${chalk.cyan(doc.path)}${title}${tags}`);
        }
        console.log(chalk.dim(`\n${documents.length} document(s)`));
      } catch (err) {
        spinner.fail('Failed to fetch documents');
        console.error(err instanceof Error ? err.message : err);
      }
    });

  docs.command('get')
    .description('Get document content (prints to stdout)')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .option('--meta', 'Show metadata instead of content')
    .action(async (vaultId: string, docPath: string, opts: { meta?: boolean }) => {
      try {
        const client = getClient();
        const result = await client.documents.get(vaultId, docPath);
        if (opts.meta) {
          const doc = result.document;
          console.log(`Path:     ${doc.path}`);
          console.log(`Title:    ${doc.title || chalk.dim('none')}`);
          console.log(`Size:     ${doc.sizeBytes} bytes`);
          console.log(`Tags:     ${doc.tags.length > 0 ? doc.tags.join(', ') : chalk.dim('none')}`);
          console.log(`Hash:     ${doc.contentHash}`);
          console.log(`Modified: ${doc.fileModifiedAt}`);
          console.log(`Created:  ${doc.createdAt}`);
          console.log(`Updated:  ${doc.updatedAt}`);
        } else {
          process.stdout.write(result.content);
        }
      } catch (err) {
        console.error(chalk.red('Failed to get document'));
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  docs.command('put')
    .description('Create or update a document (reads content from stdin)')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .action(async (vaultId: string, docPath: string) => {
      const spinner = ora('Reading stdin...').start();
      try {
        const content = await new Promise<string>((resolve) => {
          let data = '';
          process.stdin.on('data', (chunk) => data += chunk);
          process.stdin.on('end', () => resolve(data));
        });

        spinner.text = 'Uploading document...';
        const client = getClient();
        const doc = await client.documents.put(vaultId, docPath, content);
        spinner.succeed(`Document saved: ${chalk.cyan(doc.path)} (${doc.sizeBytes} bytes)`);
      } catch (err) {
        spinner.fail('Failed to save document');
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  docs.command('delete')
    .description('Delete a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .action(async (vaultId: string, docPath: string) => {
      const spinner = ora('Deleting document...').start();
      try {
        const client = getClient();
        await client.documents.delete(vaultId, docPath);
        spinner.succeed(`Deleted: ${chalk.cyan(docPath)}`);
      } catch (err) {
        spinner.fail('Failed to delete document');
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  docs.command('move')
    .description('Move a document to a new path')
    .argument('<vaultId>', 'Vault ID')
    .argument('<source>', 'Source document path')
    .argument('<dest>', 'Destination document path')
    .option('--overwrite', 'Overwrite if destination exists')
    .action(async (vaultId: string, source: string, dest: string, opts: { overwrite?: boolean }) => {
      const spinner = ora('Moving document...').start();
      try {
        const client = getClient();
        const result = await client.documents.move(vaultId, source, dest, opts.overwrite);
        spinner.succeed(`Moved: ${chalk.cyan(result.source)} -> ${chalk.cyan(result.destination)}`);
      } catch (err) {
        spinner.fail('Failed to move document');
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
