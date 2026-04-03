import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
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

/**
 * Returns the machine-specific passphrase used to encrypt the local credential
 * store.  On first call it generates a cryptographically random 32-byte hex
 * string, writes it to `~/.lsvault/.passphrase` (mode 0o600, directory 0o700),
 * and returns it.  Subsequent calls read the stored value.
 *
 * This replaces the old hardcoded `DEFAULT_PASSPHRASE` constant so that the
 * passphrase is never present in source code or version control.
 */
function getOrCreatePassphrase(): string {
  const configDir = path.join(os.homedir(), '.lsvault');
  const passphrasePath = path.join(configDir, '.passphrase');

  try {
    return fs.readFileSync(passphrasePath, 'utf-8').trim();
  } catch {
    // File does not exist yet — generate a new one.
    const passphrase = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(passphrasePath, passphrase, { mode: 0o600 });
    return passphrase;
  }
}

export interface CredentialManagerOptions {
  keychain?: KeychainBackend;
  encryptedConfig?: EncryptedConfigBackend;
  passphrase?: string;
}

export function createCredentialManager(options: CredentialManagerOptions = {}): CredentialManager {
  const keychain = options.keychain ?? createKeychainBackend();
  const encryptedConfig = options.encryptedConfig ?? createEncryptedConfigBackend();
  // Use the caller-supplied passphrase (tests pass one explicitly) or lazily
  // generate / load the per-machine passphrase from ~/.lsvault/.passphrase.
  const passphrase = options.passphrase ?? getOrCreatePassphrase();

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
        try {
          await keychain.saveCredentials(config);
          return;
        } catch {
          // Keychain reported available but failed to save — fall through
          // to encrypted config silently.
        }
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
      const vaultKeys = creds?.vaultKeys;
      if (vaultKeys?.[vaultId]) {
        return vaultKeys[vaultId];
      }

      return null;
    },

    async saveVaultKey(vaultId: string, keyHex: string): Promise<void> {
      // Read existing config, merge vault key, save
      const existing = encryptedConfig.getCredentials(passphrase) ?? {};
      const vaultKeys: Record<string, string> = { ...(existing.vaultKeys ?? {}) };
      vaultKeys[vaultId] = keyHex;
      encryptedConfig.saveCredentials({ ...existing, vaultKeys }, passphrase);
    },

    async deleteVaultKey(vaultId: string): Promise<void> {
      const existing = encryptedConfig.getCredentials(passphrase) ?? {};
      const vaultKeys: Record<string, string> = { ...(existing.vaultKeys ?? {}) };
      delete vaultKeys[vaultId];
      encryptedConfig.saveCredentials({ ...existing, vaultKeys }, passphrase);
    },
  };
}
