import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerUserCommands } from './user.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';

// Mock the prompt utilities so tests never try to read from a real TTY.
vi.mock('../utils/prompt.js', () => ({
  promptPassword: vi.fn(async () => null),
  readPasswordFromStdin: vi.fn(async () => null),
}));

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
  getClientAsync: vi.fn(async () => sdkMock),
}));

import { promptPassword, readPasswordFromStdin } from '../utils/prompt.js';
const mockedPromptPassword = vi.mocked(promptPassword);
const mockedReadPasswordFromStdin = vi.mocked(readPasswordFromStdin);

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
    mockedPromptPassword.mockResolvedValue(null);
    mockedReadPasswordFromStdin.mockResolvedValue(null);
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

  // ── Password Change ─────────────────────────────────────────────────

  describe('user password', () => {
    it('should change password using interactive prompts', async () => {
      mockedPromptPassword
        .mockResolvedValueOnce('oldpass')
        .mockResolvedValueOnce('newpass');
      sdkMock.user.changePassword.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'user', 'password']);

      expect(sdkMock.user.changePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpass',
        newPassword: 'newpass',
      });
    });

    it('should change password using --password-stdin (two lines)', async () => {
      mockedReadPasswordFromStdin
        .mockResolvedValueOnce('oldpass')
        .mockResolvedValueOnce('newpass');
      sdkMock.user.changePassword.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'user', 'password', '--password-stdin']);

      expect(sdkMock.user.changePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpass',
        newPassword: 'newpass',
      });
    });

    it('should error when current password is empty (non-TTY, no --password-stdin)', async () => {
      // promptPassword returns null (non-TTY)
      mockedPromptPassword.mockResolvedValue(null);

      await program.parseAsync(['node', 'cli', 'user', 'password']);

      expect(sdkMock.user.changePassword).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Current password is required');
      expect(process.exitCode).toBe(1);
    });

    it('should error when new password is empty', async () => {
      mockedPromptPassword
        .mockResolvedValueOnce('oldpass')
        .mockResolvedValueOnce(null); // new password prompt returns nothing

      await program.parseAsync(['node', 'cli', 'user', 'password']);

      expect(sdkMock.user.changePassword).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('New password is required');
      expect(process.exitCode).toBe(1);
    });

    it('should handle API errors gracefully', async () => {
      mockedPromptPassword
        .mockResolvedValueOnce('oldpass')
        .mockResolvedValueOnce('newpass');
      sdkMock.user.changePassword.mockRejectedValue(new Error('Wrong password'));

      await program.parseAsync(['node', 'cli', 'user', 'password']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Wrong password');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Email Change ─────────────────────────────────────────────────────

  describe('user email', () => {
    it('should request email change using interactive prompt', async () => {
      mockedPromptPassword.mockResolvedValueOnce('mypassword');
      sdkMock.user.requestEmailChange.mockResolvedValue({ message: 'Verification email sent' });

      await program.parseAsync(['node', 'cli', 'user', 'email', '--new', 'new@example.com']);

      expect(sdkMock.user.requestEmailChange).toHaveBeenCalledWith({
        newEmail: 'new@example.com',
        password: 'mypassword',
      });
    });

    it('should request email change using --password-stdin', async () => {
      mockedReadPasswordFromStdin.mockResolvedValueOnce('mypassword');
      sdkMock.user.requestEmailChange.mockResolvedValue({ message: 'Verification email sent' });

      await program.parseAsync(['node', 'cli', 'user', 'email', '--new', 'new@example.com', '--password-stdin']);

      expect(sdkMock.user.requestEmailChange).toHaveBeenCalledWith({
        newEmail: 'new@example.com',
        password: 'mypassword',
      });
    });

    it('should error when password is empty', async () => {
      mockedPromptPassword.mockResolvedValue(null);

      await program.parseAsync(['node', 'cli', 'user', 'email', '--new', 'new@example.com']);

      expect(sdkMock.user.requestEmailChange).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Password is required');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Account Deletion ─────────────────────────────────────────────────

  describe('user delete', () => {
    it('should request account deletion using interactive prompt', async () => {
      mockedPromptPassword.mockResolvedValueOnce('mypassword');
      sdkMock.user.requestAccountDeletion.mockResolvedValue({ message: 'Deletion scheduled', scheduledAt: '2026-03-01T00:00:00Z' });

      await program.parseAsync(['node', 'cli', 'user', 'delete', '--yes']);

      expect(sdkMock.user.requestAccountDeletion).toHaveBeenCalledWith({
        password: 'mypassword',
        reason: undefined,
        exportData: false,
      });
    });

    it('should request account deletion using --password-stdin', async () => {
      mockedReadPasswordFromStdin.mockResolvedValueOnce('mypassword');
      sdkMock.user.requestAccountDeletion.mockResolvedValue({ message: 'Deletion scheduled', scheduledAt: '2026-03-01T00:00:00Z' });

      await program.parseAsync(['node', 'cli', 'user', 'delete', '--yes', '--password-stdin', '--reason', 'No longer needed', '--export-data']);

      expect(sdkMock.user.requestAccountDeletion).toHaveBeenCalledWith({
        password: 'mypassword',
        reason: 'No longer needed',
        exportData: true,
      });
    });

    it('should error when password is empty', async () => {
      mockedPromptPassword.mockResolvedValue(null);

      await program.parseAsync(['node', 'cli', 'user', 'delete', '--yes']);

      expect(sdkMock.user.requestAccountDeletion).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Password is required');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Data Export ────────────────────────────────────────────────────

  describe('user export list', () => {
    it('should list data exports', async () => {
      sdkMock.user.listDataExports.mockResolvedValue([
        { id: 'exp1', status: 'completed', format: 'json', createdAt: '2026-02-01T10:00:00Z', completedAt: '2026-02-01T10:05:00Z' },
        { id: 'exp2', status: 'pending', format: 'json', createdAt: '2026-02-24T08:00:00Z', completedAt: null },
      ]);

      await program.parseAsync(['node', 'cli', 'user', 'export', 'list']);

      expect(sdkMock.user.listDataExports).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('exp1');
      expect(stdout).toContain('completed');
      expect(stdout).toContain('exp2');
      expect(stdout).toContain('pending');
    });

    it('should show message when no exports exist', async () => {
      sdkMock.user.listDataExports.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'user', 'export', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No data exports found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.user.listDataExports.mockRejectedValue(new Error('Unauthorized'));

      await program.parseAsync(['node', 'cli', 'user', 'export', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Unauthorized');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('user export download', () => {
    it('should write export to stdout when no --file flag and not a TTY', async () => {
      const content = '{"documents":[]}';
      const blob = new Blob([content], { type: 'application/json' });
      sdkMock.user.downloadDataExport.mockResolvedValue(blob);
      // Simulate piped/non-TTY stdout (safe to write binary)
      const origIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

      await program.parseAsync(['node', 'cli', 'user', 'export', 'download', 'exp1']);

      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      expect(sdkMock.user.downloadDataExport).toHaveBeenCalledWith('exp1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('{"documents":[]}');
    });

    it('should warn and exit when stdout is a TTY and no --file flag is given', async () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

      await program.parseAsync(['node', 'cli', 'user', 'export', 'download', 'exp1']);

      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
      expect(sdkMock.user.downloadDataExport).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('binary export data would corrupt your terminal');
      expect(process.exitCode).toBe(1);
    });

    it('should handle errors gracefully', async () => {
      sdkMock.user.downloadDataExport.mockRejectedValue(new Error('Export not ready'));
      // Simulate piped/non-TTY stdout so the download attempt actually runs
      const origIsTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

      await program.parseAsync(['node', 'cli', 'user', 'export', 'download', 'exp1']);

      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Export not ready');
      expect(process.exitCode).toBe(1);
    });
  });
});
