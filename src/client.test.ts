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

import { loadConfig } from './config.js';
import { LifestreamVaultClient } from '@lifestreamdynamics/vault-sdk';
import { getClient, getHttpTimeoutMs } from './client.js';

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

  it('uses the 30 second default and accepts the 1-300 second boundaries', () => {
    expect(getHttpTimeoutMs(undefined)).toBe(30_000);
    expect(getHttpTimeoutMs('1000')).toBe(1_000);
    expect(getHttpTimeoutMs('300000')).toBe(300_000);
  });
});
