import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Mock node:fs but NOT node:os — os.homedir() is called at module-level
// so we need a real value. Instead, we mock fs operations.
vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

// Mock the credential manager module
const mockCredentialManager = {
  getCredentials: vi.fn(async () => ({})),
  saveCredentials: vi.fn(async () => {}),
  clearCredentials: vi.fn(async () => {}),
  getStorageMethod: vi.fn(async () => 'none' as const),
  getVaultKey: vi.fn(async () => null),
  saveVaultKey: vi.fn(async () => {}),
  deleteVaultKey: vi.fn(async () => {}),
};

vi.mock('./lib/credential-manager.js', () => ({
  createCredentialManager: vi.fn(() => mockCredentialManager),
}));

// The actual config module uses os.homedir() at import time to build paths.
// We import after mocking fs so file reads/writes are intercepted.
// We need to determine the actual CONFIG_DIR/CONFIG_FILE paths used by the module.
import os from 'node:os';
const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Now import the module under test
import { loadConfig, loadConfigAsync, saveConfig, getCredentialManager, setCredentialManager } from './config.js';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.LSVAULT_API_URL;
    delete process.env.LSVAULT_API_KEY;

    // Reset defaults
    mockCredentialManager.getCredentials.mockResolvedValue({});
    mockCredentialManager.getStorageMethod.mockResolvedValue('none');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig (sync, legacy)', () => {
    it('should return default API URL when no config exists', () => {
      mockedFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.apiUrl).toBe('http://localhost:4660');
      expect(config.apiKey).toBeUndefined();
    });

    it('should use LSVAULT_API_URL environment variable', () => {
      process.env.LSVAULT_API_URL = 'https://custom-server.com';
      mockedFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.apiUrl).toBe('https://custom-server.com');
    });

    it('should use LSVAULT_API_KEY environment variable', () => {
      process.env.LSVAULT_API_KEY = 'lsv_k_envkey';
      mockedFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config.apiKey).toBe('lsv_k_envkey');
    });

    it('should read from config file when it exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiUrl: 'https://file-server.com', apiKey: 'lsv_k_filekey' }),
      );

      const config = loadConfig();

      expect(config.apiUrl).toBe('https://file-server.com');
      expect(config.apiKey).toBe('lsv_k_filekey');
    });

    it('should prefer env var API key over file config', () => {
      process.env.LSVAULT_API_KEY = 'lsv_k_envkey';
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiKey: 'lsv_k_filekey' }),
      );

      const config = loadConfig();

      expect(config.apiKey).toBe('lsv_k_envkey');
    });

    it('should use file API URL over default', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiUrl: 'https://from-file.com' }),
      );

      const config = loadConfig();

      expect(config.apiUrl).toBe('https://from-file.com');
    });
  });

  describe('loadConfigAsync', () => {
    it('should use credential manager for secure credentials', async () => {
      mockCredentialManager.getCredentials.mockResolvedValue({
        apiKey: 'lsv_k_secure',
        apiUrl: 'https://secure.com',
      });

      const config = await loadConfigAsync();

      expect(config.apiKey).toBe('lsv_k_secure');
      expect(config.apiUrl).toBe('https://secure.com');
    });

    it('should fall back to plaintext config when no secure credentials', async () => {
      mockCredentialManager.getCredentials.mockResolvedValue({});
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiKey: 'lsv_k_plaintext', apiUrl: 'https://plain.com' }),
      );

      const config = await loadConfigAsync();

      expect(config.apiKey).toBe('lsv_k_plaintext');
    });

    it('should use default API URL when nothing else available', async () => {
      mockCredentialManager.getCredentials.mockResolvedValue({});
      mockedFs.existsSync.mockReturnValue(false);

      const config = await loadConfigAsync();

      expect(config.apiUrl).toBe('http://localhost:4660');
      expect(config.apiKey).toBeUndefined();
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if it does not exist', () => {
      mockedFs.existsSync.mockReturnValueOnce(false) // CONFIG_DIR check
        .mockReturnValueOnce(false); // CONFIG_FILE check

      saveConfig({ apiKey: 'lsv_k_newkey' });

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    });

    it('should merge with existing config', () => {
      mockedFs.existsSync.mockReturnValueOnce(true) // CONFIG_DIR exists
        .mockReturnValueOnce(true); // CONFIG_FILE exists
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiUrl: 'https://existing.com', apiKey: 'lsv_k_old' }),
      );

      saveConfig({ apiKey: 'lsv_k_new' });

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('"apiKey": "lsv_k_new"'),
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('"apiUrl": "https://existing.com"'),
      );
    });

    it('should write new config when no existing file', () => {
      mockedFs.existsSync.mockReturnValueOnce(true) // CONFIG_DIR exists
        .mockReturnValueOnce(false); // CONFIG_FILE does not exist

      saveConfig({ apiUrl: 'https://new.com' });

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        expect.stringContaining('"apiUrl": "https://new.com"'),
      );
    });
  });

  describe('getCredentialManager', () => {
    it('should return a credential manager instance', () => {
      const cm = getCredentialManager();
      expect(cm).toBeDefined();
      expect(cm.getCredentials).toBeDefined();
      expect(cm.saveCredentials).toBeDefined();
    });
  });
});
