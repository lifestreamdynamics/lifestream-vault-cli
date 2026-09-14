import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

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

const saveCredentials = vi.fn(async () => {});
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(),
  loadConfigAsync: vi.fn(async () => ({
    apiUrl: 'https://vault.example.com',
    accessToken: 'expired-access',
    refreshToken: 'stored-refresh',
  })),
  saveConfig: vi.fn(),
  getCredentialManager: vi.fn(() => ({ saveCredentials })),
}));

vi.mock('../lib/migration.js', () => ({
  migrateCredentials: vi.fn(),
  hasPlaintextCredentials: vi.fn(() => false),
  checkAndPromptMigration: vi.fn(async () => false),
}));

vi.mock('../client.js', () => ({ getClientAsync: vi.fn(), getHttpTimeoutMs: vi.fn(() => 30_000) }));

// Capture the options the command builds the client with, and simulate the SDK
// firing onTokenRefresh with a rotated refresh token during the request.
vi.mock('@lifestreamdynamics/vault-sdk', () => ({
  LifestreamVaultClient: vi.fn(function (this: any, options: any) {
    this.user = {
      me: vi.fn(async () => {
        await options.onTokenRefresh?.({
          accessToken: 'new-access',
          refreshToken: 'rotated-refresh',
          user: { id: 'u1', email: 'user@example.com', role: 'user' },
        });
        return { email: 'user@example.com' };
      }),
    };
  }),
}));

import { registerAuthCommands } from './auth.js';

describe('auth refresh', () => {
  beforeEach(() => {
    saveCredentials.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('persists the rotated refresh token, not just the access token', async () => {
    const program = new Command();
    program.exitOverride();
    registerAuthCommands(program);

    await program.parseAsync(['node', 'cli', 'auth', 'refresh']);

    // The server deletes the presented refresh token on every refresh. Saving
    // only the access token left the keychain holding a dead refresh token, so
    // the next CLI invocation after 15 minutes could not refresh at all.
    expect(saveCredentials).toHaveBeenCalledWith({
      accessToken: 'new-access',
      refreshToken: 'rotated-refresh',
    });
  });
});
