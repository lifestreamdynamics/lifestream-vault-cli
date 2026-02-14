import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeychainBackend, type KeychainBackend } from './keychain.js';

// Mock the dynamic import of keytar
const mockKeytar = {
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
};

describe('keychain', () => {
  let backend: KeychainBackend;

  describe('when keytar is available', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // We create a backend with mocked keytar by intercepting the import
      vi.doUnmock('keytar');
      vi.doMock('keytar', () => ({ default: mockKeytar, ...mockKeytar }));
      backend = createKeychainBackend();
    });

    it('should report available when probe succeeds', async () => {
      mockKeytar.getPassword.mockResolvedValue(null);
      const available = await backend.isAvailable();
      expect(available).toBe(true);
    });

    it('should get credentials from keychain', async () => {
      // First call: isAvailable probe
      mockKeytar.getPassword
        .mockResolvedValueOnce(null) // probe
        .mockResolvedValueOnce('lsv_k_test123') // api-key
        .mockResolvedValueOnce('https://example.com'); // api-url

      // Force availability check
      await backend.isAvailable();
      const creds = await backend.getCredentials();

      expect(creds.apiKey).toBe('lsv_k_test123');
      expect(creds.apiUrl).toBe('https://example.com');
    });

    it('should save credentials to keychain', async () => {
      mockKeytar.getPassword.mockResolvedValue(null);
      mockKeytar.setPassword.mockResolvedValue(undefined);

      await backend.isAvailable();
      await backend.saveCredentials({ apiKey: 'lsv_k_new', apiUrl: 'https://new.com' });

      expect(mockKeytar.setPassword).toHaveBeenCalledWith(
        'lifestream-vault-cli', 'api-key', 'lsv_k_new',
      );
      expect(mockKeytar.setPassword).toHaveBeenCalledWith(
        'lifestream-vault-cli', 'api-url', 'https://new.com',
      );
    });

    it('should clear credentials from keychain', async () => {
      mockKeytar.getPassword.mockResolvedValue(null);
      mockKeytar.deletePassword.mockResolvedValue(true);

      await backend.isAvailable();
      await backend.clearCredentials();

      expect(mockKeytar.deletePassword).toHaveBeenCalledWith(
        'lifestream-vault-cli', 'api-key',
      );
      expect(mockKeytar.deletePassword).toHaveBeenCalledWith(
        'lifestream-vault-cli', 'api-url',
      );
    });

    it('should return empty credentials on keychain error', async () => {
      mockKeytar.getPassword.mockResolvedValueOnce(null); // probe
      mockKeytar.getPassword.mockRejectedValueOnce(new Error('access denied'));

      await backend.isAvailable();
      const creds = await backend.getCredentials();

      expect(creds).toEqual({});
    });
  });

  describe('when keytar is unavailable', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      // Mock keytar to fail on import
      vi.doMock('keytar', () => {
        throw new Error('Cannot find module keytar');
      });
      // Need to create a fresh backend that will try to import the failing mock
      backend = createKeychainBackend();
    });

    it('should report not available', async () => {
      const available = await backend.isAvailable();
      expect(available).toBe(false);
    });

    it('should return empty credentials', async () => {
      const creds = await backend.getCredentials();
      expect(creds).toEqual({});
    });

    it('should throw on save', async () => {
      await expect(backend.saveCredentials({ apiKey: 'test' }))
        .rejects.toThrow('Keychain is not available');
    });

    it('should not throw on clear', async () => {
      await expect(backend.clearCredentials()).resolves.toBeUndefined();
    });
  });
});
