import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSyncCommands } from './sync.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    text: '',
    stream: process.stderr,
  })),
}));

// Mock sync config module
const mockConfigs: Array<Record<string, unknown>> = [];
vi.mock('../sync/config.js', () => ({
  loadSyncConfigs: vi.fn(() => mockConfigs),
  createSyncConfig: vi.fn((opts: Record<string, unknown>) => ({
    id: 'test-sync-id',
    vaultId: opts.vaultId,
    localPath: opts.localPath,
    mode: opts.mode ?? 'sync',
    onConflict: opts.onConflict ?? 'newer',
    ignore: opts.ignore ?? ['.git', '.DS_Store', 'node_modules'],
    lastSyncAt: '1970-01-01T00:00:00.000Z',
    autoSync: opts.autoSync ?? false,
  })),
  deleteSyncConfig: vi.fn((id: string) => {
    const idx = mockConfigs.findIndex(c => c.id === id);
    if (idx === -1) return false;
    mockConfigs.splice(idx, 1);
    return true;
  }),
}));

// Mock sync state module
vi.mock('../sync/state.js', () => ({
  deleteSyncState: vi.fn(() => true),
}));

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

import { createSyncConfig, deleteSyncConfig, loadSyncConfigs } from '../sync/config.js';
import { deleteSyncState } from '../sync/state.js';

describe('sync commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerSyncCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    mockConfigs.length = 0;
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
  });

  describe('sync init', () => {
    it('should initialize sync for a vault', async () => {
      sdkMock.vaults.get.mockResolvedValue({
        id: 'vault-1',
        name: 'My Vault',
        slug: 'my-vault',
      });

      await program.parseAsync(['node', 'cli', 'sync', 'init', 'vault-1', '/tmp/test-vault']);

      expect(sdkMock.vaults.get).toHaveBeenCalledWith('vault-1');
      expect(createSyncConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          vaultId: 'vault-1',
          mode: 'sync',
          onConflict: 'newer',
        }),
      );
    });

    it('should pass custom options', async () => {
      sdkMock.vaults.get.mockResolvedValue({
        id: 'vault-1',
        name: 'My Vault',
        slug: 'my-vault',
      });

      await program.parseAsync([
        'node', 'cli', 'sync', 'init', 'vault-1', '/tmp/test-vault',
        '--mode', 'pull',
        '--on-conflict', 'remote',
        '--auto-sync',
      ]);

      expect(createSyncConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'pull',
          onConflict: 'remote',
          autoSync: true,
        }),
      );
    });

    it('should handle vault not found error', async () => {
      sdkMock.vaults.get.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'sync', 'init', 'bad-vault', '/tmp/test']);

      expect(outputSpy.stderr.some(l => l.includes('Not found'))).toBe(true);
    });
  });

  describe('sync list', () => {
    it('should show empty message when no syncs configured', async () => {
      vi.mocked(loadSyncConfigs).mockReturnValue([]);

      await program.parseAsync(['node', 'cli', 'sync', 'list', '--output', 'text']);

      expect(outputSpy.stderr.some(l => l.includes('No sync configurations found'))).toBe(true);
    });

    it('should list configured syncs', async () => {
      vi.mocked(loadSyncConfigs).mockReturnValue([
        {
          id: 'sync-1',
          vaultId: 'vault-1',
          localPath: '/home/user/vault',
          mode: 'sync' as const,
          onConflict: 'newer' as const,
          ignore: [],
          lastSyncAt: '1970-01-01T00:00:00.000Z',
          autoSync: false,
        },
      ]);

      await program.parseAsync(['node', 'cli', 'sync', 'list']);

      expect(outputSpy.stdout.some(l => l.includes('sync-1'))).toBe(true);
      expect(outputSpy.stdout.some(l => l.includes('vault-1'))).toBe(true);
    });

    it('should output JSON when --output json', async () => {
      vi.mocked(loadSyncConfigs).mockReturnValue([
        {
          id: 'sync-1',
          vaultId: 'vault-1',
          localPath: '/home/user/vault',
          mode: 'sync' as const,
          onConflict: 'newer' as const,
          ignore: [],
          lastSyncAt: '2025-01-01T00:00:00.000Z',
          autoSync: true,
        },
      ]);

      await program.parseAsync(['node', 'cli', 'sync', 'list', '--output', 'json']);

      const jsonLine = outputSpy.stdout.find(l => l.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.id).toBe('sync-1');
    });
  });

  describe('sync delete', () => {
    it('should delete sync config and state', async () => {
      mockConfigs.push({ id: 'sync-1' });

      await program.parseAsync(['node', 'cli', 'sync', 'delete', 'sync-1']);

      expect(deleteSyncConfig).toHaveBeenCalledWith('sync-1');
      expect(deleteSyncState).toHaveBeenCalledWith('sync-1');
    });

    it('should report error when sync not found', async () => {
      vi.mocked(deleteSyncConfig).mockReturnValue(false);

      await program.parseAsync(['node', 'cli', 'sync', 'delete', 'nonexistent']);

      expect(process.exitCode).toBe(1);
    });
  });
});
