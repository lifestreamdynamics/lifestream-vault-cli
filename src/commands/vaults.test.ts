import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerVaultCommands } from './vaults.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';

// Mock ora to avoid terminal spinner issues in tests
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

// Mock getClient to return our SDK mock
let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClient: vi.fn(() => sdkMock),
}));

// Mock credential manager for encryption tests
vi.mock('../lib/credential-manager.js', () => ({
  createCredentialManager: vi.fn(() => ({
    saveVaultKey: vi.fn(async () => {}),
    getVaultKey: vi.fn(async () => null),
  })),
}));

// Mock SDK generateVaultKey
vi.mock('@lifestreamdynamics/vault-sdk', () => ({
  generateVaultKey: vi.fn(() => 'a'.repeat(64)),
}));

describe('vaults commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerVaultCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('vaults list', () => {
    it('should list vaults with name, slug, and description', async () => {
      sdkMock.vaults.list.mockResolvedValue([
        { id: 'v1', name: 'My Notes', slug: 'my-notes', description: 'Personal notes', encryptionEnabled: false, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 'v2', name: 'Work', slug: 'work', description: null, encryptionEnabled: false, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      await program.parseAsync(['node', 'cli', 'vaults', 'list']);

      expect(sdkMock.vaults.list).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('My Notes');
      expect(stdout).toContain('my-notes');
      expect(stdout).toContain('Personal notes');
      expect(stdout).toContain('No description');
    });

    it('should show message when no vaults exist', async () => {
      sdkMock.vaults.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'vaults', 'list']);

      // Empty message goes to stderr via status()
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No vaults found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.vaults.list.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'vaults', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('vaults get', () => {
    it('should display vault details', async () => {
      sdkMock.vaults.get.mockResolvedValue({
        id: 'v1',
        name: 'My Notes',
        slug: 'my-notes',
        description: 'Personal notes vault',
        encryptionEnabled: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-06-15T12:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'vaults', 'get', 'v1']);

      expect(sdkMock.vaults.get).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('My Notes');
      expect(stdout).toContain('my-notes');
      expect(stdout).toContain('v1');
      expect(stdout).toContain('Personal notes vault');
    });

    it('should handle missing description', async () => {
      sdkMock.vaults.get.mockResolvedValue({
        id: 'v1',
        name: 'Empty',
        slug: 'empty',
        description: null,
        encryptionEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'vaults', 'get', 'v1']);

      // "none" is rendered via chalk.dim for null values
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('none');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.vaults.get.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'vaults', 'get', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('vaults create', () => {
    it('should create a vault with name only', async () => {
      sdkMock.vaults.create.mockResolvedValue({
        id: 'v1',
        name: 'New Vault',
        slug: 'new-vault',
        description: null,
        encryptionEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'vaults', 'create', 'New Vault']);

      expect(sdkMock.vaults.create).toHaveBeenCalledWith({
        name: 'New Vault',
        description: undefined,
        encryptionEnabled: false,
      });
    });

    it('should create a vault with name and description', async () => {
      sdkMock.vaults.create.mockResolvedValue({
        id: 'v1',
        name: 'Work Notes',
        slug: 'work-notes',
        description: 'My work notes',
        encryptionEnabled: false,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'vaults', 'create', 'Work Notes', '-d', 'My work notes']);

      expect(sdkMock.vaults.create).toHaveBeenCalledWith({
        name: 'Work Notes',
        description: 'My work notes',
        encryptionEnabled: false,
      });
    });

    it('should handle creation errors', async () => {
      sdkMock.vaults.create.mockRejectedValue(new Error('Duplicate name'));

      await program.parseAsync(['node', 'cli', 'vaults', 'create', 'Existing']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Duplicate name');
      expect(process.exitCode).toBe(1);
    });
  });
});
