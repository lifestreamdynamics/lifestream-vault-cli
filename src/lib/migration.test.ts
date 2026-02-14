import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

const CONFIG_FILE = path.join(os.homedir(), '.lsvault', 'config.json');

import {
  hasPlaintextCredentials,
  readPlaintextConfig,
  removePlaintextApiKey,
  migrateCredentials,
} from './migration.js';
import type { CredentialManager } from './credential-manager.js';

function createMockCredentialManager(): CredentialManager {
  return {
    getCredentials: vi.fn(async () => ({})),
    saveCredentials: vi.fn(async () => {}),
    clearCredentials: vi.fn(async () => {}),
    getStorageMethod: vi.fn(async () => 'encrypted-config' as const),
    getVaultKey: vi.fn(async () => null),
    saveVaultKey: vi.fn(async () => {}),
    deleteVaultKey: vi.fn(async () => {}),
  };
}

describe('migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasPlaintextCredentials', () => {
    it('should return false when no config file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(hasPlaintextCredentials()).toBe(false);
    });

    it('should return false when config has no apiKey', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiUrl: 'http://localhost:4660' }));
      expect(hasPlaintextCredentials()).toBe(false);
    });

    it('should return true when config has an apiKey', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiKey: 'lsv_k_test' }));
      expect(hasPlaintextCredentials()).toBe(true);
    });

    it('should return false for empty apiKey', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiKey: '' }));
      expect(hasPlaintextCredentials()).toBe(false);
    });

    it('should return false for corrupt file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-json');
      expect(hasPlaintextCredentials()).toBe(false);
    });
  });

  describe('readPlaintextConfig', () => {
    it('should return empty object when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(readPlaintextConfig()).toEqual({});
    });

    it('should return parsed config', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiKey: 'lsv_k_test', apiUrl: 'https://example.com' }),
      );
      expect(readPlaintextConfig()).toEqual({
        apiKey: 'lsv_k_test',
        apiUrl: 'https://example.com',
      });
    });
  });

  describe('removePlaintextApiKey', () => {
    it('should remove apiKey but keep other fields', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiKey: 'lsv_k_test', apiUrl: 'https://example.com' }),
      );

      removePlaintextApiKey();

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.not.stringContaining('apiKey'),
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('https://example.com'),
      );
    });

    it('should do nothing when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      removePlaintextApiKey();
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('migrateCredentials', () => {
    it('should return early when no plaintext credentials exist', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      const cm = createMockCredentialManager();

      const result = await migrateCredentials(cm);

      expect(result.migrated).toBe(false);
      expect(result.error).toBe('No plaintext credentials found');
    });

    it('should migrate credentials to secure storage', async () => {
      // hasPlaintextCredentials check
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiKey: 'lsv_k_migrate_me', apiUrl: 'https://example.com' }),
      );

      const cm = createMockCredentialManager();
      const result = await migrateCredentials(cm);

      expect(result.migrated).toBe(true);
      expect(result.method).toBe('encrypted-config');
      expect(cm.saveCredentials).toHaveBeenCalledWith({ apiKey: 'lsv_k_migrate_me' });
    });

    it('should skip when user declines prompt', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiKey: 'lsv_k_test' }));

      const cm = createMockCredentialManager();
      const promptFn = vi.fn(async () => false);

      const result = await migrateCredentials(cm, promptFn);

      expect(result.migrated).toBe(false);
      expect(result.method).toBe('skipped');
      expect(cm.saveCredentials).not.toHaveBeenCalled();
    });

    it('should proceed when user accepts prompt', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiKey: 'lsv_k_test' }));

      const cm = createMockCredentialManager();
      const promptFn = vi.fn(async () => true);

      const result = await migrateCredentials(cm, promptFn);

      expect(result.migrated).toBe(true);
      expect(cm.saveCredentials).toHaveBeenCalled();
    });

    it('should handle save errors', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiKey: 'lsv_k_test' }));

      const cm = createMockCredentialManager();
      vi.mocked(cm.saveCredentials).mockRejectedValue(new Error('save failed'));

      const result = await migrateCredentials(cm);

      expect(result.migrated).toBe(false);
      expect(result.error).toBe('save failed');
    });
  });
});
