import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getClientAsync } from '../client.js';

export function registerMfaCommands(program: Command): void {
  const mfa = program.command('mfa').description('Multi-factor authentication management');

  mfa.command('status')
    .description('Show MFA status and configured methods')
    .action(async () => {
      const spinner = ora('Fetching MFA status...').start();
      try {
        const client = await getClientAsync();
        const status = await client.mfa.getStatus();
        spinner.stop();

        console.log(chalk.bold('MFA Status'));
        console.log(`  Enabled:              ${status.mfaEnabled ? chalk.green('Yes') : chalk.dim('No')}`);
        console.log(`  TOTP Configured:      ${status.totpConfigured ? chalk.green('Yes') : chalk.dim('No')}`);
        console.log(`  Passkeys Registered:  ${status.passkeyCount > 0 ? chalk.cyan(status.passkeyCount) : chalk.dim('0')}`);
        console.log(`  Backup Codes Left:    ${status.backupCodesRemaining > 0 ? chalk.cyan(status.backupCodesRemaining) : chalk.yellow('0')}`);

        if (status.passkeys.length > 0) {
          console.log('');
          console.log(chalk.bold('Registered Passkeys:'));
          for (const passkey of status.passkeys) {
            const lastUsed = passkey.lastUsedAt
              ? new Date(passkey.lastUsedAt).toLocaleDateString()
              : chalk.dim('never');
            console.log(`  - ${chalk.cyan(passkey.name)} (last used: ${lastUsed})`);
          }
        }
      } catch (err) {
        spinner.fail('Failed to fetch MFA status');
        console.error(err instanceof Error ? err.message : String(err));
      }
    });

  mfa.command('setup-totp')
    .description('Set up TOTP authenticator app (Google Authenticator, Authy, etc.)')
    .action(async () => {
      const spinner = ora('Generating TOTP secret...').start();
      try {
        const client = await getClientAsync();
        const setup = await client.mfa.setupTotp();
        spinner.stop();

        console.log(chalk.bold('TOTP Setup'));
        console.log('');
        console.log(`Secret:  ${chalk.cyan(setup.secret)}`);
        console.log('');
        console.log('Add this URI to your authenticator app:');
        console.log(chalk.dim(setup.otpauthUri));
        console.log('');
        console.log(chalk.yellow('Note: QR codes cannot be displayed in the terminal.'));
        console.log(chalk.yellow('      Copy the URI above to any authenticator app that supports otpauth:// URIs.'));
        console.log('');

        // Prompt for verification code
        const code = await promptMfaCode();
        if (!code) {
          console.log(chalk.yellow('Setup cancelled.'));
          return;
        }

        const verifySpinner = ora('Verifying code and enabling TOTP...').start();
        const result = await client.mfa.verifyTotp(code);
        verifySpinner.succeed('TOTP enabled successfully!');

        console.log('');
        console.log(chalk.bold.yellow('IMPORTANT: Save these backup codes securely!'));
        console.log(chalk.dim('You can use them to access your account if you lose your authenticator device.'));
        console.log('');

        // Display backup codes in a grid (2 columns)
        const codes = result.backupCodes;
        for (let i = 0; i < codes.length; i += 2) {
          const left = codes[i] || '';
          const right = codes[i + 1] || '';
          console.log(`  ${chalk.cyan(left.padEnd(20))}  ${chalk.cyan(right)}`);
        }

        console.log('');
      } catch (err) {
        spinner.fail('TOTP setup failed');
        console.error(err instanceof Error ? err.message : String(err));
      }
    });

  mfa.command('disable-totp')
    .description('Disable TOTP authentication (requires password)')
    .action(async () => {
      const password = await promptPassword();
      if (!password) {
        console.log(chalk.yellow('Operation cancelled.'));
        return;
      }

      const spinner = ora('Disabling TOTP...').start();
      try {
        const client = await getClientAsync();
        const result = await client.mfa.disableTotp(password);
        spinner.succeed(result.message);
      } catch (err) {
        spinner.fail('Failed to disable TOTP');
        console.error(err instanceof Error ? err.message : String(err));
      }
    });

  mfa.command('backup-codes')
    .description('Show remaining backup code count or regenerate codes')
    .option('--regenerate', 'Generate new backup codes (requires password, invalidates old codes)')
    .action(async (opts: { regenerate?: boolean }) => {
      if (opts.regenerate) {
        // Regenerate backup codes
        const password = await promptPassword();
        if (!password) {
          console.log(chalk.yellow('Operation cancelled.'));
          return;
        }

        const spinner = ora('Regenerating backup codes...').start();
        try {
          const client = await getClientAsync();
          const result = await client.mfa.regenerateBackupCodes(password);
          spinner.succeed('Backup codes regenerated!');

          console.log('');
          console.log(chalk.bold.yellow('IMPORTANT: Save these new backup codes securely!'));
          console.log(chalk.dim('All previous backup codes have been invalidated.'));
          console.log('');

          // Display backup codes in a grid (2 columns)
          const codes = result.backupCodes;
          for (let i = 0; i < codes.length; i += 2) {
            const left = codes[i] || '';
            const right = codes[i + 1] || '';
            console.log(`  ${chalk.cyan(left.padEnd(20))}  ${chalk.cyan(right)}`);
          }

          console.log('');
        } catch (err) {
          spinner.fail('Failed to regenerate backup codes');
          console.error(err instanceof Error ? err.message : String(err));
        }
      } else {
        // Show backup code count
        const spinner = ora('Fetching backup code count...').start();
        try {
          const client = await getClientAsync();
          const status = await client.mfa.getStatus();
          spinner.stop();

          console.log(chalk.bold('Backup Codes'));
          console.log(`  Remaining: ${status.backupCodesRemaining > 0 ? chalk.cyan(status.backupCodesRemaining) : chalk.yellow('0')}`);

          if (status.backupCodesRemaining === 0) {
            console.log('');
            console.log(chalk.yellow('You have no backup codes remaining.'));
            console.log(chalk.yellow('Run `lsvault mfa backup-codes --regenerate` to generate new codes.'));
          }
        } catch (err) {
          spinner.fail('Failed to fetch backup code count');
          console.error(err instanceof Error ? err.message : String(err));
        }
      }
    });
}

/**
 * Prompt for a password from stdin (non-echoing).
 * Returns the password or null if stdin is not a TTY.
 */
async function promptPassword(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }

  const readline = await import('node:readline');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    process.stderr.write('Password: ');
    (process.stdin as NodeJS.ReadStream).setRawMode?.(true);

    let password = '';
    const onData = (chunk: Buffer) => {
      const char = chunk.toString('utf-8');
      if (char === '\n' || char === '\r' || char === '\u0004') {
        process.stderr.write('\n');
        (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(password);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.stderr.write('\n');
        (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(null);
      } else if (char === '\u007F' || char === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += char;
      }
    };

    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

/**
 * Prompt for an MFA code from stdin (6 digits, echoed for visibility).
 * Returns the code or null if stdin is not a TTY.
 */
async function promptMfaCode(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }

  const readline = await import('node:readline');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    rl.question('Enter 6-digit code from authenticator app: ', (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}
