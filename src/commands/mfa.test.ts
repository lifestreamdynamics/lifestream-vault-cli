import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerMfaCommands } from './mfa.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';

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

// Mock the prompt utilities so tests never try to read from a real TTY.
vi.mock('../utils/prompt.js', () => ({
  promptPassword: vi.fn(async () => null),
  promptMfaCode: vi.fn(async () => null),
}));

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

describe('mfa commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerMfaCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    process.exitCode = undefined;
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
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('MFA Status');
      expect(stdout).toContain('Enabled');
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

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('TOTP Configured');
      expect(stdout).toContain('Backup Codes Left');
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

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Registered Passkeys');
      expect(stdout).toContain('YubiKey 5');
      expect(stdout).toContain('iPhone 15');
      expect(stdout).toContain('never');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.mfa.getStatus.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'mfa', 'status']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });

    it('should output JSON record in json mode', async () => {
      sdkMock.mfa.getStatus.mockResolvedValue({
        mfaEnabled: true,
        totpConfigured: true,
        passkeyCount: 1,
        backupCodesRemaining: 5,
        passkeys: [{ id: 'pk1', name: 'YubiKey', createdAt: '2024-01-01T00:00:00Z', lastUsedAt: null }],
      });

      await program.parseAsync(['node', 'cli', 'mfa', 'status', '--output', 'json']);

      const jsonLine = outputSpy.stdout.find(l => l.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.mfaEnabled).toBe(true);
      expect(parsed.totpConfigured).toBe(true);
      expect(parsed.passkeyCount).toBe(1);
      expect(parsed.backupCodesRemaining).toBe(5);
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
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Backup Codes');
      expect(stdout).toContain('Remaining');
      expect(stdout).toContain('8');
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

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('no backup codes remaining');
      expect(stdout).toContain('--regenerate');
    });

    it('should set exitCode 1 on status fetch failure (B33)', async () => {
      sdkMock.mfa.getStatus.mockRejectedValue(new Error('Unauthorized'));

      await program.parseAsync(['node', 'cli', 'mfa', 'backup-codes']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Unauthorized');
      expect(process.exitCode).toBe(1);
    });

    it('should output JSON record in json mode', async () => {
      sdkMock.mfa.getStatus.mockResolvedValue({
        mfaEnabled: true,
        totpConfigured: true,
        passkeyCount: 0,
        backupCodesRemaining: 3,
        passkeys: [],
      });

      await program.parseAsync(['node', 'cli', 'mfa', 'backup-codes', '--output', 'json']);

      const jsonLine = outputSpy.stdout.find(l => l.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.backupCodesRemaining).toBe(3);
    });
  });

  describe('command group metadata', () => {
    it('should have JWT auth note in description (B17)', () => {
      const mfaCmd = program.commands.find(c => c.name() === 'mfa');
      expect(mfaCmd).toBeDefined();
      expect(mfaCmd!.description()).toContain('JWT auth');
    });
  });
});
