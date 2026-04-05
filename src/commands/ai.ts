import type { Command } from 'commander';
import chalk from 'chalk';
import type { AiChatMessage } from '@lifestreamdynamics/vault-sdk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerAiCommands(program: Command): void {
  const ai = program.command('ai').description('AI chat and document summarization');

  const sessions = ai.command('sessions').description('AI chat session management');

  addGlobalFlags(sessions.command('list')
    .description('List AI chat sessions'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching AI sessions...');
      try {
        const client = await getClientAsync();
        const list = await client.ai.listSessions();
        out.stopSpinner();
        out.list(
          list.map(s => ({ id: s.id, title: s.title ?? 'Untitled', createdAt: s.createdAt })),
          {
            emptyMessage: 'No AI sessions found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'title', header: 'Title' },
              { key: 'createdAt', header: 'Created' },
            ],
            textFn: (s) => `${chalk.cyan(String(s.id))} — ${String(s.title)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch AI sessions');
      }
    });

  addGlobalFlags(sessions.command('get')
    .description('Get an AI chat session with messages')
    .argument('<sessionId>', 'Session ID'))
    .action(async (sessionId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching AI session...');
      try {
        const client = await getClientAsync();
        const result = await client.ai.getSession(sessionId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(result, null, 2) + '\n');
        } else {
          process.stdout.write(`Session: ${chalk.cyan(result.session.id)}\n`);
          process.stdout.write(`Title: ${result.session.title ?? 'Untitled'}\n\n`);
          for (const msg of result.messages ?? [] as AiChatMessage[]) {
            const role = msg.role === 'assistant' ? chalk.green('AI') : chalk.blue('You');
            process.stdout.write(`${role}: ${msg.content}\n\n`);
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch AI session');
      }
    });

  addGlobalFlags(sessions.command('delete')
    .description('Delete an AI chat session')
    .argument('<sessionId>', 'Session ID')
    .option('-y, --yes', 'Skip confirmation prompt'))
    .action(async (sessionId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes) {
        out.status(chalk.yellow(`Pass --yes to delete AI session ${sessionId}.`));
        return;
      }
      out.startSpinner('Deleting AI session...');
      try {
        const client = await getClientAsync();
        await client.ai.deleteSession(sessionId);
        out.success('Session deleted', { id: sessionId });
      } catch (err) {
        handleError(out, err, 'Failed to delete AI session');
      }
    });

  addGlobalFlags(ai.command('chat')
    .description('Send a message in an AI chat session')
    .argument('<sessionId>', 'Session ID')
    .argument('<message>', 'Message to send')
    .addHelpText('after', `
EXAMPLES
  lsvault ai chat <session-id> "What are the key points in my notes?"
  lsvault ai chat <session-id> "Summarize recent changes" -o json`))
    .action(async (sessionId: string, message: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Sending message...');
      try {
        const client = await getClientAsync();
        const response = await client.ai.chat({ message, sessionId });
        out.stopSpinner();
        // response.message is typed as { role: string; content: string; sources: string[] }
        process.stdout.write(response.message.content + '\n');
        if (response.message.sources.length > 0) {
          process.stdout.write(chalk.dim(`Sources: ${response.message.sources.join(', ')}`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to send AI message');
      }
    });

  addGlobalFlags(ai.command('summarize')
    .description('Summarize a document with AI')
    .argument('<vaultId>', 'Vault ID')
    .argument('<docPath>', 'Document path'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Summarizing document...');
      try {
        const client = await getClientAsync();
        const summary = await client.ai.summarize(vaultId, docPath);
        out.stopSpinner();
        // summary is typed as { summary: string; keyTopics: string[]; tokensUsed: number }
        process.stdout.write(summary.summary + '\n');
        if (summary.keyTopics.length > 0) {
          process.stdout.write(chalk.dim(`Key topics: ${summary.keyTopics.join(', ')}`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to summarize document');
      }
    });

  addGlobalFlags(ai.command('similar')
    .description('Find documents similar to a given document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<documentId>', 'Document ID')
    .option('-l, --limit <limit>', 'Maximum results (1-50)', '10'))
    .action(async (vaultId: string, documentId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Finding similar documents...');
      try {
        const client = await getClientAsync();
        const { similar } = await client.ai.similar({ documentId, vaultId, limit: Number(_opts.limit) || undefined });
        out.stopSpinner();
        out.list(
          similar.map(d => ({ id: d.id, path: d.path, title: d.title ?? '(untitled)', similarity: d.similarity.toFixed(4) })),
          {
            emptyMessage: 'No similar documents found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'path', header: 'Path' },
              { key: 'title', header: 'Title' },
              { key: 'similarity', header: 'Similarity' },
            ],
            textFn: (d) => `${chalk.cyan(String(d.path))} (${String(d.similarity)})`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to find similar documents');
      }
    });

  addGlobalFlags(ai.command('assist')
    .description('Get AI text assistance')
    .argument('<vaultId>', 'Vault ID')
    .requiredOption('-t, --text <text>', 'Text to process')
    .requiredOption('-i, --instruction <instruction>', 'Instruction for the AI')
    .option('-c, --context <context>', 'Additional context'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Processing with AI...');
      try {
        const client = await getClientAsync();
        const response = await client.ai.assist({
          vaultId,
          text: String(_opts.text),
          instruction: String(_opts.instruction),
          context: _opts.context ? String(_opts.context) : undefined,
        });
        out.stopSpinner();
        process.stdout.write(response.result + '\n');
        process.stdout.write(chalk.dim(`Tokens used: ${response.tokensUsed}`) + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to get AI assistance');
      }
    });

  addGlobalFlags(ai.command('suggest')
    .description('Get AI writing suggestions for a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<docPath>', 'Document path')
    .requiredOption('--type <type>', 'Suggestion type: grammar, style, expand, shorten'))
    .action(async (vaultId: string, docPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Getting suggestions...');
      try {
        const client = await getClientAsync();
        const response = await client.ai.suggest({
          vaultId,
          documentPath: docPath,
          type: String(_opts.type) as 'grammar' | 'style' | 'expand' | 'shorten',
        });
        out.stopSpinner();
        process.stdout.write(response.suggestion + '\n');
        process.stdout.write(chalk.dim(`Type: ${response.type} | Tokens used: ${response.tokensUsed}`) + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to get AI suggestions');
      }
    });
}
