import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { resolveVaultId } from '../utils/resolve-vault.js';

const NAMED_COLORS: Record<string, string> = {
  red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ff8c00', purple: '#800080', pink: '#ff69b4', cyan: '#00ffff',
  white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080',
};

/** Resolve a color value to #RRGGBB hex format. Pass through if already hex. */
function resolveColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const hex = NAMED_COLORS[value.toLowerCase()];
  if (hex) return hex;
  return value; // pass through (API validates the format)
}

export function registerCalendarCommands(program: Command): void {
  const calendar = program.command('calendar').description('Document calendar and due date management');

  // calendar view
  addGlobalFlags(calendar.command('view')
    .description('View calendar activity for a vault')
    .argument('<vaultId>', 'Vault ID or slug')
    .option('--start <date>', 'Start date (YYYY-MM-DD)')
    .option('--end <date>', 'End date (YYYY-MM-DD)'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading calendar...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const response = await client.calendar.getActivity(vaultId, {
          start: (_opts.start as string | undefined) ?? getDefaultStart(),
          end: (_opts.end as string | undefined) ?? getDefaultEnd(),
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
  const VALID_DUE_STATUSES = ['overdue', 'upcoming', 'all'] as const;
  type DueStatus = typeof VALID_DUE_STATUSES[number];

  addGlobalFlags(calendar.command('due')
    .description('List documents with due dates')
    .argument('<vaultId>', 'Vault ID or slug')
    .option('--status <status>', 'Filter: overdue, upcoming, all', 'all'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const statusVal = _opts.status as string | undefined;
      if (statusVal && !VALID_DUE_STATUSES.includes(statusVal as DueStatus)) {
        out.error(`Invalid --status "${statusVal}". Must be one of: ${VALID_DUE_STATUSES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      out.startSpinner('Loading due dates...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const docs = await client.calendar.getDueDates(vaultId, {
          status: (statusVal ?? 'all') as DueStatus,
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<path>', 'Document path')
    .requiredOption('--date <date>', 'Due date (YYYY-MM-DD or "clear")')
    .option('--priority <priority>', 'Priority (low/medium/high)')
    .option('--recurrence <recurrence>', 'Recurrence (daily/weekly/monthly/yearly)'))
    .action(async (vaultId: string, path: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Setting due date...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .description('Full CRUD management for calendar events (list, create, update, delete)')
    .argument('<vaultId>', 'Vault ID or slug')
    .option('--start <date>', 'Start date')
    .option('--end <date>', 'End date'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading events...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .argument('<vaultId>', 'Vault ID or slug')
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
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const created = await client.calendar.createEvent(vaultId, {
          title: _opts.title as string,
          startDate: _opts.start as string,
          endDate: _opts.end as string | undefined,
          allDay: Boolean(_opts.allDay),
          priority: _opts.priority as string | undefined,
          color: resolveColor(_opts.color as string | undefined),
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
    .argument('<vaultId>', 'Vault ID or slug')
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
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const data: Record<string, unknown> = {};
        if (_opts.title) data.title = _opts.title;
        if (_opts.start) data.startDate = _opts.start;
        if (_opts.end) data.endDate = _opts.end;
        if (_opts.allDay !== undefined) data.allDay = Boolean(_opts.allDay);
        if (_opts.priority) data.priority = _opts.priority;
        if (_opts.color) data.color = resolveColor(_opts.color as string | undefined);
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<eventId>', 'Event ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--confirm', 'Alias for --yes (deprecated)'))
    .action(async (vaultId: string, eventId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes && !_opts.confirm) {
        out.status(chalk.yellow(`Pass -y/--yes to delete event ${eventId}`));
        return;
      }
      out.startSpinner('Deleting event...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<eventId>', 'Event ID'))
    .action(async (vaultId: string, eventId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading event...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const ev = await client.calendar.getEvent(vaultId, eventId);
        out.stopSpinner();
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
    .description('Cursor-paginated event feed with before/after navigation')
    .argument('<vaultId>', 'Vault ID or slug')
    .option('--limit <n>', 'Number of items to return')
    .option('--cursor <cursor>', 'Pagination cursor')
    .addHelpText('after', `
NOTE
  Use "events" for CRUD operations on calendar events.
  Use "timeline" for a cursor-paginated event feed across all event types.`))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading timeline...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading upcoming items...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Generating iCal token...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .argument('<vaultId>', 'Vault ID or slug')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--confirm', 'Alias for --yes (deprecated)'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes && !_opts.confirm) {
        out.status(chalk.yellow('Pass -y/--yes to revoke the iCal token. All subscribers will lose access.'));
        return;
      }
      out.startSpinner('Revoking iCal token...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<documentPath>', 'Document path')
    .option('--completed', 'Mark as complete (default)', true)
    .option('--no-completed', 'Mark as incomplete'))
    .action(async (vaultId: string, documentPath: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Toggling completion...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const completed = _opts.completed !== false;
        const result = await client.calendar.toggleComplete(vaultId, documentPath, completed);
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
    .argument('<vaultId>', 'Vault ID or slug')
    .option('--status <status>', 'Filter by status')
    .option('--range <range>', 'Time range: number of days, or week (7), month (30), quarter (90), year (365)')
    .option('--group-by <groupBy>', 'Group by field'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching agenda...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const rangeMap: Record<string, string> = { week: '7', month: '30', quarter: '90', year: '365' };
        const rawRange = _opts.range as string | undefined;
        const resolvedRange = rawRange ? (rangeMap[rawRange.toLowerCase()] ?? rawRange) : undefined;
        const agenda = await client.calendar.getAgenda(vaultId, {
          status: _opts.status as string | undefined,
          range: resolvedRange,
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
    .argument('<vaultId>', 'Vault ID or slug')
    .option('--include <types>', 'Types to include'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching iCal feed...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const ical = await client.calendar.getIcalFeed(vaultId, {
          include: _opts.include as string | undefined,
        });
        out.stopSpinner();
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
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading connectors...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const connectors = await client.calendar.listConnectors(vaultId);
        out.stopSpinner();
        out.list(
          connectors.map(c => ({
            id: c.id,
            provider: c.provider,
            expires: c.expiresAt ? c.expiresAt.split('T')[0] : '-',
            created: c.createdAt.split('T')[0],
          })),
          {
            emptyMessage: 'No calendar connectors.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'provider', header: 'Provider' },
              { key: 'expires', header: 'Expires' },
              { key: 'created', header: 'Created' },
            ],
            textFn: (c) => `${chalk.cyan(String(c.provider))} — expires: ${chalk.dim(String(c.expires))} — created: ${chalk.dim(String(c.created))}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'List connectors failed');
      }
    });

  // calendar connector sync
  addGlobalFlags(connector.command('sync')
    .description('Trigger a manual sync for a calendar connector')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<connectorId>', 'Connector ID'))
    .action(async (vaultId: string, connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Syncing connector...');
      try {
        vaultId = await resolveVaultId(vaultId);
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
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<connectorId>', 'Connector ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--confirm', 'Alias for --yes (deprecated)'))
    .action(async (vaultId: string, connectorId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes && !_opts.confirm) {
        out.status(chalk.yellow(`Pass -y/--yes to disconnect connector ${connectorId}.`));
        return;
      }
      out.startSpinner('Disconnecting connector...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        await client.calendar.disconnectConnector(vaultId, connectorId);
        out.stopSpinner();
        out.status(chalk.green(`Connector ${connectorId} disconnected.`));
      } catch (err) {
        handleError(out, err, 'Disconnect connector failed');
      }
    });

  // calendar connector connect
  addGlobalFlags(connector.command('connect')
    .description('Connect a Google or Outlook calendar to a vault via OAuth')
    .argument('<vaultId>', 'Vault ID or slug')
    .requiredOption('--provider <provider>', 'Calendar provider: google or outlook'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const provider = _opts.provider as string;
      if (provider !== 'google' && provider !== 'outlook') {
        out.status(chalk.red('--provider must be "google" or "outlook"'));
        process.exitCode = 1;
        return;
      }
      out.startSpinner(`Connecting ${provider} calendar...`);
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const result = provider === 'google'
          ? await client.calendar.connectGoogleCalendar(vaultId)
          : await client.calendar.connectOutlookCalendar(vaultId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.record({ authUrl: result.authUrl });
        } else {
          out.status(chalk.cyan('Open this URL to connect: ') + result.authUrl);
        }
      } catch (err) {
        handleError(out, err, 'Connect calendar failed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar participants subgroup (Pro tier)
  // ---------------------------------------------------------------------------
  const participants = calendar.command('participants').description('Manage event participants');

  // calendar participants list <vaultId> <eventId>
  addGlobalFlags(participants.command('list')
    .description('List participants for a calendar event')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<eventId>', 'Calendar event ID'))
    .action(async (vaultId: string, eventId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading participants...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const items = await client.calendar.listParticipants(vaultId, eventId);
        out.stopSpinner();
        out.list(
          items.map((p) => ({
            id: p.id,
            email: p.email,
            name: p.name ?? '-',
            role: p.role,
            status: p.status,
          })),
          {
            emptyMessage: 'No participants for this event.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'email', header: 'Email' },
              { key: 'name', header: 'Name' },
              { key: 'role', header: 'Role' },
              { key: 'status', header: 'Status' },
            ],
            textFn: (p) => {
              const statusColor =
                p.status === 'accepted'
                  ? chalk.green
                  : p.status === 'declined'
                    ? chalk.red
                    : chalk.yellow;
              return `${chalk.cyan(String(p.email))} (${p.role}) — ${statusColor(String(p.status))}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'List participants failed');
      }
    });

  // calendar participants add <vaultId> <eventId> --email <email> [--name <name>] [--role <role>]
  addGlobalFlags(participants.command('add')
    .description('Add a participant to a calendar event')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<eventId>', 'Calendar event ID')
    .requiredOption('--email <email>', 'Participant email address')
    .option('--name <name>', 'Participant display name')
    .option('--role <role>', 'Participant role: organizer, attendee, optional', 'attendee'))
    .action(async (vaultId: string, eventId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Adding participant...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const participant = await client.calendar.addParticipant(vaultId, eventId, {
          email: _opts.email as string,
          name: _opts.name as string | undefined,
          role: _opts.role as string | undefined,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(participant, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Participant added: ${participant.email} (${participant.id})`));
        }
      } catch (err) {
        handleError(out, err, 'Add participant failed');
      }
    });

  // calendar participants update <vaultId> <eventId> <participantId> --status <status>
  addGlobalFlags(participants.command('update')
    .description('Update a participant status')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<eventId>', 'Calendar event ID')
    .argument('<participantId>', 'Participant ID')
    .requiredOption('--status <status>', 'New status: accepted, declined, tentative'))
    .action(async (vaultId: string, eventId: string, participantId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating participant...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const participant = await client.calendar.updateParticipant(vaultId, eventId, participantId, {
          status: _opts.status as string,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(participant, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Participant ${participant.email} updated to ${participant.status}.`));
        }
      } catch (err) {
        handleError(out, err, 'Update participant failed');
      }
    });

  // calendar participants remove <vaultId> <eventId> <participantId>
  addGlobalFlags(participants.command('remove')
    .description('Remove a participant from a calendar event')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<eventId>', 'Calendar event ID')
    .argument('<participantId>', 'Participant ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--confirm', 'Alias for --yes (deprecated)'))
    .action(async (vaultId: string, eventId: string, participantId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes && !_opts.confirm) {
        out.status(chalk.yellow(`Pass -y/--yes to remove participant ${participantId}.`));
        return;
      }
      out.startSpinner('Removing participant...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        await client.calendar.removeParticipant(vaultId, eventId, participantId);
        out.stopSpinner();
        out.status(chalk.green(`Participant ${participantId} removed.`));
      } catch (err) {
        handleError(out, err, 'Remove participant failed');
      }
    });

  // ---------------------------------------------------------------------------
  // calendar templates subgroup (Pro tier)
  // ---------------------------------------------------------------------------
  const templates = calendar.command('templates').description('Manage calendar event templates');

  // calendar templates list
  addGlobalFlags(templates.command('list')
    .description('List event templates for a vault')
    .argument('<vaultId>', 'Vault ID or slug'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading templates...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const items = await client.calendar.listTemplates(vaultId);
        out.stopSpinner();
        out.list(
          items.map((t) => ({
            id: t.id,
            name: t.name,
            duration: String(t.duration),
            description: t.description ?? '-',
          })),
          {
            emptyMessage: 'No event templates.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'duration', header: 'Duration (min)' },
              { key: 'description', header: 'Description' },
            ],
            textFn: (t) => `${chalk.cyan(String(t.name))} — ${chalk.dim(String(t.duration))} min${t.description !== '-' ? ` — ${t.description}` : ''}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'List templates failed');
      }
    });

  // calendar templates create
  addGlobalFlags(templates.command('create')
    .description('Create a new event template for a vault')
    .argument('<vaultId>', 'Vault ID or slug')
    .requiredOption('--name <name>', 'Template name')
    .requiredOption('--duration <minutes>', 'Duration in minutes')
    .option('--description <description>', 'Template description')
    .option('--location <location>', 'Default location')
    .option('--color <color>', 'Default color (e.g. red, blue, #ff0000)'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating template...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const created = await client.calendar.createTemplate(vaultId, {
          name: _opts.name as string,
          duration: Number(_opts.duration),
          description: _opts.description as string | undefined,
          location: _opts.location as string | undefined,
          color: resolveColor(_opts.color as string | undefined),
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(created, null, 2) + '\n');
        } else {
          out.success(`Template created: ${created.name} (${created.id})`);
        }
      } catch (err) {
        handleError(out, err, 'Create template failed');
      }
    });

  // calendar templates get
  addGlobalFlags(templates.command('get')
    .description('Get a single event template by ID')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<templateId>', 'Template ID'))
    .action(async (vaultId: string, templateId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading template...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const t = await client.calendar.getTemplate(vaultId, templateId);
        out.stopSpinner();
        out.record({
          id: t.id,
          name: t.name,
          duration: String(t.duration),
          description: t.description ?? '-',
          location: t.location ?? '-',
          color: t.color ?? '-',
        });
      } catch (err) {
        handleError(out, err, 'Get template failed');
      }
    });

  // calendar templates update
  addGlobalFlags(templates.command('update')
    .description('Update an event template')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<templateId>', 'Template ID')
    .option('--name <name>', 'New template name')
    .option('--duration <minutes>', 'New duration in minutes')
    .option('--description <description>', 'New description')
    .option('--location <location>', 'Default location')
    .option('--color <color>', 'Default color (e.g. red, blue, #ff0000)'))
    .action(async (vaultId: string, templateId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating template...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        const data: Record<string, unknown> = {};
        if (_opts.name) data.name = _opts.name;
        if (_opts.duration) data.duration = Number(_opts.duration);
        if (_opts.description) data.description = _opts.description;
        if (_opts.location) data.location = _opts.location;
        if (_opts.color) data.color = resolveColor(_opts.color as string | undefined);
        const updated = await client.calendar.updateTemplate(vaultId, templateId, data);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.success(`Template updated: ${updated.name}`);
        }
      } catch (err) {
        handleError(out, err, 'Update template failed');
      }
    });

  // calendar templates delete
  addGlobalFlags(templates.command('delete')
    .description('Delete an event template')
    .argument('<vaultId>', 'Vault ID or slug')
    .argument('<templateId>', 'Template ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--confirm', 'Alias for --yes (deprecated)'))
    .action(async (vaultId: string, templateId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.yes && !_opts.confirm) {
        out.status(chalk.yellow(`Pass -y/--yes or --confirm to delete template ${templateId}`));
        return;
      }
      out.startSpinner('Deleting template...');
      try {
        vaultId = await resolveVaultId(vaultId);
        const client = await getClientAsync();
        await client.calendar.deleteTemplate(vaultId, templateId);
        out.stopSpinner();
        out.success(`Template ${templateId} deleted.`);
      } catch (err) {
        handleError(out, err, 'Delete template failed');
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
