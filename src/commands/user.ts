import type { Command } from 'commander';
import chalk from 'chalk';
import { writeFile } from 'node:fs/promises';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { formatBytes } from '../utils/format.js';
import { promptPassword, readPasswordFromStdin } from '../utils/prompt.js';

export function registerUserCommands(program: Command): void {
  const user = program.command('user').description('View account details and storage usage');

  addGlobalFlags(user.command('storage')
    .description('Show storage usage breakdown by vault and plan limits'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching storage usage...');
      try {
        const client = await getClientAsync();
        const storage = await client.user.getStorage();
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({
            tier: storage.tier,
            totalBytes: storage.totalBytes,
            limitBytes: storage.limitBytes,
            vaultCount: storage.vaultCount,
            vaultLimit: storage.vaultLimit,
            vaults: storage.vaults,
          });
        } else {
          const pct = storage.limitBytes > 0
            ? ((storage.totalBytes / storage.limitBytes) * 100).toFixed(1)
            : '0.0';
          process.stdout.write(`Plan:     ${chalk.green(storage.tier)}\n`);
          process.stdout.write(`Storage:  ${formatBytes(storage.totalBytes)} / ${formatBytes(storage.limitBytes)} (${pct}%)\n`);
          process.stdout.write(`Vaults:   ${storage.vaultCount} / ${storage.vaultLimit}\n`);

          if (storage.vaults.length > 0) {
            process.stdout.write('\n');
            process.stdout.write(chalk.dim('Per-vault breakdown:') + '\n');
            for (const v of storage.vaults) {
              process.stdout.write(`  ${chalk.cyan(v.name)}: ${formatBytes(v.bytes)} (${v.documentCount} docs)\n`);
            }
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch storage usage');
      }
    });

  // user me
  addGlobalFlags(user.command('me')
    .description('Show your user profile'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching profile...');
      try {
        const client = await getClientAsync();
        const me = await client.user.me();
        out.stopSpinner();
        out.record({ id: me.id, email: me.email, displayName: me.displayName, role: me.role, createdAt: me.createdAt });
      } catch (err) {
        handleError(out, err, 'Failed to fetch profile');
      }
    });

  // user password
  addGlobalFlags(user.command('password')
    .description('Change your password')
    .option('--password-stdin', 'Read current and new passwords from stdin (one per line) for CI usage'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      let currentPassword: string | null;
      let newPassword: string | null;

      if (_opts.passwordStdin) {
        currentPassword = await readPasswordFromStdin();
        newPassword = await readPasswordFromStdin();
      } else {
        currentPassword = await promptPassword('Current password: ');
        if (!currentPassword) {
          out.error('Current password is required.');
          process.exitCode = 1;
          return;
        }
        newPassword = await promptPassword('New password: ');
      }

      if (!currentPassword) {
        out.error('Current password is required.');
        process.exitCode = 1;
        return;
      }
      if (!newPassword) {
        out.error('New password is required.');
        process.exitCode = 1;
        return;
      }

      out.startSpinner('Changing password...');
      try {
        const client = await getClientAsync();
        await client.user.changePassword({ currentPassword, newPassword });
        out.success('Password changed successfully', { changed: true });
      } catch (err) {
        handleError(out, err, 'Failed to change password');
      }
    });

  // user email
  addGlobalFlags(user.command('email')
    .description('Request email address change')
    .requiredOption('--new <email>', 'New email address')
    .option('--password-stdin', 'Read password from stdin for CI usage'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      let password: string | null;
      if (_opts.passwordStdin) {
        password = await readPasswordFromStdin();
      } else {
        password = await promptPassword('Password: ');
      }

      if (!password) {
        out.error('Password is required to change your email address.');
        process.exitCode = 1;
        return;
      }

      out.startSpinner('Requesting email change...');
      try {
        const client = await getClientAsync();
        const result = await client.user.requestEmailChange({ newEmail: _opts.new as string, password });
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to request email change');
      }
    });

  // user email-verify
  addGlobalFlags(user.command('email-verify')
    .description('Confirm email change with verification token')
    .requiredOption('--token <token>', 'Verification token from email'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Verifying email change...');
      try {
        const client = await getClientAsync();
        const result = await client.user.confirmEmailChange(_opts.token as string);
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to verify email change');
      }
    });

  // user profile
  addGlobalFlags(user.command('profile')
    .description('Update your profile')
    .option('--name <name>', 'Display name')
    .option('--slug <slug>', 'Profile URL slug'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating profile...');
      try {
        const client = await getClientAsync();
        const result = await client.user.updateProfile({ displayName: _opts.name as string | undefined, profileSlug: _opts.slug as string | undefined });
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to update profile');
      }
    });

  // user delete
  addGlobalFlags(user.command('delete')
    .description('Request account deletion')
    .option('--password-stdin', 'Read password from stdin for CI usage')
    .option('--reason <reason>', 'Reason for deletion')
    .option('--export-data', 'Request data export before deletion'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      let password: string | null;
      if (_opts.passwordStdin) {
        password = await readPasswordFromStdin();
      } else {
        password = await promptPassword('Password: ');
      }

      if (!password) {
        out.error('Password is required to delete your account.');
        process.exitCode = 1;
        return;
      }

      out.startSpinner('Requesting account deletion...');
      try {
        const client = await getClientAsync();
        const result = await client.user.requestAccountDeletion({
          password,
          reason: _opts.reason as string | undefined,
          exportData: _opts.exportData === true,
        });
        out.success(result.message, { message: result.message, scheduledAt: result.scheduledAt });
      } catch (err) {
        handleError(out, err, 'Failed to request account deletion');
      }
    });

  // user delete-cancel
  addGlobalFlags(user.command('delete-cancel')
    .description('Cancel a pending account deletion'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Cancelling account deletion...');
      try {
        const client = await getClientAsync();
        const result = await client.user.cancelAccountDeletion();
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to cancel account deletion');
      }
    });

  // user sessions subgroup
  const sessions = user.command('sessions').description('Session management');

  addGlobalFlags(sessions.command('list')
    .description('List active sessions'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching sessions...');
      try {
        const client = await getClientAsync();
        const list = await client.user.getSessions();
        out.stopSpinner();
        out.list(
          list.map(s => ({ id: s.id, current: s.current ? 'yes' : 'no', ip: s.ipAddress || '', createdAt: s.createdAt, lastSeen: s.lastSeenAt })),
          {
            emptyMessage: 'No sessions found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'current', header: 'Current' },
              { key: 'ip', header: 'IP' },
              { key: 'createdAt', header: 'Created' },
              { key: 'lastSeen', header: 'Last Seen' },
            ],
            textFn: (s) => `${String(s.id)} ${s.current === 'yes' ? chalk.green('[current]') : ''} — ${String(s.ip)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch sessions');
      }
    });

  addGlobalFlags(sessions.command('revoke')
    .description('Revoke a session')
    .argument('<sessionId>', 'Session ID'))
    .action(async (sessionId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Revoking session...');
      try {
        const client = await getClientAsync();
        const result = await client.user.revokeSession(sessionId);
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to revoke session');
      }
    });

  addGlobalFlags(sessions.command('revoke-all')
    .description('Revoke all sessions'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Revoking all sessions...');
      try {
        const client = await getClientAsync();
        const result = await client.user.revokeAllSessions();
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to revoke sessions');
      }
    });

  // user export subgroup
  const userExport = user.command('export').description('Data export management');

  addGlobalFlags(userExport.command('create')
    .description('Request a data export')
    .option('--format <format>', 'Export format (json)', 'json'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating data export...');
      try {
        const client = await getClientAsync();
        const exp = await client.user.requestDataExport(_opts.format as string | undefined);
        out.success('Data export requested', { id: exp.id, status: exp.status, format: exp.format });
      } catch (err) {
        handleError(out, err, 'Failed to create data export');
      }
    });

  addGlobalFlags(userExport.command('get')
    .description('Get a data export status')
    .argument('<exportId>', 'Export ID'))
    .action(async (exportId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching export status...');
      try {
        const client = await getClientAsync();
        const exp = await client.user.getDataExport(exportId);
        out.stopSpinner();
        out.record({ id: exp.id, status: exp.status, format: exp.format, createdAt: exp.createdAt, completedAt: exp.completedAt, downloadUrl: exp.downloadUrl });
      } catch (err) {
        handleError(out, err, 'Failed to fetch export status');
      }
    });

  addGlobalFlags(userExport.command('list')
    .description('List all data exports'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching data exports...');
      try {
        const client = await getClientAsync();
        const exports = await client.user.listDataExports();
        out.stopSpinner();
        out.list(
          exports.map(e => ({
            id: e.id,
            status: e.status,
            format: e.format,
            createdAt: e.createdAt,
            completedAt: e.completedAt ?? '',
          })),
          {
            emptyMessage: 'No data exports found.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'status', header: 'Status' },
              { key: 'format', header: 'Format' },
              { key: 'createdAt', header: 'Created' },
              { key: 'completedAt', header: 'Completed' },
            ],
            textFn: (e) => `${chalk.cyan(String(e.id))} [${String(e.status)}] ${String(e.format)} — created ${String(e.createdAt)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch data exports');
      }
    });

  addGlobalFlags(userExport.command('download')
    .description('Download a completed data export')
    .argument('<exportId>', 'Export ID')
    .option('-f, --file <filepath>', 'File path to write the export to'))
    .action(async (exportId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const outputPath = _opts.file as string | undefined;
      if (!outputPath && process.stdout.isTTY) {
        process.stderr.write(chalk.yellow('Warning: binary export data would corrupt your terminal. Use -f <filepath> to save to a file.\n'));
        process.exitCode = 1;
        return;
      }
      out.startSpinner('Downloading data export...');
      try {
        const client = await getClientAsync();
        const blob = await client.user.downloadDataExport(exportId);
        out.stopSpinner();
        const buffer = Buffer.from(await blob.arrayBuffer());
        if (outputPath) {
          await writeFile(outputPath, buffer);
          out.success(`Export saved to ${chalk.cyan(outputPath)}`, { exportId, path: outputPath });
        } else {
          process.stdout.write(buffer);
        }
      } catch (err) {
        handleError(out, err, 'Failed to download data export');
      }
    });

  // user consents subgroup
  const consents = user.command('consents').description('Consent management');

  addGlobalFlags(consents.command('list')
    .description('List consent records'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching consents...');
      try {
        const client = await getClientAsync();
        const list = await client.user.getConsents();
        out.stopSpinner();
        out.list(
          list.map(c => ({ type: c.consentType, version: c.version, granted: c.granted ? 'yes' : 'no', recordedAt: c.recordedAt })),
          {
            emptyMessage: 'No consents found.',
            columns: [
              { key: 'type', header: 'Type' },
              { key: 'version', header: 'Version' },
              { key: 'granted', header: 'Granted' },
              { key: 'recordedAt', header: 'Recorded' },
            ],
            textFn: (c) => `${String(c.type)} v${String(c.version)}: ${c.granted === 'yes' ? chalk.green('granted') : chalk.red('denied')}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch consents');
      }
    });

  addGlobalFlags(consents.command('set')
    .description('Record a consent decision')
    .requiredOption('--type <t>', 'Consent type')
    .requiredOption('--policy-version <v>', 'Policy version')
    .option('--granted', 'Grant consent')
    .option('--no-granted', 'Deny consent')
    .addHelpText('after', `
CONSENT TYPES
  terms_of_service    Terms of Service acceptance
  privacy_policy      Privacy Policy acceptance
  ai_processing       AI feature data processing consent
  marketing           Marketing communications consent

EXAMPLES
  lsvault user consents set --type terms_of_service --policy-version 1.0 --granted
  lsvault user consents set --type ai_processing --policy-version 1.0 --no-granted`))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Recording consent...');
      try {
        const client = await getClientAsync();
        const result = await client.user.recordConsent({
          consentType: _opts.type as string,
          version: _opts.policyVersion as string,
          granted: _opts.granted !== false,
        });
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to record consent');
      }
    });

  // user invitations subgroup
  const invitations = user.command('invitations').description('Team invitation management');

  addGlobalFlags(invitations.command('list')
    .description('List pending team invitations'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching invitations...');
      try {
        const client = await getClientAsync();
        const list = await client.user.listTeamInvitations();
        out.stopSpinner();
        out.list(
          list.map(i => ({ id: i.id, team: i.teamName, role: i.role, invitedBy: i.invitedBy, expiresAt: i.expiresAt })),
          {
            emptyMessage: 'No pending invitations.',
            columns: [
              { key: 'id', header: 'ID' },
              { key: 'team', header: 'Team' },
              { key: 'role', header: 'Role' },
              { key: 'invitedBy', header: 'Invited By' },
              { key: 'expiresAt', header: 'Expires' },
            ],
            textFn: (i) => `${chalk.cyan(String(i.team))} [${String(i.role)}] — invited by ${String(i.invitedBy)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch invitations');
      }
    });

  addGlobalFlags(invitations.command('accept')
    .description('Accept a team invitation')
    .argument('<id>', 'Invitation ID'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Accepting invitation...');
      try {
        const client = await getClientAsync();
        const result = await client.user.acceptTeamInvitation(id);
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to accept invitation');
      }
    });

  addGlobalFlags(invitations.command('decline')
    .description('Decline a team invitation')
    .argument('<id>', 'Invitation ID'))
    .action(async (id: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Declining invitation...');
      try {
        const client = await getClientAsync();
        const result = await client.user.declineTeamInvitation(id);
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to decline invitation');
      }
    });
}
