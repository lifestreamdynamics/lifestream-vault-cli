import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { promptPassword, promptMfaCode } from '../utils/prompt.js';

export function registerMfaCommands(program: Command): void {
  const mfa = program.command('mfa')
    .description('Multi-factor authentication management (requires JWT auth — use "lsvault auth login" first)')
    .addHelpText('after', '\nNOTE: MFA management requires JWT authentication. API key auth is not sufficient.\nRun "lsvault auth login" to authenticate with email/password first.');

  addGlobalFlags(mfa.command('status')
    .description('Show MFA status and configured methods'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching MFA status...');
      try {
        const client = await getClientAsync();
        const status = await client.mfa.getStatus();
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({
            mfaEnabled: status.mfaEnabled,
            totpConfigured: status.totpConfigured,
            passkeyCount: status.passkeyCount,
            backupCodesRemaining: status.backupCodesRemaining,
            passkeys: status.passkeys,
          });
        } else {
          out.raw(chalk.bold('MFA Status') + '\n');
          out.raw(`  Enabled:              ${status.mfaEnabled ? chalk.green('Yes') : chalk.dim('No')}\n`);
          out.raw(`  TOTP Configured:      ${status.totpConfigured ? chalk.green('Yes') : chalk.dim('No')}\n`);
          out.raw(`  Passkeys Registered:  ${status.passkeyCount > 0 ? chalk.cyan(status.passkeyCount) : chalk.dim('0')}\n`);
          out.raw(`  Backup Codes Left:    ${status.backupCodesRemaining > 0 ? chalk.cyan(status.backupCodesRemaining) : chalk.yellow('0')}\n`);

          if (status.passkeys.length > 0) {
            out.raw('\n');
            out.raw(chalk.bold('Registered Passkeys:') + '\n');
            for (const passkey of status.passkeys) {
              const lastUsed = passkey.lastUsedAt
                ? new Date(passkey.lastUsedAt).toLocaleDateString()
                : chalk.dim('never');
              out.raw(`  - ${chalk.cyan(passkey.name)} (last used: ${lastUsed})\n`);
            }
          }
        }
      } catch (err) {
        out.failSpinner('Failed to fetch MFA status');
        handleError(out, err, 'MFA management requires JWT authentication');
      }
    });

  addGlobalFlags(mfa.command('setup-totp')
    .description('Set up TOTP authenticator app (Google Authenticator, Authy, etc.)'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Generating TOTP secret...');
      try {
        const client = await getClientAsync();
        const setup = await client.mfa.setupTotp();
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({ secret: setup.secret, otpauthUri: setup.otpauthUri });
        } else {
          out.raw(chalk.bold('TOTP Setup') + '\n');
          out.raw('\n');
          out.raw(`Secret:  ${chalk.cyan(setup.secret)}\n`);
          out.raw('\n');
          out.raw('Add this URI to your authenticator app:\n');
          out.raw(chalk.dim(setup.otpauthUri) + '\n');
          out.raw('\n');
          out.raw(chalk.yellow('Note: QR codes cannot be displayed in the terminal.') + '\n');
          out.raw(chalk.yellow('      Copy the URI above to any authenticator app that supports otpauth:// URIs.') + '\n');
          out.raw('\n');
        }

        // Prompt for verification code — skip in quiet mode
        if (flags.quiet) return;

        const code = await promptMfaCode();
        if (!code) {
          out.status(chalk.yellow('Setup cancelled.'));
          return;
        }

        out.startSpinner('Verifying code and enabling TOTP...');
        const result = await client.mfa.verifyTotp(code);
        out.stopSpinner();
        out.success('TOTP enabled successfully!');

        if (flags.output === 'json') {
          out.list(result.backupCodes.map((code) => ({ code })), { emptyMessage: 'No backup codes returned.' });
        } else {
          out.raw('\n');
          out.raw(chalk.bold.yellow('IMPORTANT: Save these backup codes securely!') + '\n');
          out.raw(chalk.dim('You can use them to access your account if you lose your authenticator device.') + '\n');
          out.raw('\n');

          // Display backup codes in a grid (2 columns)
          const codes = result.backupCodes;
          for (let i = 0; i < codes.length; i += 2) {
            const left = codes[i] || '';
            const right = codes[i + 1] || '';
            out.raw(`  ${chalk.cyan(left.padEnd(20))}  ${chalk.cyan(right)}\n`);
          }

          out.raw('\n');
        }
      } catch (err) {
        handleError(out, err, 'TOTP setup failed');
      }
    });

  addGlobalFlags(mfa.command('disable-totp')
    .description('Disable TOTP authentication (requires password)'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      // Skip interactive prompt in quiet mode
      if (flags.quiet) {
        out.error('Password prompt required — cannot run in quiet mode without --password-stdin.');
        process.exitCode = 1;
        return;
      }

      const password = await promptPassword();
      if (!password) {
        out.status(chalk.yellow('Operation cancelled.'));
        return;
      }

      out.startSpinner('Disabling TOTP...');
      try {
        const client = await getClientAsync();
        const result = await client.mfa.disableTotp(password);
        out.stopSpinner();
        out.success(result.message, { message: result.message });
      } catch (err) {
        handleError(out, err, 'Failed to disable TOTP');
      }
    });

  addGlobalFlags(mfa.command('backup-codes')
    .description('Show remaining backup code count or regenerate codes')
    .option('--regenerate', 'Generate new backup codes (requires password, invalidates old codes)'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      if (_opts.regenerate) {
        // Regenerate backup codes
        if (flags.quiet) {
          out.error('Password prompt required — cannot run in quiet mode without --password-stdin.');
          process.exitCode = 1;
          return;
        }

        const password = await promptPassword();
        if (!password) {
          out.status(chalk.yellow('Operation cancelled.'));
          return;
        }

        out.startSpinner('Regenerating backup codes...');
        try {
          const client = await getClientAsync();
          const result = await client.mfa.regenerateBackupCodes(password);
          out.stopSpinner();
          out.success('Backup codes regenerated!');

          if (flags.output === 'json') {
            out.list(result.backupCodes.map((code) => ({ code })), { emptyMessage: 'No backup codes returned.' });
          } else {
            out.raw('\n');
            out.raw(chalk.bold.yellow('IMPORTANT: Save these new backup codes securely!') + '\n');
            out.raw(chalk.dim('All previous backup codes have been invalidated.') + '\n');
            out.raw('\n');

            // Display backup codes in a grid (2 columns)
            const codes = result.backupCodes;
            for (let i = 0; i < codes.length; i += 2) {
              const left = codes[i] || '';
              const right = codes[i + 1] || '';
              out.raw(`  ${chalk.cyan(left.padEnd(20))}  ${chalk.cyan(right)}\n`);
            }

            out.raw('\n');
          }
        } catch (err) {
          handleError(out, err, 'Failed to regenerate backup codes');
        }
      } else {
        // Show backup code count
        out.startSpinner('Fetching backup code count...');
        try {
          const client = await getClientAsync();
          const status = await client.mfa.getStatus();
          out.stopSpinner();

          if (flags.output === 'json') {
            out.record({ backupCodesRemaining: status.backupCodesRemaining });
          } else {
            out.raw(chalk.bold('Backup Codes') + '\n');
            out.raw(`  Remaining: ${status.backupCodesRemaining > 0 ? chalk.cyan(status.backupCodesRemaining) : chalk.yellow('0')}\n`);

            if (status.backupCodesRemaining === 0) {
              out.raw('\n');
              out.raw(chalk.yellow('You have no backup codes remaining.') + '\n');
              out.raw(chalk.yellow('Run `lsvault mfa backup-codes --regenerate` to generate new codes.') + '\n');
            }
          }
        } catch (err) {
          handleError(out, err, 'Failed to fetch backup code count');
        }
      }
    });
}
