import { LifestreamVaultClient } from '@lifestream-vault/sdk';
import { loadConfig, loadConfigAsync, getCredentialManager } from './config.js';
import chalk from 'chalk';

/**
 * Create an SDK client from CLI configuration.
 * Supports both API key and JWT (access + refresh token) authentication.
 * When using JWT tokens, auto-refresh is enabled and new tokens are persisted.
 */
export function getClient(): LifestreamVaultClient {
  const config = loadConfig();

  // JWT auth mode: use access + refresh tokens
  if (config.accessToken) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      onTokenRefresh: async (tokens) => {
        // Persist refreshed tokens to secure storage
        try {
          const cm = getCredentialManager();
          await cm.saveCredentials({
            accessToken: tokens.accessToken,
          });
        } catch {
          // Best-effort persistence; don't break the request
        }
      },
    });
  }

  // API key auth mode
  if (config.apiKey) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  console.error(chalk.red('No credentials configured.'));
  console.error('Run: lsvault auth login --api-key <key>');
  console.error('  or: lsvault auth login --email <email>');
  console.error('Or set LSVAULT_API_KEY environment variable');
  process.exit(1);
}

/**
 * Create an SDK client from async config resolution (secure credential manager).
 * This resolves credentials from keychain/encrypted storage.
 */
export async function getClientAsync(): Promise<LifestreamVaultClient> {
  const config = await loadConfigAsync();

  if (config.accessToken) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      onTokenRefresh: async (tokens) => {
        try {
          const cm = getCredentialManager();
          await cm.saveCredentials({
            accessToken: tokens.accessToken,
          });
        } catch {
          // Best-effort
        }
      },
    });
  }

  if (config.apiKey) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  console.error(chalk.red('No credentials configured.'));
  console.error('Run: lsvault auth login --api-key <key>');
  console.error('  or: lsvault auth login --email <email>');
  console.error('Or set LSVAULT_API_KEY environment variable');
  process.exit(1);
}
