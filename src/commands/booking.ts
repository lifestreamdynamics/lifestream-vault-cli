import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import type { Booking } from '@lifestreamdynamics/vault-sdk';

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
            ],
            textFn: (s) =>
              `${chalk.cyan(String(s.title))} — ${s.duration}, ${s.hours}, ${s.days} [${s.active === 'yes' ? chalk.green('active') : chalk.dim('inactive')}]`,
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
        const bookings = await client.booking.listBookings(vaultId, {
          status: _opts.status as Booking['status'] | undefined,
          slotId: _opts.slotId as string | undefined,
          startAfter: _opts.from as string | undefined,
          startBefore: _opts.to as string | undefined,
        });
        out.stopSpinner();
        out.list(
          bookings.map(b => ({
            id: b.id,
            guest: `${b.guestName} <${b.guestEmail}>`,
            start: b.startAt.replace('T', ' ').slice(0, 16),
            end: b.endAt.replace('T', ' ').slice(0, 16),
            status: b.status,
          })),
          {
            emptyMessage: 'No bookings found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'guest', header: 'Guest' },
              { key: 'start', header: 'Start' },
              { key: 'end', header: 'End' },
              { key: 'status', header: 'Status' },
            ],
            textFn: (b) => {
              const statusColor =
                b.status === 'confirmed' ? chalk.green :
                b.status === 'cancelled' ? chalk.red :
                b.status === 'pending' ? chalk.yellow : chalk.dim;
              return `${chalk.cyan(String(b.guest))} ${chalk.dim(String(b.start))} ${statusColor(String(b.status))}`;
            },
          },
        );
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
}
