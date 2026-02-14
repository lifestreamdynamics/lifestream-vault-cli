import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const ENCRYPTED_FILE = path.join(CONFIG_DIR, 'credentials.enc');

import { createEncryptedConfigBackend } from './encrypted-config.js';

describe('encrypted-config', () => {
  let backend: ReturnType<typeof createEncryptedConfigBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = createEncryptedConfigBackend();
  });

  describe('isAvailable', () => {
    it('should always return true', () => {
      expect(backend.isAvailable()).toBe(true);
    });
  });

  describe('hasCredentials', () => {
    it('should return false when no encrypted file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(backend.hasCredentials()).toBe(false);
    });

    it('should return true when encrypted file exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      expect(backend.hasCredentials()).toBe(true);
    });
  });

  describe('saveCredentials and getCredentials (roundtrip)', () => {
    it('should encrypt and decrypt credentials successfully', () => {
      const passphrase = 'test-passphrase';
      const config = { apiKey: 'lsv_k_test123', apiUrl: 'https://example.com' };
      let savedContent = '';

      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockImplementation((_path, content) => {
        savedContent = content as string;
      });

      backend.saveCredentials(config, passphrase);

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true, mode: 0o700 });
      // Atomic write: writes to temp file then renames
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/^.*credentials\.enc\.tmp\.[0-9a-f]{8}$/),
        expect.any(String),
        { mode: 0o600 },
      );
      expect(mockedFs.renameSync).toHaveBeenCalledWith(
        expect.stringMatching(/^.*credentials\.enc\.tmp\.[0-9a-f]{8}$/),
        ENCRYPTED_FILE,
      );

      // Parse the saved encrypted data
      const encrypted = JSON.parse(savedContent);
      expect(encrypted.version).toBe(1);
      expect(encrypted.salt).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.authTag).toBeDefined();
      expect(encrypted.ciphertext).toBeDefined();

      // Verify the ciphertext does NOT contain the raw API key
      expect(encrypted.ciphertext).not.toContain('lsv_k_test123');

      // Now test decryption
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(savedContent);

      const result = backend.getCredentials(passphrase);
      expect(result).toEqual(config);
    });

    it('should return null for wrong passphrase', () => {
      const passphrase = 'correct-passphrase';
      const config = { apiKey: 'lsv_k_test123' };
      let savedContent = '';

      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockImplementation((_path, content) => {
        savedContent = content as string;
      });

      backend.saveCredentials(config, passphrase);

      // Try to decrypt with wrong passphrase
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(savedContent);

      const result = backend.getCredentials('wrong-passphrase');
      expect(result).toBeNull();
    });

    it('should return null when file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const result = backend.getCredentials('any-passphrase');
      expect(result).toBeNull();
    });

    it('should return null for corrupt file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-json');

      const result = backend.getCredentials('any-passphrase');
      expect(result).toBeNull();
    });

    it('should return null for wrong version', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ version: 2 }));

      const result = backend.getCredentials('any-passphrase');
      expect(result).toBeNull();
    });

    it('should merge with existing credentials on save', () => {
      const passphrase = 'test-passphrase';
      let savedContent = '';

      // First save
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.mkdirSync.mockReturnValue(undefined);
      mockedFs.writeFileSync.mockImplementation((_path, content) => {
        savedContent = content as string;
      });

      backend.saveCredentials({ apiKey: 'lsv_k_first' }, passphrase);
      const firstSave = savedContent;

      // Second save — should merge
      mockedFs.existsSync.mockImplementation((p) => {
        return p === ENCRYPTED_FILE || p === CONFIG_DIR;
      });
      mockedFs.readFileSync.mockReturnValue(firstSave);

      backend.saveCredentials({ apiUrl: 'https://new-url.com' }, passphrase);

      // Verify merged content
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(savedContent);

      const result = backend.getCredentials(passphrase);
      expect(result).toEqual({
        apiKey: 'lsv_k_first',
        apiUrl: 'https://new-url.com',
      });
    });
  });

  describe('clearCredentials', () => {
    it('should delete the encrypted file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.unlinkSync.mockReturnValue(undefined);

      backend.clearCredentials();

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(ENCRYPTED_FILE);
    });

    it('should do nothing if file does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);

      backend.clearCredentials();

      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
