import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import { loadConfigAsync, getCredentialManager } from '../config.js';
import { getClientAsync, getHttpTimeoutMs } from '../client.js';
import { migrateCredentials, hasPlaintextCredentials, checkAndPromptMigration } from '../lib/migration.js';
import { promptPassword, promptMfaCode } from '../utils/prompt.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

/** Hosts where plaintext HTTP never leaves the machine, so it stays permitted. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validate an operator-supplied API URL *before* anything is persisted or sent.
 *
 * The value is used for the password POST that immediately follows and for
 * every request afterwards, so an `http://` URL pasted from a wiki puts the
 * password and then the bearer token on the wire in cleartext. Rejecting it
 * here — rather than after `saveCredentials` — also stops a bad value from
 * being written into the config where later commands would silently reuse it.
 *
 * @returns the normalised URL string.
 * @throws {Error} with an operator-facing message when the URL is unusable.
 */
export function validateApiUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`--api-url must be an absolute URL such as https://vault.example.com (got ${JSON.stringify(raw)}).`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`--api-url must use https (got ${parsed.protocol.replace(':', '')}).`);
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `--api-url must use https for ${parsed.hostname}: an http URL sends your password and access token in cleartext. `
      + 'Plain http is accepted only for localhost, 127.0.0.1 and ::1.',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication and credential management');

  auth.command('login')
    .description('Authenticate with an API key or email/password credentials')
    .option('--api-key <key>', 'API key (lsv_k_... prefix)')
    .option('--email <email>', 'Email address for password login')
    .option('--password <password>', 'Password (prompts interactively if omitted)')
    .option('--mfa-code <code>', 'MFA code (TOTP or backup code) if account has MFA enabled')
    .option('--api-url <url>', 'API server URL (default: https://vault.lifestreamdynamics.com)')
    .addHelpText('after', `
EXAMPLES
  lsvault auth login --api-key lsv_k_abc123
  lsvault auth login --email user@example.com
  lsvault auth login --email user@example.com --mfa-code 123456
  lsvault auth login --email user@example.com --api-url https://api.example.com`)
    .action(async (opts: { apiKey?: string; email?: string; password?: string; mfaCode?: string; apiUrl?: string }) => {
      const cm = getCredentialManager();

      // Set API URL first if provided — validated before it is stored or used.
      let apiUrlOverride: string | undefined;
      if (opts.apiUrl) {
        try {
          apiUrlOverride = validateApiUrl(opts.apiUrl);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exitCode = 1;
          return;
        }
        try {
          await cm.saveCredentials({ apiUrl: apiUrlOverride });
          console.log(chalk.green(`API URL set to ${apiUrlOverride}`));
        } catch {
          const { saveConfig } = await import('../config.js');
          saveConfig({ apiUrl: apiUrlOverride });
          console.log(chalk.green(`API URL set to ${apiUrlOverride}`));
        }
      }

      // Password-based login
      if (opts.email) {
        const password = opts.password ?? await promptPassword();
        if (!password) {
          console.error(chalk.red('Password is required for email login.'));
          process.exitCode = 1;
          return;
        }

        const config = await loadConfigAsync();
        const apiUrl = apiUrlOverride ?? config.apiUrl;

        const spinner = ora('Authenticating...').start();
        try {
          const { tokens, refreshToken } = await LifestreamVaultClient.login(
            apiUrl,
            opts.email,
            password,
            { timeout: getHttpTimeoutMs() },
            {
              mfaCode: opts.mfaCode,
              onMfaRequired: async (challenge) => {
                spinner.stop();
                console.log(chalk.yellow('MFA required for this account.'));
                console.log(`Available methods: ${challenge.methods.join(', ')}`);

                const code = await promptMfaCode();
                if (!code) {
                  throw new Error('MFA code is required');
                }

                spinner.start('Verifying MFA code...');
                return { method: 'totp', code };
              },
            },
          );

          // Save tokens to secure storage
          await cm.saveCredentials({
            accessToken: tokens.accessToken,
            refreshToken: refreshToken ?? undefined,
          });

          spinner.succeed(`Logged in as ${chalk.cyan(tokens.user.email)}`);
          console.log(`  Name: ${tokens.user.displayName || chalk.dim('not set')}`);
          console.log(`  Role: ${tokens.user.role}`);

          if (!refreshToken) {
            console.log(chalk.yellow('  Note: No refresh token received. Session will expire.'));
          }
        } catch (err) {
          spinner.fail('Login failed');
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
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
          process.exitCode = 1;
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
        process.exitCode = 1;
        return;
      }

      const spinner = ora('Refreshing access token...').start();
      try {
        // Create a client with the current tokens to trigger refresh
        const client = new LifestreamVaultClient({
          baseUrl: config.apiUrl,
          accessToken: config.accessToken || 'expired',
          refreshToken: config.refreshToken,
          timeout: getHttpTimeoutMs(),
          refreshBufferMs: Number.MAX_SAFE_INTEGER, // Force immediate refresh
          onTokenRefresh: async (tokens) => {
            // The server rotates the refresh token on every refresh and
            // deletes the one presented, so the rotated token must be stored
            // alongside the access token or the next refresh fails.
            await cm.saveCredentials({
              accessToken: tokens.accessToken,
              ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
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
        process.exitCode = 1;
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

  addGlobalFlags(auth.command('whoami')
    .description('Show the currently authenticated user, plan, and API URL'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const config = await loadConfigAsync();

      // Warn about plaintext credentials
      await checkAndPromptMigration(getCredentialManager());

      if (!config.apiKey && !config.accessToken) {
        out.record({
          apiUrl: config.apiUrl,
          apiKey: null,
          auth: 'none',
        });
        return;
      }

      out.startSpinner('Fetching user info...');
      try {
        const client = await getClientAsync();
        const user = await client.user.me();
        out.stopSpinner();

        let plan = user.subscriptionTier;
        if (!plan) {
          try {
            const sub = await client.subscription.get();
            plan = sub.subscription.tier;
          } catch { /* API key may not have scope */ }
        }

        out.record({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey ? config.apiKey.slice(0, 12) + '...' : null,
          auth: config.accessToken ? 'JWT (email/password)' : 'API key',
          email: user.email,
          displayName: user.displayName || null,
          role: user.role,
          plan: plan || 'unknown',
        });
      } catch (err) {
        handleError(out, err, 'Could not fetch user info');
      }
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
