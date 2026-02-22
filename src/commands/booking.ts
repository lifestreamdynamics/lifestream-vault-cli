import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { Booking, WaitlistStatus } from '@lifestreamdynamics/vault-sdk';

export function registerBookingCommands(program: Command): void {
  const booking = program.command('booking').description('Booking slot and guest booking management');

  // ---------------------------------------------------------------------------
  // booking slots subgroup
  // ---------------------------------------------------------------------------
  const slots = booking.command('slots').description('Manage bookable event slots');

  // booking slots list
  addGlobalFlags(slots.command('list')
    .description('List all event slots for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading slots...');
      try {
        const client = await getClientAsync();
        const slotList = await client.booking.listSlots(vaultId);
        out.stopSpinner();
        out.list(
          slotList.map(s => ({
            id: s.id,
            title: s.title,
            duration: `${s.durationMin}min`,
            hours: `${s.startTime}–${s.endTime}`,
            days: s.daysOfWeek.join(','),
            timezone: s.timezone,
            active: s.isActive ? 'yes' : 'no',
            mode: s.confirmationMode,
            price: s.priceCents != null ? `${(s.priceCents / 100).toFixed(2)} ${s.currency}` : 'free',
            payment: s.requirePayment ? 'required' : 'no',
          })),
          {
            emptyMessage: 'No booking slots configured.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'title', header: 'Title' },
              { key: 'duration', header: 'Duration' },
              { key: 'hours', header: 'Hours' },
              { key: 'days', header: 'Days' },
              { key: 'timezone', header: 'Timezone' },
              { key: 'active', header: 'Active' },
              { key: 'mode', header: 'Confirmation' },
              { key: 'price', header: 'Price' },
              { key: 'payment', header: 'Payment' },
            ],
            textFn: (s) =>
              `${chalk.cyan(String(s.title))} — ${s.duration}, ${s.hours}, ${s.days} [${s.active === 'yes' ? chalk.green('active') : chalk.dim('inactive')}] ${s.price !== 'free' ? chalk.yellow(String(s.price)) : chalk.dim('free')}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'List slots failed');
      }
    });

  // booking slots create
  addGlobalFlags(slots.command('create')
    .description('Create a new bookable event slot')
    .argument('<vaultId>', 'Vault ID')
    .requiredOption('--title <title>', 'Slot title')
    .requiredOption('--duration <minutes>', 'Slot duration in minutes')
    .requiredOption('--start-time <HH:mm>', 'Availability window start time (HH:mm)')
    .requiredOption('--end-time <HH:mm>', 'Availability window end time (HH:mm)')
    .requiredOption('--days <days>', 'Comma-separated days of week (e.g. Mon,Tue,Wed)')
    .requiredOption('--timezone <tz>', 'Timezone (e.g. America/New_York)')
    .option('--buffer <minutes>', 'Buffer time between bookings in minutes', '0')
    .option('--max-concurrent <n>', 'Maximum concurrent bookings', '1')
    .option('--confirmation-mode <mode>', 'Confirmation mode: auto, email, manual', 'auto'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating slot...');
      try {
        const client = await getClientAsync();
        const created = await client.booking.createSlot(vaultId, {
          title: _opts.title as string,
          durationMin: Number(_opts.duration),
          startTime: _opts.startTime as string,
          endTime: _opts.endTime as string,
          daysOfWeek: (_opts.days as string).split(',').map((d: string) => d.trim()),
          timezone: _opts.timezone as string,
          bufferMin: Number(_opts.buffer),
          maxConcurrent: Number(_opts.maxConcurrent),
          confirmationMode: _opts.confirmationMode as 'auto' | 'email' | 'manual',
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(created, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Slot created: ${created.title} (${created.id})`));
        }
      } catch (err) {
        handleError(out, err, 'Create slot failed');
      }
    });

  // booking slots update
  addGlobalFlags(slots.command('update')
    .description('Update an existing event slot')
    .argument('<vaultId>', 'Vault ID')
    .argument('<slotId>', 'Slot ID')
    .option('--title <title>', 'Slot title')
    .option('--duration <minutes>', 'Slot duration in minutes')
    .option('--start-time <HH:mm>', 'Availability window start time (HH:mm)')
    .option('--end-time <HH:mm>', 'Availability window end time (HH:mm)')
    .option('--days <days>', 'Comma-separated days of week')
    .option('--timezone <tz>', 'Timezone')
    .option('--buffer <minutes>', 'Buffer time between bookings in minutes')
    .option('--max-concurrent <n>', 'Maximum concurrent bookings')
    .option('--confirmation-mode <mode>', 'Confirmation mode: auto, email, manual'))
    .action(async (vaultId: string, slotId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating slot...');
      try {
        const client = await getClientAsync();
        const data: Record<string, unknown> = {};
        if (_opts.title) data.title = _opts.title;
        if (_opts.duration) data.durationMin = Number(_opts.duration);
        if (_opts.startTime) data.startTime = _opts.startTime;
        if (_opts.endTime) data.endTime = _opts.endTime;
        if (_opts.days) data.daysOfWeek = (_opts.days as string).split(',').map((d: string) => d.trim());
        if (_opts.timezone) data.timezone = _opts.timezone;
        if (_opts.buffer) data.bufferMin = Number(_opts.buffer);
        if (_opts.maxConcurrent) data.maxConcurrent = Number(_opts.maxConcurrent);
        if (_opts.confirmationMode) data.confirmationMode = _opts.confirmationMode;
        const updated = await client.booking.updateSlot(vaultId, slotId, data);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Slot updated: ${updated.title}`));
        }
      } catch (err) {
        handleError(out, err, 'Update slot failed');
      }
    });

  // booking slots delete
  addGlobalFlags(slots.command('delete')
    .description('Delete an event slot')
    .argument('<vaultId>', 'Vault ID')
    .argument('<slotId>', 'Slot ID')
    .option('--confirm', 'Skip confirmation prompt'))
    .action(async (vaultId: string, slotId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.confirm) {
        out.status(chalk.yellow(`Pass --confirm to delete slot ${slotId}.`));
        return;
      }
      out.startSpinner('Deleting slot...');
      try {
        const client = await getClientAsync();
        await client.booking.deleteSlot(vaultId, slotId);
        out.stopSpinner();
        out.status(chalk.green(`Slot ${slotId} deleted.`));
      } catch (err) {
        handleError(out, err, 'Delete slot failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking list
  // ---------------------------------------------------------------------------
  addGlobalFlags(booking.command('list')
    .description('List bookings for a vault')
    .argument('<vaultId>', 'Vault ID')
    .option('--status <status>', 'Filter by status (pending/confirmed/cancelled/no_show/completed)')
    .option('--slot-id <slotId>', 'Filter by slot ID')
    .option('--from <date>', 'Filter bookings from this date (YYYY-MM-DD)')
    .option('--to <date>', 'Filter bookings to this date (YYYY-MM-DD)'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading bookings...');
      try {
        const client = await getClientAsync();
        const result = await client.booking.listBookings(vaultId, {
          status: _opts.status as Booking['status'] | undefined,
          slotId: _opts.slotId as string | undefined,
          startAfter: _opts.from as string | undefined,
          startBefore: _opts.to as string | undefined,
        });
        out.stopSpinner();
        out.list(
          result.bookings.map(b => ({
            id: b.id,
            guest: `${b.guestName} <${b.guestEmail}>`,
            start: b.startAt.replace('T', ' ').slice(0, 16),
            end: b.endAt.replace('T', ' ').slice(0, 16),
            status: b.status,
            payment: b.paymentStatus ?? 'unpaid',
          })),
          {
            emptyMessage: 'No bookings found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'guest', header: 'Guest' },
              { key: 'start', header: 'Start' },
              { key: 'end', header: 'End' },
              { key: 'status', header: 'Status' },
              { key: 'payment', header: 'Payment' },
            ],
            textFn: (b) => {
              const statusColor =
                b.status === 'confirmed' ? chalk.green :
                b.status === 'cancelled' ? chalk.red :
                b.status === 'pending' ? chalk.yellow : chalk.dim;
              const paymentColor =
                b.payment === 'paid' ? chalk.green :
                b.payment === 'invoiced' ? chalk.yellow :
                b.payment === 'unpaid' ? chalk.dim : chalk.blue;
              return `${chalk.cyan(String(b.guest))} ${chalk.dim(String(b.start))} ${statusColor(String(b.status))} [${paymentColor(String(b.payment))}]`;
            },
          },
        );
        if (flags.output !== 'json') {
          out.status(chalk.dim(`${result.total} total`));
        }
      } catch (err) {
        handleError(out, err, 'List bookings failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking confirm
  // ---------------------------------------------------------------------------
  addGlobalFlags(booking.command('confirm')
    .description('Confirm a pending booking')
    .argument('<vaultId>', 'Vault ID')
    .argument('<bookingId>', 'Booking ID'))
    .action(async (vaultId: string, bookingId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Confirming booking...');
      try {
        const client = await getClientAsync();
        const updated = await client.booking.updateBookingStatus(vaultId, bookingId, 'confirmed');
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Booking ${bookingId} confirmed.`));
        }
      } catch (err) {
        handleError(out, err, 'Confirm booking failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking cancel
  // ---------------------------------------------------------------------------
  addGlobalFlags(booking.command('cancel')
    .description('Cancel a booking')
    .argument('<vaultId>', 'Vault ID')
    .argument('<bookingId>', 'Booking ID'))
    .action(async (vaultId: string, bookingId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Cancelling booking...');
      try {
        const client = await getClientAsync();
        const updated = await client.booking.updateBookingStatus(vaultId, bookingId, 'cancelled');
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Booking ${bookingId} cancelled.`));
        }
      } catch (err) {
        handleError(out, err, 'Cancel booking failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking templates subgroup
  // ---------------------------------------------------------------------------
  const templates = booking.command('templates').description('Manage event templates');

  // booking templates list
  addGlobalFlags(templates.command('list')
    .description('List event templates for a vault')
    .argument('<vaultId>', 'Vault ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading templates...');
      try {
        const client = await getClientAsync();
        const list = await client.booking.listTemplates(vaultId);
        out.stopSpinner();
        out.list(
          list.map(t => ({
            id: t.id,
            name: t.name,
            description: t.description ?? '',
            created: t.createdAt.slice(0, 10),
          })),
          {
            emptyMessage: 'No templates found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'description', header: 'Description' },
              { key: 'created', header: 'Created' },
            ],
            textFn: (t) => `${chalk.cyan(String(t.name))} ${chalk.dim(String(t.description))}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'List templates failed');
      }
    });

  // booking templates create
  addGlobalFlags(templates.command('create')
    .description('Create an event template')
    .argument('<vaultId>', 'Vault ID')
    .requiredOption('--name <name>', 'Template name')
    .option('--description <desc>', 'Template description')
    .option('--defaults <json>', 'Default values (JSON string)', '{}'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating template...');
      try {
        const client = await getClientAsync();
        const created = await client.booking.createTemplate(vaultId, {
          name: _opts.name as string,
          description: _opts.description as string | undefined,
          defaults: JSON.parse(_opts.defaults as string) as Record<string, unknown>,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(created, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Template created: ${created.name} (${created.id})`));
        }
      } catch (err) {
        handleError(out, err, 'Create template failed');
      }
    });

  // booking templates delete
  addGlobalFlags(templates.command('delete')
    .description('Delete an event template')
    .argument('<vaultId>', 'Vault ID')
    .argument('<templateId>', 'Template ID')
    .option('--confirm', 'Skip confirmation prompt'))
    .action(async (vaultId: string, templateId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.confirm) {
        out.status(chalk.yellow(`Pass --confirm to delete template ${templateId}.`));
        return;
      }
      out.startSpinner('Deleting template...');
      try {
        const client = await getClientAsync();
        await client.booking.deleteTemplate(vaultId, templateId);
        out.stopSpinner();
        out.status(chalk.green(`Template ${templateId} deleted.`));
      } catch (err) {
        handleError(out, err, 'Delete template failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking reschedule
  // ---------------------------------------------------------------------------
  addGlobalFlags(booking.command('reschedule')
    .description('Reschedule a booking by guest reschedule token')
    .argument('<token>', 'Reschedule token (from guest email link)')
    .argument('<newStartAt>', 'New start time in ISO 8601 format (e.g. 2026-03-15T10:00:00Z)'))
    .action(async (token: string, newStartAt: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Rescheduling booking...');
      try {
        const client = await getClientAsync();
        const result = await client.booking.rescheduleBooking(token, newStartAt);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(result, null, 2) + '\n');
        } else {
          out.status(
            chalk.green(
              `Booking rescheduled for ${result.guestName} at ${new Date(result.startAt).toLocaleString()}`,
            ),
          );
        }
      } catch (err) {
        handleError(out, err, 'Reschedule booking failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking analytics (Business tier)
  // ---------------------------------------------------------------------------
  addGlobalFlags(booking.command('analytics')
    .description('View booking analytics (Business tier)')
    .argument('<vaultId>', 'Vault ID')
    .option('--view <view>', 'Analytics view: volume, funnel, peak-times', 'volume')
    .option('--from <date>', 'Start date (YYYY-MM-DD)')
    .option('--to <date>', 'End date (YYYY-MM-DD)')
    .option('--slot-id <slotId>', 'Filter by slot ID'))
    .action(async (vaultId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading analytics...');
      try {
        const client = await getClientAsync();
        const result = await client.booking.getBookingAnalytics(vaultId, {
          view: _opts.view as 'volume' | 'funnel' | 'peak-times' | undefined,
          from: _opts.from as string | undefined,
          to: _opts.to as string | undefined,
          slotId: _opts.slotId as string | undefined,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(result, null, 2) + '\n');
        } else {
          out.status(chalk.cyan(`Booking Analytics (${result.view})`));
          if (result.data.length === 0) {
            out.status(chalk.dim('No data available.'));
          } else {
            const columns = Object.keys(result.data[0]).map((k) => ({ key: k, header: k }));
            out.list(result.data as Array<Record<string, unknown>>, {
              emptyMessage: 'No data.',
              columns,
              textFn: (row) =>
                Object.values(row as Record<string, unknown>)
                  .map(String)
                  .join(' | '),
            });
          }
        }
      } catch (err) {
        handleError(out, err, 'Load analytics failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking groups subgroup (Business tier — round-robin team scheduling)
  // ---------------------------------------------------------------------------
  const groups = booking.command('groups').description('Manage team booking groups (Business tier)');

  // booking groups list <teamId>
  addGlobalFlags(groups.command('list')
    .description('List booking groups for a team')
    .argument('<teamId>', 'Team ID'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading booking groups...');
      try {
        const client = await getClientAsync();
        const list = await client.booking.listBookingGroups(teamId);
        out.stopSpinner();
        out.list(
          list.map((g) => ({
            id: g.id,
            name: g.name,
            mode: g.assignmentMode,
            active: g.isActive ? 'yes' : 'no',
          })),
          {
            emptyMessage: 'No booking groups found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'name', header: 'Name' },
              { key: 'mode', header: 'Mode' },
              { key: 'active', header: 'Active' },
            ],
            textFn: (g) =>
              `${chalk.cyan(String(g.name))} [${g.mode}] ${g.active === 'yes' ? chalk.green('active') : chalk.dim('inactive')}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'List booking groups failed');
      }
    });

  // booking groups create <teamId>
  addGlobalFlags(groups.command('create')
    .description('Create a new booking group for a team')
    .argument('<teamId>', 'Team ID')
    .requiredOption('--name <name>', 'Group name')
    .option('--mode <mode>', 'Assignment mode: round_robin, least_busy, attendee_choice', 'round_robin'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating booking group...');
      try {
        const client = await getClientAsync();
        const created = await client.booking.createBookingGroup(teamId, {
          name: _opts.name as string,
          assignmentMode: _opts.mode as 'round_robin' | 'least_busy' | 'attendee_choice',
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(created, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Booking group created: ${created.name} (${created.id})`));
        }
      } catch (err) {
        handleError(out, err, 'Create booking group failed');
      }
    });

  // booking groups update <teamId> <groupId>
  addGlobalFlags(groups.command('update')
    .description('Update a booking group')
    .argument('<teamId>', 'Team ID')
    .argument('<groupId>', 'Group ID')
    .option('--name <name>', 'Group name')
    .option('--mode <mode>', 'Assignment mode: round_robin, least_busy, attendee_choice')
    .option('--active <bool>', 'Set active status (true/false)'))
    .action(async (teamId: string, groupId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating booking group...');
      try {
        const client = await getClientAsync();
        const data: Record<string, unknown> = {};
        if (_opts.name) data.name = _opts.name;
        if (_opts.mode) data.assignmentMode = _opts.mode;
        if (_opts.active !== undefined) data.isActive = String(_opts.active) !== 'false';
        const updated = await client.booking.updateBookingGroup(teamId, groupId, data);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.status(chalk.green(`Booking group updated: ${updated.name}`));
        }
      } catch (err) {
        handleError(out, err, 'Update booking group failed');
      }
    });

  // booking groups delete <teamId> <groupId>
  addGlobalFlags(groups.command('delete')
    .description('Delete a booking group')
    .argument('<teamId>', 'Team ID')
    .argument('<groupId>', 'Group ID')
    .option('--confirm', 'Skip confirmation prompt'))
    .action(async (teamId: string, groupId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.confirm) {
        out.status(chalk.yellow(`Pass --confirm to delete booking group ${groupId}.`));
        return;
      }
      out.startSpinner('Deleting booking group...');
      try {
        const client = await getClientAsync();
        await client.booking.deleteBookingGroup(teamId, groupId);
        out.stopSpinner();
        out.status(chalk.green(`Booking group ${groupId} deleted.`));
      } catch (err) {
        handleError(out, err, 'Delete booking group failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking group-members subgroup (Business tier)
  // ---------------------------------------------------------------------------
  const groupMembers = booking
    .command('group-members')
    .description('Manage members of team booking groups (Business tier)');

  // booking group-members list <teamId> <groupId>
  addGlobalFlags(groupMembers.command('list')
    .description('List members of a booking group')
    .argument('<teamId>', 'Team ID')
    .argument('<groupId>', 'Group ID'))
    .action(async (teamId: string, groupId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading group members...');
      try {
        const client = await getClientAsync();
        const members = await client.booking.listGroupMembers(teamId, groupId);
        out.stopSpinner();
        out.list(
          members.map((m) => ({
            userId: m.userId,
            name: m.user.displayName,
            email: m.user.email,
            weight: String(m.weight),
          })),
          {
            emptyMessage: 'No members in this booking group.',
            columns: [
              { key: 'userId', header: 'User ID' },
              { key: 'name', header: 'Name' },
              { key: 'email', header: 'Email' },
              { key: 'weight', header: 'Weight' },
            ],
            textFn: (m) => `${chalk.cyan(String(m.name))} <${m.email}> weight=${m.weight}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'List group members failed');
      }
    });

  // booking group-members add <teamId> <groupId>
  addGlobalFlags(groupMembers.command('add')
    .description('Add a member to a booking group')
    .argument('<teamId>', 'Team ID')
    .argument('<groupId>', 'Group ID')
    .requiredOption('--user-id <userId>', 'User ID to add')
    .option('--weight <n>', 'Scheduling weight (default 1)', '1'))
    .action(async (teamId: string, groupId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Adding group member...');
      try {
        const client = await getClientAsync();
        const member = await client.booking.addGroupMember(teamId, groupId, {
          userId: _opts.userId as string,
          weight: Number(_opts.weight ?? 1),
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(member, null, 2) + '\n');
        } else {
          out.status(
            chalk.green(`Added ${member.user.displayName} (${member.userId}) to booking group.`),
          );
        }
      } catch (err) {
        handleError(out, err, 'Add group member failed');
      }
    });

  // booking group-members remove <teamId> <groupId> <userId>
  addGlobalFlags(groupMembers.command('remove')
    .description('Remove a member from a booking group')
    .argument('<teamId>', 'Team ID')
    .argument('<groupId>', 'Group ID')
    .argument('<userId>', 'User ID to remove'))
    .action(async (teamId: string, groupId: string, userId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Removing group member...');
      try {
        const client = await getClientAsync();
        await client.booking.removeGroupMember(teamId, groupId, userId);
        out.stopSpinner();
        out.status(chalk.green(`User ${userId} removed from booking group.`));
      } catch (err) {
        handleError(out, err, 'Remove group member failed');
      }
    });

  // ---------------------------------------------------------------------------
  // booking waitlist subgroup (Business tier)
  // ---------------------------------------------------------------------------
  const waitlist = booking.command('waitlist').description('Manage booking waitlists (Business tier)');

  // booking waitlist list <vaultId> <slotId>
  addGlobalFlags(waitlist.command('list')
    .description('List waitlist entries for a booking slot')
    .argument('<vaultId>', 'Vault ID')
    .argument('<slotId>', 'Slot ID')
    .option('--status <status>', 'Filter by status (waiting/notified/expired/left)')
    .option('--start-at <iso>', 'Filter by specific start time (ISO 8601)'))
    .action(async (vaultId: string, slotId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading waitlist...');
      try {
        const client = await getClientAsync();
        const result = await client.booking.getWaitlist(vaultId, slotId, {
          status: _opts.status as WaitlistStatus | undefined,
          startAt: _opts.startAt as string | undefined,
        });
        out.stopSpinner();
        out.list(
          result.entries.map((e) => ({
            position: String(e.position),
            guest: e.guestName,
            email: e.guestEmail,
            status: e.status,
            notified: e.notifiedAt ? e.notifiedAt.replace('T', ' ').slice(0, 16) : '',
            expires: e.expiresAt ? e.expiresAt.replace('T', ' ').slice(0, 16) : '',
            created: e.createdAt.replace('T', ' ').slice(0, 16),
          })),
          {
            emptyMessage: 'No waitlist entries found.',
            columns: [
              { key: 'position', header: '#' },
              { key: 'guest', header: 'Guest' },
              { key: 'email', header: 'Email' },
              { key: 'status', header: 'Status' },
              { key: 'notified', header: 'Notified' },
              { key: 'expires', header: 'Expires' },
              { key: 'created', header: 'Joined' },
            ],
            textFn: (e) => {
              const statusColor =
                e.status === 'waiting' ? chalk.yellow :
                e.status === 'notified' ? chalk.cyan :
                e.status === 'expired' ? chalk.dim :
                chalk.red;
              return `${chalk.bold(String(e.position))}. ${chalk.cyan(String(e.guest))} <${e.email}> ${statusColor(String(e.status))} ${chalk.dim(String(e.created))}`;
            },
          },
        );
        if (flags.output !== 'json') {
          out.status(chalk.dim(`${result.total} total`));
        }
      } catch (err) {
        handleError(out, err, 'List waitlist failed');
      }
    });
}
