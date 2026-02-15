import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerAuthCommands } from './auth.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyConsole } from '../__tests__/setup.js';

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

const mockCredentialManager = {
  getCredentials: vi.fn(async () => ({})),
  saveCredentials: vi.fn(async () => {}),
  clearCredentials: vi.fn(async () => {}),
  getStorageMethod: vi.fn<() => Promise<string>>(async () => 'encrypted-config'),
  getVaultKey: vi.fn(async () => null),
  saveVaultKey: vi.fn(async () => {}),
  deleteVaultKey: vi.fn(async () => {}),
};

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(),
  loadConfigAsync: vi.fn(async () => ({
    apiUrl: 'https://vault.lifestreamdynamics.com',
  })),
  saveConfig: vi.fn(),
  getCredentialManager: vi.fn(() => mockCredentialManager),
}));

vi.mock('../lib/migration.js', () => ({
  migrateCredentials: vi.fn(async () => ({ migrated: true, method: 'encrypted-config' })),
  hasPlaintextCredentials: vi.fn(() => false),
  checkAndPromptMigration: vi.fn(async () => false),
}));

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

import { loadConfig, loadConfigAsync, saveConfig, getCredentialManager } from '../config.js';
import { migrateCredentials, hasPlaintextCredentials, checkAndPromptMigration } from '../lib/migration.js';

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedLoadConfigAsync = vi.mocked(loadConfigAsync);
const mockedSaveConfig = vi.mocked(saveConfig);
const mockedHasPlaintextCredentials = vi.mocked(hasPlaintextCredentials);
const mockedMigrateCredentials = vi.mocked(migrateCredentials);

describe('auth commands', () => {
  let program: Command;
  let consoleSpy: ReturnType<typeof spyConsole>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAuthCommands(program);
    sdkMock = createSDKMock();
    consoleSpy = spyConsole();
    vi.clearAllMocks();

    // Reset defaults
    mockCredentialManager.getCredentials.mockResolvedValue({});
    mockCredentialManager.saveCredentials.mockResolvedValue(undefined);
    mockCredentialManager.clearCredentials.mockResolvedValue(undefined);
    mockCredentialManager.getStorageMethod.mockResolvedValue('encrypted-config');
    mockedLoadConfigAsync.mockResolvedValue({ apiUrl: 'https://vault.lifestreamdynamics.com' });
    mockedHasPlaintextCredentials.mockReturnValue(false);
  });

  afterEach(() => {
    consoleSpy.restore();
  });

  describe('login', () => {
    it('should save API key to secure storage', async () => {
      await program.parseAsync(['node', 'cli', 'auth', 'login', '--api-key', 'lsv_k_testkey123']);

      expect(mockCredentialManager.saveCredentials).toHaveBeenCalledWith({ apiKey: 'lsv_k_testkey123' });
    });

    it('should save API URL', async () => {
      await program.parseAsync(['node', 'cli', 'auth', 'login', '--api-url', 'https://my-server.com']);

      expect(mockCredentialManager.saveCredentials).toHaveBeenCalledWith({ apiUrl: 'https://my-server.com' });
    });

    it('should save both API key and URL', async () => {
      await program.parseAsync([
        'node', 'cli', 'auth', 'login',
        '--api-key', 'lsv_k_testkey123',
        '--api-url', 'https://my-server.com',
      ]);

      expect(mockCredentialManager.saveCredentials).toHaveBeenCalledWith({ apiKey: 'lsv_k_testkey123' });
      expect(mockCredentialManager.saveCredentials).toHaveBeenCalledWith({ apiUrl: 'https://my-server.com' });
    });

    it('should print usage when neither option is provided', async () => {
      await program.parseAsync(['node', 'cli', 'auth', 'login']);

      expect(mockCredentialManager.saveCredentials).not.toHaveBeenCalled();
      expect(consoleSpy.logs.some(l => l.includes('Usage:'))).toBe(true);
    });

    it('should handle save errors gracefully', async () => {
      mockCredentialManager.saveCredentials.mockRejectedValue(new Error('keychain locked'));

      await program.parseAsync(['node', 'cli', 'auth', 'login', '--api-key', 'lsv_k_test']);

      expect(consoleSpy.errors.some(l => l.includes('keychain locked'))).toBe(true);
    });
  });

  describe('logout', () => {
    it('should clear all credentials', async () => {
      await program.parseAsync(['node', 'cli', 'auth', 'logout']);

      expect(mockCredentialManager.clearCredentials).toHaveBeenCalled();
    });

    it('should handle clear errors gracefully', async () => {
      mockCredentialManager.clearCredentials.mockRejectedValue(new Error('access denied'));

      await program.parseAsync(['node', 'cli', 'auth', 'logout']);

      expect(consoleSpy.errors.some(l => l.includes('access denied'))).toBe(true);
    });
  });

  describe('status', () => {
    it('should display storage method and config', async () => {
      mockCredentialManager.getStorageMethod.mockResolvedValue('keychain');
      mockedLoadConfigAsync.mockResolvedValue({
        apiUrl: 'https://vault.lifestreamdynamics.com',
        apiKey: 'lsv_k_abcdefghij',
      });

      await program.parseAsync(['node', 'cli', 'auth', 'status']);

      expect(consoleSpy.logs.some(l => l.includes('Credential Storage Status'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('OS Keychain'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('lsv_k_abcdef'))).toBe(true);
    });

    it('should warn about plaintext credentials', async () => {
      mockedHasPlaintextCredentials.mockReturnValue(true);
      mockCredentialManager.getStorageMethod.mockResolvedValue('none');

      await program.parseAsync(['node', 'cli', 'auth', 'status']);

      expect(consoleSpy.logs.some(l => l.includes('Plaintext credentials found'))).toBe(true);
    });
  });

  describe('migrate', () => {
    it('should skip when no plaintext credentials exist', async () => {
      mockedHasPlaintextCredentials.mockReturnValue(false);

      await program.parseAsync(['node', 'cli', 'auth', 'migrate']);

      expect(consoleSpy.logs.some(l => l.includes('Nothing to migrate'))).toBe(true);
      expect(mockedMigrateCredentials).not.toHaveBeenCalled();
    });

    it('should migrate plaintext credentials', async () => {
      mockedHasPlaintextCredentials.mockReturnValue(true);
      mockedMigrateCredentials.mockResolvedValue({
        migrated: true,
        method: 'encrypted-config',
      });

      await program.parseAsync(['node', 'cli', 'auth', 'migrate']);

      expect(mockedMigrateCredentials).toHaveBeenCalled();
    });

    it('should handle migration failure', async () => {
      mockedHasPlaintextCredentials.mockReturnValue(true);
      mockedMigrateCredentials.mockResolvedValue({
        migrated: false,
        method: 'error',
        error: 'Something went wrong',
      });

      await program.parseAsync(['node', 'cli', 'auth', 'migrate']);

      // ora.fail should have been called (we check the migration was invoked)
      expect(mockedMigrateCredentials).toHaveBeenCalled();
    });
  });

  describe('whoami', () => {
    it('should display API URL and masked API key', async () => {
      mockedLoadConfigAsync.mockResolvedValue({
        apiUrl: 'https://vault.lifestreamdynamics.com',
        apiKey: 'lsv_k_abcdefghij',
      });
      sdkMock.user.me.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        name: 'Test User',
        role: 'user',
        subscriptionTier: 'pro',
        subscriptionExpiresAt: '2025-12-31',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'auth', 'whoami']);

      expect(consoleSpy.logs.some(l => l.includes('https://vault.lifestreamdynamics.com'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('lsv_k_abcdef'))).toBe(true);
      // Should be masked (not show full key)
      expect(consoleSpy.logs.some(l => l.includes('lsv_k_abcdefghij'))).toBe(false);
    });

    it('should show "not set" when no API key is configured', async () => {
      mockedLoadConfigAsync.mockResolvedValue({
        apiUrl: 'https://vault.lifestreamdynamics.com',
      });

      await program.parseAsync(['node', 'cli', 'auth', 'whoami']);

      expect(consoleSpy.logs.some(l => l.includes('not set'))).toBe(true);
    });

    it('should fetch and display user info when API key is set', async () => {
      mockedLoadConfigAsync.mockResolvedValue({
        apiUrl: 'https://vault.lifestreamdynamics.com',
        apiKey: 'lsv_k_testkey123',
      });
      sdkMock.user.me.mockResolvedValue({
        id: 'u1',
        email: 'user@example.com',
        name: 'Test User',
        role: 'user',
        subscriptionTier: 'pro',
        subscriptionExpiresAt: '2025-12-31',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'auth', 'whoami']);

      expect(sdkMock.user.me).toHaveBeenCalled();
      expect(consoleSpy.logs.some(l => l.includes('user@example.com'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('Test User'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('pro'))).toBe(true);
    });

    it('should handle API errors gracefully in whoami', async () => {
      mockedLoadConfigAsync.mockResolvedValue({
        apiUrl: 'https://vault.lifestreamdynamics.com',
        apiKey: 'lsv_k_testkey123',
      });
      sdkMock.user.me.mockRejectedValue(new Error('Connection refused'));

      await program.parseAsync(['node', 'cli', 'auth', 'whoami']);

      expect(consoleSpy.errors.some(l => l.includes('Connection refused'))).toBe(true);
    });
  });
});
