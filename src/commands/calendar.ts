import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerCalendarCommands(program: Command): void {
  const calendar = program.command('calendar').description('Document calendar and due date management');

  // calendar view
  addGlobalFlags(calendar.command('view')
    .description('View calendar activity for a vault')
    .argument('<vaultId>', 'Vault ID')
    .option('--start <date>', 'Start date (YYYY-MM-DD)', getDefaultStart())
    .option('--end <date>', 'End date (YYYY-MM-DD)', getDefaultEnd()))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading calendar...');
      try {
        const client = await getClientAsync();
        const response = await client.calendar.getActivity(vaultId, {
          start: _opts.start as string,
          end: _opts.end as string,
        });
        out.stopSpinner();
        if (flags.output === 'text') {
          out.status(chalk.dim(`Activity from ${response.start} to ${response.end}:\n`));
        }
        out.list(
          response.days.map(d => ({
            date: d.date,
            created: String(d.created),
            updated: String(d.updated),
            deleted: String(d.deleted),
            total: String(d.total),
          })),
          {
            emptyMessage: 'No activity in this period.',
            columns: [
              { key: 'date', header: 'Date' },
              { key: 'created', header: 'Created' },
              { key: 'updated', header: 'Updated' },
              { key: 'deleted', header: 'Deleted' },
              { key: 'total', header: 'Total' },
            ],
            textFn: (d) => {
              const bar = '█'.repeat(Math.min(Number(d.total), 20));
              return `${chalk.dim(String(d.date))} ${chalk.green(bar)} ${chalk.bold(String(d.total))}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Calendar view failed');
      }
    });

  // calendar due
  addGlobalFlags(calendar.command('due')
    .description('List documents with due dates')
    .argument('<vaultId>', 'Vault ID')
    .option('--status <status>', 'Filter: overdue, upcoming, all', 'all'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading due dates...');
      try {
        const client = await getClientAsync();
        const docs = await client.calendar.getDueDates(vaultId, {
          status: _opts.status as 'overdue' | 'upcoming' | 'all',
        });
        out.stopSpinner();
        out.list(
          docs.map(d => ({
            title: d.title || d.path,
            path: d.path,
            dueAt: d.dueAt,
            priority: d.priority || '-',
            status: d.overdue ? 'OVERDUE' : d.completed ? 'Done' : 'Pending',
          })),
          {
            emptyMessage: 'No documents with due dates.',
            columns: [
              { key: 'title', header: 'Title' },
              { key: 'dueAt', header: 'Due' },
              { key: 'priority', header: 'Priority' },
              { key: 'status', header: 'Status' },
            ],
            textFn: (d) => {
              const statusColor = d.status === 'OVERDUE' ? chalk.red : d.status === 'Done' ? chalk.green : chalk.yellow;
              return `${chalk.cyan(String(d.title))} — due ${chalk.dim(String(d.dueAt))} ${statusColor(String(d.status))}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Due dates failed');
      }
    });

  // calendar set-due
  addGlobalFlags(calendar.command('set-due')
    .description('Set due date on a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<path>', 'Document path')
    .requiredOption('--date <date>', 'Due date (YYYY-MM-DD or "clear")')
    .option('--priority <priority>', 'Priority (low/medium/high)')
    .option('--recurrence <recurrence>', 'Recurrence (daily/weekly/monthly/yearly)'))
    .action(async (vaultId: string, path: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Setting due date...');
      try {
        const client = await getClientAsync();
        const dateStr = _opts.date as string;
        await client.calendar.setDocumentDue(vaultId, path, {
          dueAt: dateStr === 'clear' ? null : new Date(dateStr).toISOString(),
          priority: (_opts.priority as string) || null,
          recurrence: (_opts.recurrence as string) || null,
        });
        out.stopSpinner();
        out.status(dateStr === 'clear'
          ? chalk.green(`Due date cleared for ${path}`)
          : chalk.green(`Due date set to ${dateStr} for ${path}`)
        );
      } catch (err) {
        handleError(out, err, 'Set due date failed');
      }
    });

  // calendar events
  addGlobalFlags(calendar.command('events')
    .description('List calendar events')
    .argument('<vaultId>', 'Vault ID')
    .option('--start <date>', 'Start date')
    .option('--end <date>', 'End date'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading events...');
      try {
        const client = await getClientAsync();
        const events = await client.calendar.listEvents(vaultId, {
          start: _opts.start as string | undefined,
          end: _opts.end as string | undefined,
        });
        out.stopSpinner();
        out.list(
          events.map(e => ({
            title: e.title,
            startDate: e.startDate,
            priority: e.priority || '-',
            completed: e.completed ? '✓' : '-',
          })),
          {
            emptyMessage: 'No calendar events.',
            columns: [
              { key: 'title', header: 'Title' },
              { key: 'startDate', header: 'Date' },
              { key: 'priority', header: 'Priority' },
              { key: 'completed', header: 'Done' },
            ],
            textFn: (e) => `${chalk.cyan(String(e.title))} — ${chalk.dim(String(e.startDate))}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Calendar events failed');
      }
    });
}

function getDefaultStart(): string {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().split('T')[0];
}

function getDefaultEnd(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 0);
  return d.toISOString().split('T')[0];
}
