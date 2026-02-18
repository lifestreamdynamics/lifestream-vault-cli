import type { Command } from 'commander';
import chalk from 'chalk';
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
          for (const msg of result.messages ?? []) {
            const role = (msg as { role?: string }).role === 'assistant' ? chalk.green('AI') : chalk.blue('You');
            process.stdout.write(`${role}: ${String((msg as { content?: string }).content ?? '')}\n\n`);
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch AI session');
      }
    });

  addGlobalFlags(sessions.command('delete')
    .description('Delete an AI chat session')
    .argument('<sessionId>', 'Session ID'))
    .action(async (sessionId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
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
    .argument('<message>', 'Message to send'))
    .action(async (sessionId: string, message: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Sending message...');
      try {
        const client = await getClientAsync();
        const response = await client.ai.chat({ message, sessionId });
        out.stopSpinner();
        process.stdout.write(String((response as { content?: string }).content ?? JSON.stringify(response)) + '\n');
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
        process.stdout.write(String((summary as { summary?: string }).summary ?? JSON.stringify(summary)) + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to summarize document');
      }
    });
}
