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
vi.mock('@lifestream-vault/sdk', () => ({
  LifestreamVaultClient: vi.fn(function (this: any, opts: { baseUrl: string; apiKey?: string; accessToken?: string }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
  }),
}));

import { loadConfig } from './config.js';
import { getClient } from './client.js';

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
  });

  it('should create a client when API key is configured', () => {
    mockedLoadConfig.mockReturnValue({
      apiUrl: 'http://localhost:4660',
      apiKey: 'lsv_k_testkey',
    });

    const client = getClient();

    expect(client).toBeDefined();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('should exit with error when no API key is set', () => {
    mockedLoadConfig.mockReturnValue({
      apiUrl: 'http://localhost:4660',
    });

    getClient();

    expect(consoleSpy.errors.some(l => l.includes('No credentials configured'))).toBe(true);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
