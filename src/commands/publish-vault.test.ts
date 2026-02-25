import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerPublishVaultCommands } from './publish-vault.js';
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

describe('publish-vault commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerPublishVaultCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('publish-vault list', () => {
    it('should list published vault sites', async () => {
      sdkMock.publishVault.listMine.mockResolvedValue([
        {
          id: 'pv-1',
          vaultId: 'v1',
          slug: 'my-docs',
          title: 'My Documentation',
          description: 'A documentation site',
          showSidebar: true,
          enableSearch: true,
          isPublished: true,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'pv-2',
          vaultId: 'v2',
          slug: 'draft-site',
          title: 'Draft Site',
          description: null,
          showSidebar: false,
          enableSearch: false,
          isPublished: false,
          createdAt: '2024-02-01T00:00:00Z',
          updatedAt: '2024-02-01T00:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'publish-vault', 'list']);

      expect(sdkMock.publishVault.listMine).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('my-docs');
      expect(stdout).toContain('My Documentation');
      expect(stdout).toContain('draft-site');
      expect(stdout).toContain('Draft Site');
    });

    it('should show message when no published vault sites exist', async () => {
      sdkMock.publishVault.listMine.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'publish-vault', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No published vault sites found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.publishVault.listMine.mockRejectedValue(new Error('Service unavailable'));

      await program.parseAsync(['node', 'cli', 'publish-vault', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Service unavailable');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('publish-vault publish', () => {
    it('should publish a vault site with required options', async () => {
      sdkMock.publishVault.publish.mockResolvedValue({
        id: 'pv-3',
        vaultId: 'v3',
        slug: 'my-new-site',
        title: 'My New Site',
        description: null,
        showSidebar: false,
        enableSearch: false,
        isPublished: true,
        createdAt: '2024-03-01T00:00:00Z',
        updatedAt: '2024-03-01T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'publish-vault', 'publish', 'v3',
        '--slug', 'my-new-site',
        '--title', 'My New Site',
      ]);

      expect(sdkMock.publishVault.publish).toHaveBeenCalledWith('v3', {
        slug: 'my-new-site',
        title: 'My New Site',
        description: undefined,
        showSidebar: false,
        enableSearch: false,
        theme: undefined,
        customDomainId: undefined,
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('my-new-site');
    });

    it('should handle publish errors gracefully', async () => {
      sdkMock.publishVault.publish.mockRejectedValue(new Error('Slug already taken'));

      await program.parseAsync([
        'node', 'cli', 'publish-vault', 'publish', 'v3',
        '--slug', 'taken-slug',
        '--title', 'My Site',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Slug already taken');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('publish-vault unpublish', () => {
    it('should unpublish a vault site', async () => {
      sdkMock.publishVault.unpublish.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'publish-vault', 'unpublish', 'v1']);

      expect(sdkMock.publishVault.unpublish).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      const stderr = outputSpy.stderr.join('');
      const combined = stdout + stderr;
      // out.success('Vault unpublished', { vaultId }) outputs message + data
      expect(combined).toContain('Vault unpublished');
      expect(combined).toContain('v1');
    });

    it('should handle unpublish errors gracefully', async () => {
      sdkMock.publishVault.unpublish.mockRejectedValue(new Error('Published vault not found'));

      await program.parseAsync(['node', 'cli', 'publish-vault', 'unpublish', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Published vault not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
