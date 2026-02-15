import type { CliConfig } from '../config.js';

const SERVICE_NAME = 'lifestream-vault-cli';
const ACCOUNT_API_KEY = 'api-key';
const ACCOUNT_API_URL = 'api-url';
const ACCOUNT_ACCESS_TOKEN = 'access-token';
const ACCOUNT_REFRESH_TOKEN = 'refresh-token';

export interface KeychainBackend {
  isAvailable(): Promise<boolean>;
  getCredentials(): Promise<Partial<CliConfig>>;
  saveCredentials(config: Partial<CliConfig>): Promise<void>;
  clearCredentials(): Promise<void>;
}

/**
 * Dynamically loads keytar. Returns null if unavailable (not installed or
 * native module fails to load, e.g. missing libsecret on Linux).
 */
async function loadKeytar(): Promise<typeof import('keytar') | null> {
  try {
    return await import('keytar');
  } catch {
    return null;
  }
}

export function createKeychainBackend(): KeychainBackend {
  let keytarModule: typeof import('keytar') | null | undefined;

  async function getKeytar(): Promise<typeof import('keytar') | null> {
    if (keytarModule === undefined) {
      keytarModule = await loadKeytar();
    }
    return keytarModule;
  }

  return {
    async isAvailable(): Promise<boolean> {
      const kt = await getKeytar();
      if (!kt) return false;

      // Verify we can actually use the keychain (libsecret may be missing)
      try {
        await kt.getPassword(SERVICE_NAME, '__probe__');
        return true;
      } catch {
        keytarModule = null;
        return false;
      }
    },

    async getCredentials(): Promise<Partial<CliConfig>> {
      const kt = await getKeytar();
      if (!kt) return {};

      const result: Partial<CliConfig> = {};
      try {
        const apiKey = await kt.getPassword(SERVICE_NAME, ACCOUNT_API_KEY);
        if (apiKey) result.apiKey = apiKey;

        const apiUrl = await kt.getPassword(SERVICE_NAME, ACCOUNT_API_URL);
        if (apiUrl) result.apiUrl = apiUrl;

        const accessToken = await kt.getPassword(SERVICE_NAME, ACCOUNT_ACCESS_TOKEN);
        if (accessToken) result.accessToken = accessToken;

        const refreshToken = await kt.getPassword(SERVICE_NAME, ACCOUNT_REFRESH_TOKEN);
        if (refreshToken) result.refreshToken = refreshToken;
      } catch {
        // Keychain access failed silently
      }
      return result;
    },

    async saveCredentials(config: Partial<CliConfig>): Promise<void> {
      const kt = await getKeytar();
      if (!kt) throw new Error('Keychain is not available');

      if (config.apiKey) {
        await kt.setPassword(SERVICE_NAME, ACCOUNT_API_KEY, config.apiKey);
      }
      if (config.apiUrl) {
        await kt.setPassword(SERVICE_NAME, ACCOUNT_API_URL, config.apiUrl);
      }
      if (config.accessToken) {
        await kt.setPassword(SERVICE_NAME, ACCOUNT_ACCESS_TOKEN, config.accessToken);
      }
      if (config.refreshToken) {
        await kt.setPassword(SERVICE_NAME, ACCOUNT_REFRESH_TOKEN, config.refreshToken);
      }
    },

    async clearCredentials(): Promise<void> {
      const kt = await getKeytar();
      if (!kt) return;

      try {
        await kt.deletePassword(SERVICE_NAME, ACCOUNT_API_KEY);
      } catch { /* ignore */ }
      try {
        await kt.deletePassword(SERVICE_NAME, ACCOUNT_API_URL);
      } catch { /* ignore */ }
      try {
        await kt.deletePassword(SERVICE_NAME, ACCOUNT_ACCESS_TOKEN);
      } catch { /* ignore */ }
      try {
        await kt.deletePassword(SERVICE_NAME, ACCOUNT_REFRESH_TOKEN);
      } catch { /* ignore */ }
    },
  };
}
