import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerUserCommands } from './user.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClient: vi.fn(() => sdkMock),
}));

describe('user commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerUserCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('user storage', () => {
    it('should display storage usage with vault breakdown', async () => {
      sdkMock.user.getStorage.mockResolvedValue({
        totalBytes: 5242880,
        limitBytes: 104857600,
        vaults: [
          { vaultId: 'v1', name: 'Notes', bytes: 3145728, documentCount: 42 },
          { vaultId: 'v2', name: 'Work', bytes: 2097152, documentCount: 18 },
        ],
        vaultCount: 2,
        vaultLimit: 10,
        tier: 'pro',
      });

      await program.parseAsync(['node', 'cli', 'user', 'storage']);

      expect(sdkMock.user.getStorage).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('pro');
      expect(stdout).toContain('2 / 10');
      expect(stdout).toContain('Notes');
      expect(stdout).toContain('42 docs');
    });

    it('should handle empty storage', async () => {
      sdkMock.user.getStorage.mockResolvedValue({
        totalBytes: 0,
        limitBytes: 52428800,
        vaults: [],
        vaultCount: 0,
        vaultLimit: 3,
        tier: 'free',
      });

      await program.parseAsync(['node', 'cli', 'user', 'storage']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('free');
      expect(stdout).toContain('0 / 3');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.user.getStorage.mockRejectedValue(new Error('Server error'));

      await program.parseAsync(['node', 'cli', 'user', 'storage']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Server error');
      expect(process.exitCode).toBe(1);
    });
  });
});
