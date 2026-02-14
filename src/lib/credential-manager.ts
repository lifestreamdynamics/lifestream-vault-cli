import type { CliConfig } from '../config.js';
import { createKeychainBackend, type KeychainBackend } from './keychain.js';
import { createEncryptedConfigBackend, type EncryptedConfigBackend } from './encrypted-config.js';

export type StorageMethod = 'env' | 'keychain' | 'encrypted-config' | 'plaintext-config' | 'none';

export interface CredentialManager {
  /**
   * Resolves credentials using the priority chain:
   * 1. Environment variables
   * 2. OS Keychain (keytar)
   * 3. Encrypted config (~/.lsvault/credentials.enc)
   *
   * Does NOT read plaintext config — that's handled by loadConfig() for
   * backwards compat with a migration warning.
   */
  getCredentials(): Promise<Partial<CliConfig>>;

  /**
   * Saves credentials to the best available backend.
   * Prefers keychain, falls back to encrypted config.
   */
  saveCredentials(config: Partial<CliConfig>): Promise<void>;

  /**
   * Clears credentials from all secure backends.
   */
  clearCredentials(): Promise<void>;

  /**
   * Returns the storage method that currently holds credentials.
   */
  getStorageMethod(): Promise<StorageMethod>;

  /**
   * Retrieve the encryption key for a vault.
   * Looks up from environment, then keychain, then encrypted config.
   */
  getVaultKey(vaultId: string): Promise<string | null>;

  /**
   * Save a vault encryption key to the best available backend.
   */
  saveVaultKey(vaultId: string, keyHex: string): Promise<void>;

  /**
   * Delete a vault encryption key from all backends.
   */
  deleteVaultKey(vaultId: string): Promise<void>;
}

// Default passphrase for encrypted config when no interactive prompt is available.
// This provides basic obfuscation — the real security benefit is file permissions (0600)
// and the fact that credentials aren't in a JSON file that's easy to grep for API keys.
const DEFAULT_PASSPHRASE = 'lsvault-cli-local-encryption-key';

export interface CredentialManagerOptions {
  keychain?: KeychainBackend;
  encryptedConfig?: EncryptedConfigBackend;
  passphrase?: string;
}

export function createCredentialManager(options: CredentialManagerOptions = {}): CredentialManager {
  const keychain = options.keychain ?? createKeychainBackend();
  const encryptedConfig = options.encryptedConfig ?? createEncryptedConfigBackend();
  const passphrase = options.passphrase ?? DEFAULT_PASSPHRASE;

  return {
    async getCredentials(): Promise<Partial<CliConfig>> {
      const result: Partial<CliConfig> = {};

      // 1. Environment variables (highest priority)
      if (process.env.LSVAULT_API_KEY) {
        result.apiKey = process.env.LSVAULT_API_KEY;
      }
      if (process.env.LSVAULT_API_URL) {
        result.apiUrl = process.env.LSVAULT_API_URL;
      }

      // If env fully satisfies, return early
      if (result.apiKey) return result;

      // 2. OS Keychain
      if (await keychain.isAvailable()) {
        const keychainCreds = await keychain.getCredentials();
        if (keychainCreds.apiKey && !result.apiKey) result.apiKey = keychainCreds.apiKey;
        if (keychainCreds.apiUrl && !result.apiUrl) result.apiUrl = keychainCreds.apiUrl;
      }

      if (result.apiKey) return result;

      // 3. Encrypted config
      const encCreds = encryptedConfig.getCredentials(passphrase);
      if (encCreds) {
        if (encCreds.apiKey && !result.apiKey) result.apiKey = encCreds.apiKey;
        if (encCreds.apiUrl && !result.apiUrl) result.apiUrl = encCreds.apiUrl;
      }

      return result;
    },

    async saveCredentials(config: Partial<CliConfig>): Promise<void> {
      // Prefer keychain if available
      if (await keychain.isAvailable()) {
        await keychain.saveCredentials(config);
        return;
      }

      // Fall back to encrypted config
      encryptedConfig.saveCredentials(config, passphrase);
    },

    async clearCredentials(): Promise<void> {
      // Clear from all backends
      await keychain.clearCredentials();
      encryptedConfig.clearCredentials();
    },

    async getStorageMethod(): Promise<StorageMethod> {
      if (process.env.LSVAULT_API_KEY) return 'env';

      if (await keychain.isAvailable()) {
        const creds = await keychain.getCredentials();
        if (creds.apiKey) return 'keychain';
      }

      if (encryptedConfig.hasCredentials()) {
        const creds = encryptedConfig.getCredentials(passphrase);
        if (creds?.apiKey) return 'encrypted-config';
      }

      return 'none';
    },

    async getVaultKey(vaultId: string): Promise<string | null> {
      // 1. Environment variable: LSVAULT_VAULT_KEY_<vaultId> (hyphens to underscores, uppercase)
      const envKey = `LSVAULT_VAULT_KEY_${vaultId.replace(/-/g, '_').toUpperCase()}`;
      if (process.env[envKey]) {
        return process.env[envKey]!;
      }

      // 2. Encrypted config: vaultKeys map
      const creds = encryptedConfig.getCredentials(passphrase);
      const vaultKeys = (creds as Record<string, unknown>)?.vaultKeys as Record<string, string> | undefined;
      if (vaultKeys?.[vaultId]) {
        return vaultKeys[vaultId];
      }

      return null;
    },

    async saveVaultKey(vaultId: string, keyHex: string): Promise<void> {
      // Read existing config, merge vault key, save
      const existing = encryptedConfig.getCredentials(passphrase) ?? {};
      const vaultKeys = ((existing as Record<string, unknown>).vaultKeys as Record<string, string>) ?? {};
      vaultKeys[vaultId] = keyHex;
      encryptedConfig.saveCredentials({ ...existing, vaultKeys } as Partial<CliConfig>, passphrase);
    },

    async deleteVaultKey(vaultId: string): Promise<void> {
      const existing = encryptedConfig.getCredentials(passphrase) ?? {};
      const vaultKeys = ((existing as Record<string, unknown>).vaultKeys as Record<string, string>) ?? {};
      delete vaultKeys[vaultId];
      encryptedConfig.saveCredentials({ ...existing, vaultKeys } as Partial<CliConfig>, passphrase);
    },
  };
}
