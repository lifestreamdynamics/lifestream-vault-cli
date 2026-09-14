import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spyConsole } from './__tests__/setup.js';

// Mock config module
vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
  loadConfigAsync: vi.fn(),
  getCredentialManager: vi.fn(() => ({
    saveCredentials: vi.fn(),
    getCredentials: vi.fn().mockResolvedValue({}),
    clearCredentials: vi.fn(),
    getStorageMethod: vi.fn().mockResolvedValue('none'),
    getVaultKey: vi.fn().mockResolvedValue(null),
    saveVaultKey: vi.fn(),
    deleteVaultKey: vi.fn(),
  })),
}));

// Mock the SDK - must use function() (NOT arrow) for constructable mock
vi.mock('@lifestreamdynamics/vault-sdk', () => ({
  LifestreamVaultClient: vi.fn(function (this: any, opts: { baseUrl: string; apiKey?: string; accessToken?: string; timeout?: number }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
    this.timeout = opts.timeout;
  }),
}));

import { loadConfig, loadConfigAsync, getCredentialManager } from './config.js';
import { LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import { getClient, getClientAsync, getHttpTimeoutMs } from './client.js';

const mockedLoadConfig = vi.mocked(loadConfig);

// Mock process.exit to prevent test termination
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

describe('client', () => {
  let consoleSpy: ReturnType<typeof spyConsole>;

  beforeEach(() => {
    consoleSpy = spyConsole();
    vi.clearAllMocks();
    mockExit.mockClear();
  });

  afterEach(() => {
    consoleSpy.restore();
    delete process.env.LSVAULT_HTTP_TIMEOUT_MS;
  });

  it('should create a client when API key is configured', () => {
    mockedLoadConfig.mockReturnValue({
      apiUrl: 'https://vault.lifestreamdynamics.com',
      apiKey: 'lsv_k_testkey',
    });

    const client = getClient();

    expect(client).toBeDefined();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('should exit with error when no API key is set', () => {
    mockedLoadConfig.mockReturnValue({
      apiUrl: 'https://vault.lifestreamdynamics.com',
    });

    expect(() => getClient()).toThrow('No credentials configured');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('passes the validated environment timeout to the SDK client', () => {
    process.env.LSVAULT_HTTP_TIMEOUT_MS = '45000';
    mockedLoadConfig.mockReturnValue({ apiUrl: 'https://example.test', apiKey: 'key' });
    getClient();
    expect(LifestreamVaultClient).toHaveBeenCalledWith(expect.objectContaining({ timeout: 45_000 }));
  });

  it.each(['999', '300001', '1.5', 'abc'])('rejects invalid HTTP timeout %s', value => {
    expect(() => getHttpTimeoutMs(value)).toThrow(/LSVAULT_HTTP_TIMEOUT_MS/);
  });

  // The server rotates the refresh token on every refresh and invalidates the
  // one presented, so a CLI that keeps only the new access token loses its
  // session on the next process that needs to refresh.
  describe.each([
    ['getClient', () => { mockedLoadConfig.mockReturnValue({ apiUrl: 'https://x.test', accessToken: 'a0', refreshToken: 'r0' }); getClient(); }],
    ['getClientAsync', async () => { vi.mocked(loadConfigAsync).mockResolvedValue({ apiUrl: 'https://x.test', accessToken: 'a0', refreshToken: 'r0' }); await getClientAsync(); }],
  ])('%s token refresh persistence', (_name, build) => {
    it('persists the rotated refresh token alongside the access token', async () => {
      const saveCredentials = vi.fn();
      vi.mocked(getCredentialManager).mockReturnValue({ saveCredentials } as never);
      await build();

      const opts = vi.mocked(LifestreamVaultClient).mock.calls.at(-1)![0] as { onTokenRefresh: (t: unknown) => Promise<void> };
      await opts.onTokenRefresh({ accessToken: 'a1', refreshToken: 'r1', user: {} });

      expect(saveCredentials).toHaveBeenCalledWith({ accessToken: 'a1', refreshToken: 'r1' });
    });

    it('does not overwrite the stored refresh token when none was returned', async () => {
      const saveCredentials = vi.fn();
      vi.mocked(getCredentialManager).mockReturnValue({ saveCredentials } as never);
      await build();

      const opts = vi.mocked(LifestreamVaultClient).mock.calls.at(-1)![0] as { onTokenRefresh: (t: unknown) => Promise<void> };
      await opts.onTokenRefresh({ accessToken: 'a1', user: {} });

      expect(saveCredentials).toHaveBeenCalledWith({ accessToken: 'a1' });
    });
  });

  it('uses the 30 second default and accepts the 1-300 second boundaries', () => {
    expect(getHttpTimeoutMs(undefined)).toBe(30_000);
    expect(getHttpTimeoutMs('1000')).toBe(1_000);
    expect(getHttpTimeoutMs('300000')).toBe(300_000);
  });
});
