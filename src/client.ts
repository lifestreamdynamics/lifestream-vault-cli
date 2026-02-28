import { LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import { loadConfig, loadConfigAsync, getCredentialManager } from './config.js';

/**
 * Create an SDK client from CLI configuration.
 * Supports both API key and JWT (access + refresh token) authentication.
 * When using JWT tokens, auto-refresh is enabled and new tokens are persisted.
 *
 * @throws {Error} If no credentials are configured.
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

  throw new Error(
    'No credentials configured.\n' +
    'Run: lsvault auth login --api-key <key>\n' +
    '  or: lsvault auth login --email <email>\n' +
    'Or set LSVAULT_API_KEY environment variable',
  );
}

/**
 * Create an SDK client from async config resolution (secure credential manager).
 * This resolves credentials from keychain/encrypted storage.
 *
 * @throws {Error} If no credentials are configured.
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

  throw new Error(
    'No credentials configured.\n' +
    'Run: lsvault auth login --api-key <key>\n' +
    '  or: lsvault auth login --email <email>\n' +
    'Or set LSVAULT_API_KEY environment variable',
  );
}
