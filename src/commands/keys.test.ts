import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerKeyCommands } from './keys.js';
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
  getClientAsync: vi.fn(async () => sdkMock),
}));

describe('keys commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerKeyCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('keys list', () => {
    it('should list API keys with details', async () => {
      sdkMock.apiKeys.list.mockResolvedValue([
        {
          id: 'k1', name: 'Test Key', prefix: 'lsv_k_ab', scopes: ['read', 'write'],
          vaultId: null, expiresAt: null, isActive: true, lastUsedAt: null,
          createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        {
          id: 'k2', name: 'Expired Key', prefix: 'lsv_k_cd', scopes: ['read'],
          vaultId: 'v1', expiresAt: '2024-06-01T00:00:00Z', isActive: false, lastUsedAt: '2024-05-01T00:00:00Z',
          createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'keys', 'list']);

      expect(sdkMock.apiKeys.list).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Test Key');
      expect(stdout).toContain('lsv_k_ab');
      expect(stdout).toContain('read, write');
      expect(stdout).toContain('Expired Key');
    });

    it('should show message when no keys exist', async () => {
      sdkMock.apiKeys.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'keys', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No API keys found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.apiKeys.list.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'keys', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('keys get', () => {
    it('should display API key details', async () => {
      sdkMock.apiKeys.get.mockResolvedValue({
        id: 'k1', name: 'Production Key', prefix: 'lsv_k_ab', scopes: ['read', 'write'],
        vaultId: 'v1', expiresAt: '2025-12-31T00:00:00Z', isActive: true,
        lastUsedAt: '2024-06-15T12:00:00Z', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'keys', 'get', 'k1']);

      expect(sdkMock.apiKeys.get).toHaveBeenCalledWith('k1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Production Key');
      expect(stdout).toContain('k1');
      expect(stdout).toContain('lsv_k_ab');
      expect(stdout).toContain('read, write');
      expect(stdout).toContain('v1');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.apiKeys.get.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'keys', 'get', 'k1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('keys create', () => {
    it('should create an API key with default scopes', async () => {
      sdkMock.apiKeys.create.mockResolvedValue({
        id: 'k1', name: 'New Key', prefix: 'lsv_k_ab', scopes: ['read', 'write'],
        vaultId: null, expiresAt: null, isActive: true, lastUsedAt: null,
        createdAt: '2024-01-01', updatedAt: '2024-01-01',
        key: 'lsv_k_ab12cd34_full_secret',
      });

      await program.parseAsync(['node', 'cli', 'keys', 'create', 'New Key']);

      expect(sdkMock.apiKeys.create).toHaveBeenCalledWith({
        name: 'New Key',
        scopes: ['read', 'write'],
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('lsv_k_ab12cd34_full_secret');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('IMPORTANT');
    });

    it('should create an API key with custom options', async () => {
      sdkMock.apiKeys.create.mockResolvedValue({
        id: 'k2', name: 'Scoped Key', prefix: 'lsv_k_ef', scopes: ['read'],
        vaultId: 'v1', expiresAt: '2027-01-01T00:00:00Z', isActive: true, lastUsedAt: null,
        createdAt: '2024-01-01', updatedAt: '2024-01-01',
        key: 'lsv_k_ef56gh78_secret',
      });

      await program.parseAsync([
        'node', 'cli', 'keys', 'create', 'Scoped Key',
        '--scopes', 'read',
        '--vault', 'v1',
        '--expires', '2027-01-01T00:00:00Z',
      ]);

      expect(sdkMock.apiKeys.create).toHaveBeenCalledWith({
        name: 'Scoped Key',
        scopes: ['read'],
        vaultId: 'v1',
        expiresAt: '2027-01-01T00:00:00Z',
      });
    });

    it('should handle creation errors', async () => {
      sdkMock.apiKeys.create.mockRejectedValue(new Error('Invalid scopes'));

      await program.parseAsync(['node', 'cli', 'keys', 'create', 'Bad Key']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Invalid scopes');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('keys update', () => {
    it('should update API key name', async () => {
      sdkMock.apiKeys.update.mockResolvedValue({
        id: 'k1', name: 'Renamed', prefix: 'lsv_k_ab', scopes: ['read'],
        vaultId: null, expiresAt: null, isActive: true, lastUsedAt: null,
        createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync(['node', 'cli', 'keys', 'update', 'k1', '--name', 'Renamed']);

      expect(sdkMock.apiKeys.update).toHaveBeenCalledWith('k1', { name: 'Renamed' });
    });

    it('should deactivate an API key', async () => {
      sdkMock.apiKeys.update.mockResolvedValue({
        id: 'k1', name: 'My Key', prefix: 'lsv_k_ab', scopes: ['read'],
        vaultId: null, expiresAt: null, isActive: false, lastUsedAt: null,
        createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync(['node', 'cli', 'keys', 'update', 'k1', '--inactive']);

      expect(sdkMock.apiKeys.update).toHaveBeenCalledWith('k1', { isActive: false });
    });

    it('should activate an API key', async () => {
      sdkMock.apiKeys.update.mockResolvedValue({
        id: 'k1', name: 'My Key', prefix: 'lsv_k_ab', scopes: ['read'],
        vaultId: null, expiresAt: null, isActive: true, lastUsedAt: null,
        createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync(['node', 'cli', 'keys', 'update', 'k1', '--active']);

      expect(sdkMock.apiKeys.update).toHaveBeenCalledWith('k1', { isActive: true });
    });

    it('should show error when no update options provided', async () => {
      await program.parseAsync(['node', 'cli', 'keys', 'update', 'k1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Must specify at least one update option');
      expect(sdkMock.apiKeys.update).not.toHaveBeenCalled();
    });

    it('should handle update errors', async () => {
      sdkMock.apiKeys.update.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'keys', 'update', 'k1', '--name', 'X']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('keys revoke', () => {
    it('should revoke an API key', async () => {
      sdkMock.apiKeys.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'keys', 'revoke', 'k1']);

      expect(sdkMock.apiKeys.delete).toHaveBeenCalledWith('k1');
    });

    it('should handle revoke errors', async () => {
      sdkMock.apiKeys.delete.mockRejectedValue(new Error('Key not found'));

      await program.parseAsync(['node', 'cli', 'keys', 'revoke', 'k1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Key not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
