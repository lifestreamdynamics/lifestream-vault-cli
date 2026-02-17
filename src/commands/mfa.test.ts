import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerMfaCommands } from './mfa.js';
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

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

describe('mfa commands', () => {
  let program: Command;
  let consoleSpy: ReturnType<typeof spyConsole>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerMfaCommands(program);
    sdkMock = createSDKMock();
    consoleSpy = spyConsole();
    vi.clearAllMocks();
  });

  afterEach(() => {
    consoleSpy.restore();
  });

  describe('status', () => {
    it('should display MFA status with no methods configured', async () => {
      sdkMock.mfa.getStatus.mockResolvedValue({
        mfaEnabled: false,
        totpConfigured: false,
        passkeyCount: 0,
        backupCodesRemaining: 0,
        passkeys: [],
      });

      await program.parseAsync(['node', 'cli', 'mfa', 'status']);

      expect(sdkMock.mfa.getStatus).toHaveBeenCalled();
      expect(consoleSpy.logs.some(l => l.includes('MFA Status'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('Enabled') && l.includes('No'))).toBe(true);
    });

    it('should display MFA status with TOTP configured', async () => {
      sdkMock.mfa.getStatus.mockResolvedValue({
        mfaEnabled: true,
        totpConfigured: true,
        passkeyCount: 0,
        backupCodesRemaining: 5,
        passkeys: [],
      });

      await program.parseAsync(['node', 'cli', 'mfa', 'status']);

      expect(consoleSpy.logs.some(l => l.includes('TOTP Configured') && l.includes('Yes'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('Backup Codes Left') && l.includes('5'))).toBe(true);
    });

    it('should display registered passkeys', async () => {
      sdkMock.mfa.getStatus.mockResolvedValue({
        mfaEnabled: true,
        totpConfigured: false,
        passkeyCount: 2,
        backupCodesRemaining: 10,
        passkeys: [
          {
            id: 'pk1',
            name: 'YubiKey 5',
            createdAt: '2024-01-01T00:00:00Z',
            lastUsedAt: '2024-01-15T00:00:00Z',
          },
          {
            id: 'pk2',
            name: 'iPhone 15',
            createdAt: '2024-01-02T00:00:00Z',
            lastUsedAt: null,
          },
        ],
      });

      await program.parseAsync(['node', 'cli', 'mfa', 'status']);

      expect(consoleSpy.logs.some(l => l.includes('Registered Passkeys'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('YubiKey 5'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('iPhone 15'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('never'))).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      sdkMock.mfa.getStatus.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'mfa', 'status']);

      expect(consoleSpy.errors.some(l => l.includes('Network error'))).toBe(true);
    });
  });

  describe('backup-codes', () => {
    it('should show backup code count', async () => {
      sdkMock.mfa.getStatus.mockResolvedValue({
        mfaEnabled: true,
        totpConfigured: true,
        passkeyCount: 0,
        backupCodesRemaining: 8,
        passkeys: [],
      });

      await program.parseAsync(['node', 'cli', 'mfa', 'backup-codes']);

      expect(sdkMock.mfa.getStatus).toHaveBeenCalled();
      expect(consoleSpy.logs.some(l => l.includes('Backup Codes'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('Remaining') && l.includes('8'))).toBe(true);
    });

    it('should warn when no backup codes remain', async () => {
      sdkMock.mfa.getStatus.mockResolvedValue({
        mfaEnabled: true,
        totpConfigured: true,
        passkeyCount: 0,
        backupCodesRemaining: 0,
        passkeys: [],
      });

      await program.parseAsync(['node', 'cli', 'mfa', 'backup-codes']);

      expect(consoleSpy.logs.some(l => l.includes('no backup codes remaining'))).toBe(true);
      expect(consoleSpy.logs.some(l => l.includes('--regenerate'))).toBe(true);
    });

    it('should handle errors in status fetch', async () => {
      sdkMock.mfa.getStatus.mockRejectedValue(new Error('Unauthorized'));

      await program.parseAsync(['node', 'cli', 'mfa', 'backup-codes']);

      expect(consoleSpy.errors.some(l => l.includes('Unauthorized'))).toBe(true);
    });
  });
});
