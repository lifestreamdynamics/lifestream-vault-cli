import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { createCredentialManager } from '../lib/credential-manager.js';

export function registerDocCommands(program: Command): void {
  const docs = program.command('docs').description('Read, write, move, and delete documents in a vault');

  addGlobalFlags(docs.command('list')
    .description('List documents in a vault, optionally filtered by directory')
    .argument('<vaultId>', 'Vault ID')
    .option('--dir <path>', 'Filter by directory path')
    .addHelpText('after', `
EXAMPLES
  lsvault docs list abc123
  lsvault docs list abc123 --dir notes/meetings`))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching documents...');
      try {
        const client = await getClientAsync();
        const documents = await client.documents.list(vaultId, _opts.dir as string | undefined);
        out.stopSpinner();
        out.list(
          documents.map(doc => ({
            path: doc.path,
            title: doc.title || '',
            tags: Array.isArray(doc.tags) ? doc.tags.join(', ') : '',
            sizeBytes: doc.sizeBytes,
          })),
          {
            emptyMessage: 'No documents found.',
            columns: [
              { key: 'path', header: 'Path' },
              { key: 'title', header: 'Title' },
              { key: 'tags', header: 'Tags' },
              { key: 'sizeBytes', header: 'Size' },
            ],
            textFn: (doc) => {
              const title = doc.title ? chalk.dim(` -- ${String(doc.title)}`) : '';
              const tags = doc.tags ? chalk.blue(` [${String(doc.tags)}]`) : '';
              return `${chalk.cyan(String(doc.path))}${title}${tags}`;
            },
          },
        );
        if (flags.output === 'text' && documents.length > 0) {
          out.status(chalk.dim(`\n${documents.length} document(s)`));
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch documents');
      }
    });

  addGlobalFlags(docs.command('get')
    .description('Print document content to stdout, or show metadata with --meta')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path (e.g., notes/todo.md)')
    .option('--meta', 'Show metadata instead of content')
    .addHelpText('after', `
EXAMPLES
  lsvault docs get abc123 notes/todo.md
  lsvault docs get abc123 notes/todo.md --meta
  lsvault docs get abc123 notes/todo.md > local-copy.md`))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const client = await getClientAsync();
        const result = await client.documents.get(vaultId, docPath);

        // Auto-decrypt if the document is encrypted
        if (result.document.encrypted && !_opts.meta) {
          const credManager = createCredentialManager();
          const vaultKey = await credManager.getVaultKey(vaultId);
          if (!vaultKey) {
            out.error('Document is encrypted but no vault key found.');
            out.status(chalk.dim('Import the key with: lsvault vaults import-key ' + vaultId + ' --key <key>'));
            process.exitCode = 1;
            return;
          }
          const decrypted = await client.documents.getEncrypted(vaultId, docPath, vaultKey);
          out.raw(decrypted.content);
          return;
        }

        if (_opts.meta) {
          const doc = result.document;
          out.record({
            path: doc.path,
            title: doc.title,
            sizeBytes: doc.sizeBytes,
            tags: Array.isArray(doc.tags) ? doc.tags.join(', ') : '',
            encrypted: doc.encrypted ? 'yes' : 'no',
            contentHash: doc.contentHash,
            fileModifiedAt: doc.fileModifiedAt,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          });
        } else {
          out.raw(result.content);
        }
      } catch (err) {
        handleError(out, err, 'Failed to get document');
      }
    });

  addGlobalFlags(docs.command('put')
    .description('Create or update a document by reading content from stdin')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path (must end with .md)')
    .addHelpText('after', `
EXAMPLES
  echo "# Hello" | lsvault docs put abc123 notes/hello.md
  cat local-file.md | lsvault docs put abc123 docs/imported.md`))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Reading stdin...');
      try {
        const content = await new Promise<string>((resolve) => {
          let data = '';
          process.stdin.on('data', (chunk) => data += chunk);
          process.stdin.on('end', () => resolve(data));
        });

        out.startSpinner('Uploading document...');
        const client = await getClientAsync();

        // Check if vault is encrypted and auto-encrypt
        const vault = await client.vaults.get(vaultId);
        let doc;
        if (vault.encryptionEnabled) {
          const credManager = createCredentialManager();
          const vaultKey = await credManager.getVaultKey(vaultId);
          if (!vaultKey) {
            out.failSpinner('Failed to save document');
            out.error('Vault is encrypted but no vault key found.');
            out.status(chalk.dim('Import the key with: lsvault vaults import-key ' + vaultId + ' --key <key>'));
            process.exitCode = 1;
            return;
          }
          doc = await client.documents.putEncrypted(vaultId, docPath, content, vaultKey);
        } else {
          doc = await client.documents.put(vaultId, docPath, content);
        }
        out.success(`Document saved: ${chalk.cyan(doc.path)} (${doc.sizeBytes} bytes)`, {
          path: doc.path,
          sizeBytes: doc.sizeBytes,
          encrypted: doc.encrypted,
        });
      } catch (err) {
        handleError(out, err, 'Failed to save document');
      }
    });

  addGlobalFlags(docs.command('delete')
    .description('Permanently delete a document from a vault')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path to delete'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Deleting document...');
      try {
        const client = await getClientAsync();
        await client.documents.delete(vaultId, docPath);
        out.success(`Deleted: ${chalk.cyan(docPath)}`, { path: docPath, deleted: true });
      } catch (err) {
        handleError(out, err, 'Failed to delete document');
      }
    });

  addGlobalFlags(docs.command('move')
    .description('Move or rename a document within a vault')
    .argument('<vaultId>', 'Vault ID')
    .argument('<source>', 'Current document path')
    .argument('<dest>', 'New document path')
    .option('--overwrite', 'Overwrite if destination already exists')
    .addHelpText('after', `
EXAMPLES
  lsvault docs move abc123 notes/old.md notes/new.md
  lsvault docs move abc123 draft.md published/final.md --overwrite`))
    .action(async (vaultId: string, source: string, dest: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Moving document...');
      try {
        const client = await getClientAsync();
        const result = await client.documents.move(vaultId, source, dest, _opts.overwrite as boolean | undefined);
        out.success(`Moved: ${chalk.cyan(result.source)} -> ${chalk.cyan(result.destination)}`, {
          source: result.source,
          destination: result.destination,
        });
      } catch (err) {
        handleError(out, err, 'Failed to move document');
      }
    });
}
