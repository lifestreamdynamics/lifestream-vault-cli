import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { LifestreamVaultClient } from '@lifestream-vault/sdk';
import { loadConfig, loadConfigAsync, getCredentialManager } from '../config.js';
import { getClient } from '../client.js';
import { migrateCredentials, hasPlaintextCredentials, checkAndPromptMigration } from '../lib/migration.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication and credential management');

  auth.command('login')
    .description('Authenticate with an API key or email/password credentials')
    .option('--api-key <key>', 'API key (lsv_k_... prefix)')
    .option('--email <email>', 'Email address for password login')
    .option('--password <password>', 'Password (prompts interactively if omitted)')
    .option('--api-url <url>', 'API server URL (default: http://localhost:4660)')
    .addHelpText('after', `
EXAMPLES
  lsvault auth login --api-key lsv_k_abc123
  lsvault auth login --email user@example.com
  lsvault auth login --email user@example.com --api-url https://api.example.com`)
    .action(async (opts: { apiKey?: string; email?: string; password?: string; apiUrl?: string }) => {
      const cm = getCredentialManager();

      // Set API URL first if provided
      if (opts.apiUrl) {
        try {
          await cm.saveCredentials({ apiUrl: opts.apiUrl });
          console.log(chalk.green(`API URL set to ${opts.apiUrl}`));
        } catch {
          const { saveConfig } = await import('../config.js');
          saveConfig({ apiUrl: opts.apiUrl });
          console.log(chalk.green(`API URL set to ${opts.apiUrl}`));
        }
      }

      // Password-based login
      if (opts.email) {
        const password = opts.password ?? await promptPassword();
        if (!password) {
          console.error(chalk.red('Password is required for email login.'));
          return;
        }

        const config = await loadConfigAsync();
        const apiUrl = opts.apiUrl ?? config.apiUrl;

        const spinner = ora('Authenticating...').start();
        try {
          const { tokens, refreshToken } = await LifestreamVaultClient.login(
            apiUrl,
            opts.email,
            password,
          );

          // Save tokens to secure storage
          await cm.saveCredentials({
            accessToken: tokens.accessToken,
            refreshToken: refreshToken ?? undefined,
          });

          spinner.succeed(`Logged in as ${chalk.cyan(tokens.user.email)}`);
          console.log(`  Name: ${tokens.user.name || chalk.dim('not set')}`);
          console.log(`  Role: ${tokens.user.role}`);

          if (!refreshToken) {
            console.log(chalk.yellow('  Note: No refresh token received. Session will expire.'));
          }
        } catch (err) {
          spinner.fail('Login failed');
          console.error(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      // API key login
      if (opts.apiKey) {
        const spinner = ora('Saving API key to secure storage...').start();
        try {
          await cm.saveCredentials({ apiKey: opts.apiKey });
          const method = await cm.getStorageMethod();
          spinner.succeed(`API key saved to ${formatMethod(method)}.`);
        } catch (err) {
          spinner.fail('Failed to save API key to secure storage');
          console.error(err instanceof Error ? err.message : String(err));
        }
        return;
      }

      if (!opts.apiUrl) {
        console.log('Usage: lsvault auth login --api-key <key> [--api-url <url>]');
        console.log('   or: lsvault auth login --email <email> [--password <pass>] [--api-url <url>]');
      }
    });

  auth.command('refresh')
    .description('Refresh the JWT access token using the stored refresh token')
    .action(async () => {
      const cm = getCredentialManager();
      const config = await loadConfigAsync();

      if (!config.refreshToken) {
        console.error(chalk.red('No refresh token stored. Login first with --email.'));
        return;
      }

      const spinner = ora('Refreshing access token...').start();
      try {
        // Create a client with the current tokens to trigger refresh
        const client = new LifestreamVaultClient({
          baseUrl: config.apiUrl,
          accessToken: config.accessToken || 'expired',
          refreshToken: config.refreshToken,
          refreshBufferMs: Number.MAX_SAFE_INTEGER, // Force immediate refresh
          onTokenRefresh: async (tokens) => {
            await cm.saveCredentials({
              accessToken: tokens.accessToken,
            });
          },
        });

        // Trigger the refresh by making a request
        const user = await client.user.me();
        spinner.succeed(`Token refreshed. Logged in as ${chalk.cyan(user.email)}`);
      } catch (err) {
        spinner.fail('Token refresh failed');
        console.error(err instanceof Error ? err.message : String(err));
        console.log(chalk.dim('You may need to log in again: lsvault auth login --email <email>'));
      }
    });

  auth.command('logout')
    .description('Clear all stored credentials from keychain and config')
    .action(async () => {
      const cm = getCredentialManager();
      const spinner = ora('Clearing credentials...').start();

      try {
        await cm.clearCredentials();
        spinner.succeed('All credentials cleared.');
      } catch (err) {
        spinner.fail('Failed to clear credentials');
        console.error(err instanceof Error ? err.message : String(err));
      }
    });

  auth.command('status')
    .description('Show credential storage method, auth type, and connection info')
    .action(async () => {
      const cm = getCredentialManager();
      const method = await cm.getStorageMethod();
      const config = await loadConfigAsync();

      console.log(chalk.bold('Credential Storage Status'));
      console.log(`  Storage method: ${formatMethod(method)}`);
      console.log(`  API URL:        ${config.apiUrl}`);
      console.log(`  API Key:        ${config.apiKey ? config.apiKey.slice(0, 12) + '...' : chalk.yellow('not set')}`);
      console.log(`  JWT Auth:       ${config.accessToken ? chalk.green('active') : chalk.dim('not set')}`);
      console.log(`  Refresh Token:  ${config.refreshToken ? chalk.green('stored') : chalk.dim('not set')}`);

      if (hasPlaintextCredentials()) {
        console.log('');
        console.log(chalk.yellow('  Warning: Plaintext credentials found in ~/.lsvault/config.json'));
        console.log(chalk.yellow('  Run `lsvault auth migrate` to migrate to secure storage.'));
      }
    });

  auth.command('migrate')
    .description('Migrate plaintext credentials from config.json to secure storage')
    .action(async () => {
      if (!hasPlaintextCredentials()) {
        console.log('No plaintext credentials found. Nothing to migrate.');
        return;
      }

      const cm = getCredentialManager();
      const spinner = ora('Migrating credentials to secure storage...').start();

      const result = await migrateCredentials(cm);

      if (result.migrated) {
        spinner.succeed(`API key migrated to ${formatMethod(result.method)}.`);
      } else if (result.error) {
        spinner.fail(`Migration failed: ${result.error}`);
      } else {
        spinner.info('Migration skipped.');
      }
    });

  auth.command('whoami')
    .description('Show the currently authenticated user, plan, and API URL')
    .action(async () => {
      const config = await loadConfigAsync();
      console.log(`API URL: ${config.apiUrl}`);
      console.log(`API Key: ${config.apiKey ? config.apiKey.slice(0, 12) + '...' : chalk.yellow('not set')}`);
      if (config.accessToken) {
        console.log(`Auth:    ${chalk.green('JWT (email/password)')}`);
      }

      // Warn about plaintext credentials
      await checkAndPromptMigration(getCredentialManager());

      if (config.apiKey || config.accessToken) {
        const spinner = ora('Fetching user info...').start();
        try {
          const client = getClient();
          const user = await client.user.me();
          spinner.stop();
          console.log(`User:    ${chalk.cyan(user.email)}`);
          console.log(`Name:    ${user.name || chalk.dim('not set')}`);
          console.log(`Role:    ${user.role}`);
          console.log(`Plan:    ${chalk.green(user.subscriptionTier)}`);
        } catch (err) {
          spinner.fail('Could not fetch user info');
          console.error(err instanceof Error ? err.message : err);
        }
      }
    });
}

/**
 * Prompt for a password from stdin (non-echoing).
 * Returns the password or null if stdin is not a TTY.
 */
async function promptPassword(): Promise<string | null> {
  // In non-interactive mode, cannot prompt
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

    // Disable echoing
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

function formatMethod(method: string): string {
  switch (method) {
    case 'keychain': return chalk.green('OS Keychain');
    case 'encrypted-config': return chalk.cyan('Encrypted Config (~/.lsvault/credentials.enc)');
    case 'env': return chalk.blue('Environment Variable');
    case 'plaintext-config': return chalk.yellow('Plaintext Config (deprecated)');
    default: return chalk.dim(method);
  }
}
