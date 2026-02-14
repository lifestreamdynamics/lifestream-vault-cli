import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCredentialManager, type CredentialManager } from './credential-manager.js';
import type { KeychainBackend } from './keychain.js';
import type { EncryptedConfigBackend } from './encrypted-config.js';

function createMockKeychain(available = false): KeychainBackend {
  const store: Record<string, string> = {};
  return {
    isAvailable: vi.fn(async () => available),
    getCredentials: vi.fn(async () => {
      const result: Record<string, string> = {};
      if (store['apiKey']) result.apiKey = store['apiKey'];
      if (store['apiUrl']) result.apiUrl = store['apiUrl'];
      return result;
    }),
    saveCredentials: vi.fn(async (config) => {
      if (config.apiKey) store['apiKey'] = config.apiKey;
      if (config.apiUrl) store['apiUrl'] = config.apiUrl;
    }),
    clearCredentials: vi.fn(async () => {
      delete store['apiKey'];
      delete store['apiUrl'];
    }),
  };
}

function createMockEncryptedConfig(): EncryptedConfigBackend {
  let stored: Record<string, string> | null = null;
  return {
    isAvailable: vi.fn(() => true),
    getCredentials: vi.fn((_passphrase: string) => stored),
    saveCredentials: vi.fn((config, _passphrase: string) => {
      stored = { ...stored, ...config };
    }),
    clearCredentials: vi.fn(() => { stored = null; }),
    hasCredentials: vi.fn(() => stored !== null),
  };
}

describe('credential-manager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LSVAULT_API_KEY;
    delete process.env.LSVAULT_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getCredentials', () => {
    it('should prefer environment variables', async () => {
      process.env.LSVAULT_API_KEY = 'lsv_k_env';
      process.env.LSVAULT_API_URL = 'https://env.com';

      const keychain = createMockKeychain(true);
      const encConfig = createMockEncryptedConfig();
      const cm = createCredentialManager({ keychain, encryptedConfig: encConfig });

      const creds = await cm.getCredentials();

      expect(creds.apiKey).toBe('lsv_k_env');
      expect(creds.apiUrl).toBe('https://env.com');
      // Should NOT have queried keychain since env key was found
      expect(keychain.getCredentials).not.toHaveBeenCalled();
    });

    it('should fall back to keychain when env has no key', async () => {
      const keychain = createMockKeychain(true);
      await keychain.saveCredentials({ apiKey: 'lsv_k_keychain' });
      const encConfig = createMockEncryptedConfig();

      const cm = createCredentialManager({ keychain, encryptedConfig: encConfig });
      const creds = await cm.getCredentials();

      expect(creds.apiKey).toBe('lsv_k_keychain');
    });

    it('should fall back to encrypted config when keychain is unavailable', async () => {
      const keychain = createMockKeychain(false);
      const encConfig = createMockEncryptedConfig();
      encConfig.saveCredentials({ apiKey: 'lsv_k_encrypted' }, 'pass');

      const cm = createCredentialManager({ keychain, encryptedConfig: encConfig, passphrase: 'pass' });
      const creds = await cm.getCredentials();

      expect(creds.apiKey).toBe('lsv_k_encrypted');
    });

    it('should return empty when no credentials found', async () => {
      const keychain = createMockKeychain(false);
      const encConfig = createMockEncryptedConfig();

      const cm = createCredentialManager({ keychain, encryptedConfig: encConfig });
      const creds = await cm.getCredentials();

      expect(creds.apiKey).toBeUndefined();
    });
  });

  describe('saveCredentials', () => {
    it('should save to keychain when available', async () => {
      const keychain = createMockKeychain(true);
      const encConfig = createMockEncryptedConfig();

      const cm = createCredentialManager({ keychain, encryptedConfig: encConfig });
      await cm.saveCredentials({ apiKey: 'lsv_k_new' });

      expect(keychain.saveCredentials).toHaveBeenCalledWith({ apiKey: 'lsv_k_new' });
      expect(encConfig.saveCredentials).not.toHaveBeenCalled();
    });

    it('should fall back to encrypted config when keychain unavailable', async () => {
      const keychain = createMockKeychain(false);
      const encConfig = createMockEncryptedConfig();

      const cm = createCredentialManager({ keychain, encryptedConfig: encConfig, passphrase: 'pass' });
      await cm.saveCredentials({ apiKey: 'lsv_k_new' });

      expect(encConfig.saveCredentials).toHaveBeenCalled();
    });
  });

  describe('clearCredentials', () => {
    it('should clear from all backends', async () => {
      const keychain = createMockKeychain(true);
      await keychain.saveCredentials({ apiKey: 'lsv_k_test' });
      const encConfig = createMockEncryptedConfig();
      encConfig.saveCredentials({ apiKey: 'lsv_k_test' }, 'pass');

      const cm = createCredentialManager({ keychain, encryptedConfig: encConfig });
      await cm.clearCredentials();

      expect(keychain.clearCredentials).toHaveBeenCalled();
      expect(encConfig.clearCredentials).toHaveBeenCalled();
    });
  });

  describe('getStorageMethod', () => {
    it('should return env when env variable is set', async () => {
      process.env.LSVAULT_API_KEY = 'lsv_k_env';
      const cm = createCredentialManager({
        keychain: createMockKeychain(false),
        encryptedConfig: createMockEncryptedConfig(),
      });

      expect(await cm.getStorageMethod()).toBe('env');
    });

    it('should return keychain when keychain has credentials', async () => {
      const keychain = createMockKeychain(true);
      await keychain.saveCredentials({ apiKey: 'lsv_k_test' });
      const cm = createCredentialManager({
        keychain,
        encryptedConfig: createMockEncryptedConfig(),
      });

      expect(await cm.getStorageMethod()).toBe('keychain');
    });

    it('should return encrypted-config when encrypted config has credentials', async () => {
      const encConfig = createMockEncryptedConfig();
      encConfig.saveCredentials({ apiKey: 'lsv_k_test' }, 'pass');

      const cm = createCredentialManager({
        keychain: createMockKeychain(false),
        encryptedConfig: encConfig,
        passphrase: 'pass',
      });

      expect(await cm.getStorageMethod()).toBe('encrypted-config');
    });

    it('should return none when no credentials anywhere', async () => {
      const cm = createCredentialManager({
        keychain: createMockKeychain(false),
        encryptedConfig: createMockEncryptedConfig(),
      });

      expect(await cm.getStorageMethod()).toBe('none');
    });
  });
});
