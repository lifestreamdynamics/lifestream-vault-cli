import { LifestreamVaultClient, type AuthTokens } from '@lifestreamdynamics/vault-sdk';
import { loadConfig, loadConfigAsync, getCredentialManager } from './config.js';

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** Resolve the SDK request timeout from the environment (1-300 seconds). */
export function getHttpTimeoutMs(envValue = process.env.LSVAULT_HTTP_TIMEOUT_MS): number {
  if (envValue === undefined || envValue === '') return DEFAULT_HTTP_TIMEOUT_MS;
  if (!/^\d+$/.test(envValue)) {
    throw new Error('LSVAULT_HTTP_TIMEOUT_MS must be an integer from 1000 to 300000 milliseconds (1-300 seconds).');
  }
  const timeout = Number(envValue);
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new Error('LSVAULT_HTTP_TIMEOUT_MS must be between 1000 and 300000 milliseconds (1-300 seconds).');
  }
  return timeout;
}

/**
 * Persist tokens from an automatic refresh. The server rotates the refresh
 * token and invalidates the presented one, so the new refresh token must be
 * stored too — keeping only the access token strands the next process with a
 * dead refresh token. Best-effort: a storage failure must not fail the request.
 */
async function persistRefreshedTokens(tokens: AuthTokens): Promise<void> {
  try {
    await getCredentialManager().saveCredentials({
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    });
  } catch {
    // Best-effort persistence; don't break the request
  }
}

/**
 * Create an SDK client from CLI configuration.
 * Supports both API key and JWT (access + refresh token) authentication.
 * When using JWT tokens, auto-refresh is enabled and new tokens are persisted.
 *
 * @throws {Error} If no credentials are configured.
 */
export function getClient(): LifestreamVaultClient {
  const config = loadConfig();
  const timeout = getHttpTimeoutMs();

  // JWT auth mode: use access + refresh tokens
  if (config.accessToken) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      timeout,
      onTokenRefresh: persistRefreshedTokens,
    });
  }

  // API key auth mode
  if (config.apiKey) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
      timeout,
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
  const timeout = getHttpTimeoutMs();

  if (config.accessToken) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      timeout,
      onTokenRefresh: persistRefreshedTokens,
    });
  }

  if (config.apiKey) {
    return new LifestreamVaultClient({
      baseUrl: config.apiUrl,
      apiKey: config.apiKey,
      timeout,
    });
  }

  throw new Error(
    'No credentials configured.\n' +
    'Run: lsvault auth login --api-key <key>\n' +
    '  or: lsvault auth login --email <email>\n' +
    'Or set LSVAULT_API_KEY environment variable',
  );
}
