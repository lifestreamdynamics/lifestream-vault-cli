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

  // calendar events (list)
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

  // ---------------------------------------------------------------------------
  // calendar event subgroup (CRUD)
  // ---------------------------------------------------------------------------
  const event = calendar.command('event').description('Calendar event CRUD operations');

  // calendar event create
  addGlobalFlags(event.command('create')
    .description('Create a new calendar event')
    .argument('<vaultId>', 'Vault ID')
    .requiredOption('--title <title>', 'Event title')
    .requiredOption('--start <date>', 'Start date/time (YYYY-MM-DD or ISO 8601)')
    .option('--end <date>', 'End date/time (YYYY-MM-DD or ISO 8601)')
    .option('--all-day', 'Mark as all-day event')
    .option('--priority <priority>', 'Priority (low/medium/high)')
    .option('--color <color>', 'Event color (e.g. red, blue, #ff0000)')
    .option('--description <description>', 'Event description'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating event...');
      try {
        const client = await getClientAsync();
        const created = await client.calendar.createEvent(vaultId, {
          title: _opts.title as string,
          startDate: _opts.start as string,
          endDate: _opts.end as string | undefined,
          allDay: Boolean(_opts.allDay),
          priority: _opts.priority as string | undefined,
          color: _opts.color as string | undefined,
          description: _opts.description as string | undefined,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(created, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Event created: ${created.title} (${created.id})`));
        }
      } catch (err) {
        handleError(out, err, 'Create event failed');
      }
    });

  // calendar event update
  addGlobalFlags(event.command('update')
    .description('Update an existing calendar event')
    .argument('<vaultId>', 'Vault ID')
    .argument('<eventId>', 'Event ID')
    .option('--title <title>', 'Event title')
    .option('--start <date>', 'Start date/time (YYYY-MM-DD or ISO 8601)')
    .option('--end <date>', 'End date/time')
    .option('--all-day', 'Mark as all-day event')
    .option('--priority <priority>', 'Priority (low/medium/high)')
    .option('--color <color>', 'Event color')
    .option('--description <description>', 'Event description'))
    .action(async (vaultId: string, eventId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating event...');
      try {
        const client = await getClientAsync();
        const data: Record<string, unknown> = {};
        if (_opts.title) data.title = _opts.title;
        if (_opts.start) data.startDate = _opts.start;
        if (_opts.end) data.endDate = _opts.end;
        if (_opts.allDay !== undefined) data.allDay = Boolean(_opts.allDay);
        if (_opts.priority) data.priority = _opts.priority;
        if (_opts.color) data.color = _opts.color;
        if (_opts.description) data.description = _opts.description;
        const updated = await client.calendar.updateEvent(vaultId, eventId, data);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Event updated: ${updated.title}`));
        }
      } catch (err) {
        handleError(out, err, 'Update event failed');
      }
    });

  // calendar event delete
  addGlobalFlags(event.command('delete')
    .description('Delete a calendar event')
    .argument('<vaultId>', 'Vault ID')
    .argument('<eventId>', 'Event ID')
    .option('--confirm', 'Skip confirmation prompt'))
    .action(async (vaultId: string, eventId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.confirm) {
        out.status(chalk.yellow(`Pass --confirm to delete event ${eventId}`));
        return;
      }
      out.startSpinner('Deleting event...');
      try {
        const client = await getClientAsync();
        await client.calendar.deleteEvent(vaultId, eventId);
        out.stopSpinner();
        out.status(chalk.green(`Event ${eventId} deleted.`));
      } catch (err) {
        handleError(out, err, 'Delete event failed');
      }
    });

  // calendar event get
  addGlobalFlags(event.command('get')
    .description('Get a single calendar event by ID')
    .argument('<vaultId>', 'Vault ID')
    .argument('<eventId>', 'Event ID'))
    .action(async (vaultId: string, eventId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading event...');
      try {
        const client = await getClientAsync();
        // listEvents does not support single-event lookup; fetch the list and filter
        const events = await client.calendar.listEvents(vaultId);
        const ev = events.find(e => e.id === eventId);
        out.stopSpinner();
        if (!ev) {
          out.status(chalk.red(`Event ${eventId} not found.`));
          return;
        }
        if (flags.output === 'json') {
          out.raw(JSON.stringify(ev, null, 2) + '\n');
        } else {
          out.status(`${chalk.bold(ev.title)}\nID: ${ev.id}\nDate: ${ev.startDate}${ev.endDate ? ` – ${ev.endDate}` : ''}\nPriority: ${ev.priority || '-'}\nCompleted: ${ev.completed ? 'yes' : 'no'}`);
        }
      } catch (err) {
        handleError(out, err, 'Get event failed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar timeline
  // ---------------------------------------------------------------------------
  addGlobalFlags(calendar.command('timeline')
    .description('View chronological event timeline for a vault')
    .argument('<vaultId>', 'Vault ID')
    .option('--limit <n>', 'Number of items to return')
    .option('--cursor <cursor>', 'Pagination cursor'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading timeline...');
      try {
        const client = await getClientAsync();
        const timeline = await client.calendar.getTimeline(vaultId, {
          limit: _opts.limit ? Number(_opts.limit) : undefined,
          cursor: _opts.cursor as string | undefined,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(timeline, null, 2) + '\n');
        } else {
          process.stdout.write(`${chalk.dim(`${timeline.total} total items`)}\n\n`);
          for (const item of timeline.items) {
            const label = item.type === 'event'
              ? chalk.cyan(item.event?.title ?? 'Event')
              : chalk.yellow((item.document as { path?: string })?.path ?? 'Document');
            process.stdout.write(`${chalk.dim(item.date)}  ${label} [${item.type}]\n`);
          }
          if (timeline.nextCursor) {
            process.stdout.write(chalk.dim(`\nNext cursor: ${timeline.nextCursor}\n`));
          }
        }
      } catch (err) {
        handleError(out, err, 'Timeline failed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar upcoming
  // ---------------------------------------------------------------------------
  addGlobalFlags(calendar.command('upcoming')
    .description('Show upcoming events and due items for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading upcoming items...');
      try {
        const client = await getClientAsync();
        const upcoming = await client.calendar.getUpcoming(vaultId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(upcoming, null, 2) + '\n');
        } else {
          process.stdout.write(chalk.bold('Upcoming Events\n'));
          if (upcoming.events.length === 0) {
            process.stdout.write(chalk.dim('  None\n'));
          } else {
            for (const e of upcoming.events) {
              process.stdout.write(`  ${chalk.cyan(e.title)} — ${chalk.dim(e.startDate)}\n`);
            }
          }
          process.stdout.write(chalk.bold('\nDue Documents\n'));
          if (upcoming.dueDocs.length === 0) {
            process.stdout.write(chalk.dim('  None\n'));
          } else {
            for (const d of upcoming.dueDocs) {
              const color = d.overdue ? chalk.red : chalk.yellow;
              process.stdout.write(`  ${color(d.path)} — due ${chalk.dim(d.dueAt)}\n`);
            }
          }
        }
      } catch (err) {
        handleError(out, err, 'Upcoming failed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar ical-token subgroup
  // ---------------------------------------------------------------------------
  const icalToken = calendar.command('ical-token').description('Manage iCal subscription tokens');

  // calendar ical-token generate
  addGlobalFlags(icalToken.command('generate')
    .description('Generate a new iCal subscription token for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Generating iCal token...');
      try {
        const client = await getClientAsync();
        const result = await client.calendar.generateICalToken(vaultId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(result, null, 2) + '\n');
        } else {
          out.status(chalk.green('iCal token generated.'));
          process.stdout.write(`Feed URL: ${chalk.cyan(result.feedUrl)}\nToken: ${result.token}\n`);
        }
      } catch (err) {
        handleError(out, err, 'Generate iCal token failed');
      }
    });

  // calendar ical-token revoke
  addGlobalFlags(icalToken.command('revoke')
    .description('Revoke the iCal subscription token for a vault')
    .argument('<vaultId>', 'Vault ID')
    .option('--confirm', 'Skip confirmation prompt'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.confirm) {
        out.status(chalk.yellow('Pass --confirm to revoke the iCal token. All subscribers will lose access.'));
        return;
      }
      out.startSpinner('Revoking iCal token...');
      try {
        const client = await getClientAsync();
        await client.calendar.revokeICalToken(vaultId);
        out.stopSpinner();
        out.status(chalk.green('iCal token revoked.'));
      } catch (err) {
        handleError(out, err, 'Revoke iCal token failed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar complete
  // ---------------------------------------------------------------------------
  addGlobalFlags(calendar.command('complete')
    .description('Toggle completed state for a document')
    .argument('<vaultId>', 'Vault ID')
    .argument('<documentPath>', 'Document path'))
    .action(async (vaultId: string, documentPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Toggling completion...');
      try {
        const client = await getClientAsync();
        const result = await client.calendar.toggleComplete(vaultId, documentPath);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(result, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Completion toggled for ${documentPath}`));
        }
      } catch (err) {
        handleError(out, err, 'Toggle completion failed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar agenda
  // ---------------------------------------------------------------------------
  addGlobalFlags(calendar.command('agenda')
    .description('View due-date agenda grouped by time period')
    .argument('<vaultId>', 'Vault ID')
    .option('--status <status>', 'Filter by status')
    .option('--range <range>', 'Time range (e.g., week, month)')
    .option('--group-by <groupBy>', 'Group by field'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching agenda...');
      try {
        const client = await getClientAsync();
        const agenda = await client.calendar.getAgenda(vaultId, {
          status: _opts.status as string | undefined,
          range: _opts.range as string | undefined,
          groupBy: _opts.groupBy as string | undefined,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(agenda, null, 2) + '\n');
        } else {
          process.stdout.write(`Total: ${agenda.total} items\n\n`);
          for (const group of agenda.groups) {
            process.stdout.write(`${chalk.bold(group.label)}\n`);
            for (const item of group.items) {
              process.stdout.write(`  ${chalk.cyan((item as { path?: string }).path ?? '')} — due: ${String((item as { dueAt?: string }).dueAt ?? 'N/A')}\n`);
            }
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch agenda');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar ical (raw feed output)
  // ---------------------------------------------------------------------------
  addGlobalFlags(calendar.command('ical')
    .description('Output iCal feed for a vault to stdout')
    .argument('<vaultId>', 'Vault ID')
    .option('--include <types>', 'Types to include'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const client = await getClientAsync();
        const ical = await client.calendar.getIcalFeed(vaultId, {
          include: _opts.include as string | undefined,
        });
        process.stdout.write(ical);
      } catch (err) {
        handleError(out, err, 'Failed to fetch iCal feed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar connector subgroup (Phase 6.6)
  // ---------------------------------------------------------------------------
  const connector = calendar.command('connector').description('Calendar connector management');

  // calendar connector list
  addGlobalFlags(connector.command('list')
    .description('List calendar connectors for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading connectors...');
      try {
        const client = await getClientAsync();
        const connectors = await client.calendar.listConnectors(vaultId);
        out.stopSpinner();
        out.list(
          connectors.map(c => ({
            id: c.id,
            provider: c.provider,
            account: c.accountEmail || '-',
            direction: c.syncDirection,
            active: c.isActive ? 'yes' : 'no',
            lastSync: c.lastSyncedAt ? c.lastSyncedAt.split('T')[0] : '-',
          })),
          {
            emptyMessage: 'No calendar connectors.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'provider', header: 'Provider' },
              { key: 'account', header: 'Account' },
              { key: 'direction', header: 'Direction' },
              { key: 'active', header: 'Active' },
              { key: 'lastSync', header: 'Last Sync' },
            ],
            textFn: (c) => `${chalk.cyan(String(c.provider))} (${c.account}) — ${c.direction} — last sync: ${chalk.dim(String(c.lastSync))}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'List connectors failed');
      }
    });

  // calendar connector sync
  addGlobalFlags(connector.command('sync')
    .description('Trigger a manual sync for a calendar connector')
    .argument('<vaultId>', 'Vault ID')
    .argument('<connectorId>', 'Connector ID'))
    .action(async (vaultId: string, connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Syncing connector...');
      try {
        const client = await getClientAsync();
        const result = await client.calendar.syncConnector(vaultId, connectorId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(result, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Sync complete. ${result.synced} synced, ${result.errors} errors.`));
        }
      } catch (err) {
        handleError(out, err, 'Sync connector failed');
      }
    });

  // calendar connector disconnect
  addGlobalFlags(connector.command('disconnect')
    .description('Disconnect a calendar connector from a vault')
    .argument('<vaultId>', 'Vault ID')
    .argument('<connectorId>', 'Connector ID')
    .option('--confirm', 'Skip confirmation prompt'))
    .action(async (vaultId: string, connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.confirm) {
        out.status(chalk.yellow(`Pass --confirm to disconnect connector ${connectorId}.`));
        return;
      }
      out.startSpinner('Disconnecting connector...');
      try {
        const client = await getClientAsync();
        await client.calendar.disconnectConnector(vaultId, connectorId);
        out.stopSpinner();
        out.status(chalk.green(`Connector ${connectorId} disconnected.`));
      } catch (err) {
        handleError(out, err, 'Disconnect connector failed');
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
