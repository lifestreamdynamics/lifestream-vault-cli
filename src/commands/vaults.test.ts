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

// Mock getClientAsync to return our SDK mock
let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

// Mock credential manager for encryption tests
vi.mock('../config.js', () => ({
  getCredentialManager: vi.fn(() => ({
    saveVaultKey: vi.fn(async () => {}),
    getVaultKey: vi.fn(async () => null),
  })),
  loadConfigAsync: vi.fn(async () => ({ apiUrl: 'https://test.example.com', apiKey: 'lsv_k_test' })),
  DEFAULT_API_URL: 'https://vault.lifestreamdynamics.com',
}));

// Mock SDK generateVaultKey
vi.mock('@lifestreamdynamics/vault-sdk', () => ({
  generateVaultKey: vi.fn(() => 'a'.repeat(64)),
}));

// Resolve vault IDs as-is in tests (no network slug lookup)
vi.mock('../utils/resolve-vault.js', () => ({
  resolveVaultId: vi.fn(async (id: string) => id),
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
      // Vaults with null description render without a description suffix
      expect(stdout).toContain('Work');
      expect(stdout).not.toContain('No description');
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

  describe('vaults tree', () => {
    it('should show full tree without --depth', async () => {
      sdkMock.vaults.getTree.mockResolvedValue([
        {
          name: 'folder', type: 'directory', path: 'folder', children: [
            { name: 'doc.md', type: 'file', path: 'folder/doc.md' },
          ],
        },
      ]);

      await program.parseAsync(['node', 'cli', 'vaults', 'tree', 'vault-1']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('folder');
      expect(stdout).toContain('doc.md');
    });

    it('should limit tree depth with --depth 0', async () => {
      sdkMock.vaults.getTree.mockResolvedValue([
        {
          name: 'folder', type: 'directory', path: 'folder', children: [
            { name: 'doc.md', type: 'file', path: 'folder/doc.md' },
          ],
        },
      ]);

      await program.parseAsync(['node', 'cli', 'vaults', 'tree', 'vault-1', '--depth', '0']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('folder');
      expect(stdout).not.toContain('doc.md');
    });

    it('should limit tree depth with --depth 1', async () => {
      sdkMock.vaults.getTree.mockResolvedValue([
        {
          name: 'folder', type: 'directory', path: 'folder', children: [
            {
              name: 'sub', type: 'directory', path: 'folder/sub', children: [
                { name: 'deep.md', type: 'file', path: 'folder/sub/deep.md' },
              ],
            },
          ],
        },
      ]);

      await program.parseAsync(['node', 'cli', 'vaults', 'tree', 'vault-1', '--depth', '1']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('folder');
      expect(stdout).toContain('sub');
      expect(stdout).not.toContain('deep.md');
    });

    it('should output tree as JSON with --output json', async () => {
      const treeData = [{ name: 'doc.md', type: 'file', path: 'doc.md' }];
      sdkMock.vaults.getTree.mockResolvedValue(treeData);

      await program.parseAsync(['node', 'cli', 'vaults', 'tree', 'vault-1', '--output', 'json']);

      const stdout = outputSpy.stdout.join('');
      const parsed = JSON.parse(stdout) as unknown[];
      expect(parsed).toHaveLength(1);
    });

    it('should handle errors gracefully', async () => {
      sdkMock.vaults.getTree.mockRejectedValue(new Error('Vault not found'));

      await program.parseAsync(['node', 'cli', 'vaults', 'tree', 'vault-1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Vault not found');
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
