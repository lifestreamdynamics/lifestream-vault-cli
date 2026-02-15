import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerConnectorCommands } from './connectors.js';
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

describe('connectors commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  const mockConnector = {
    id: 'c1',
    userId: 'u1',
    vaultId: 'v1',
    provider: 'google_drive',
    name: 'My Drive',
    config: {},
    syncDirection: 'bidirectional',
    syncPath: null,
    lastSyncAt: null,
    status: 'active',
    isActive: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerConnectorCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  // ── List ──────────────────────────────────────────────────────────

  describe('connectors list', () => {
    it('should list connectors', async () => {
      sdkMock.connectors.list.mockResolvedValue([mockConnector]);

      await program.parseAsync(['node', 'cli', 'connectors', 'list']);

      expect(sdkMock.connectors.list).toHaveBeenCalledWith(undefined);
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('My Drive');
      expect(stdout).toContain('google_drive');
    });

    it('should filter by vault', async () => {
      sdkMock.connectors.list.mockResolvedValue([mockConnector]);

      await program.parseAsync(['node', 'cli', 'connectors', 'list', '--vault', 'v1']);

      expect(sdkMock.connectors.list).toHaveBeenCalledWith('v1');
    });

    it('should show message when no connectors exist', async () => {
      sdkMock.connectors.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'connectors', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No connectors found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.connectors.list.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'connectors', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Get ───────────────────────────────────────────────────────────

  describe('connectors get', () => {
    it('should display connector details', async () => {
      sdkMock.connectors.get.mockResolvedValue(mockConnector);

      await program.parseAsync(['node', 'cli', 'connectors', 'get', 'c1']);

      expect(sdkMock.connectors.get).toHaveBeenCalledWith('c1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('My Drive');
      expect(stdout).toContain('google_drive');
      expect(stdout).toContain('bidirectional');
    });

    it('should handle missing sync path', async () => {
      sdkMock.connectors.get.mockResolvedValue(mockConnector);

      await program.parseAsync(['node', 'cli', 'connectors', 'get', 'c1']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('none');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.connectors.get.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'connectors', 'get', 'c1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Create ────────────────────────────────────────────────────────

  describe('connectors create', () => {
    it('should create a connector', async () => {
      sdkMock.connectors.create.mockResolvedValue(mockConnector);

      await program.parseAsync(['node', 'cli', 'connectors', 'create', 'google_drive', 'My Drive', '--vault', 'v1', '--direction', 'bidirectional']);

      expect(sdkMock.connectors.create).toHaveBeenCalledWith({
        provider: 'google_drive',
        name: 'My Drive',
        vaultId: 'v1',
        syncDirection: 'bidirectional',
        syncPath: undefined,
      });
    });

    it('should create a connector with sync path', async () => {
      sdkMock.connectors.create.mockResolvedValue({ ...mockConnector, syncPath: '/docs' });

      await program.parseAsync(['node', 'cli', 'connectors', 'create', 'google_drive', 'My Drive', '--vault', 'v1', '--direction', 'pull', '--sync-path', '/docs']);

      expect(sdkMock.connectors.create).toHaveBeenCalledWith({
        provider: 'google_drive',
        name: 'My Drive',
        vaultId: 'v1',
        syncDirection: 'pull',
        syncPath: '/docs',
      });
    });

    it('should handle creation errors', async () => {
      sdkMock.connectors.create.mockRejectedValue(new Error('Validation failed'));

      await program.parseAsync(['node', 'cli', 'connectors', 'create', 'google_drive', 'Bad', '--vault', 'v1', '--direction', 'pull']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Validation failed');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Update ────────────────────────────────────────────────────────

  describe('connectors update', () => {
    it('should update connector name', async () => {
      sdkMock.connectors.update.mockResolvedValue({ ...mockConnector, name: 'Renamed' });

      await program.parseAsync(['node', 'cli', 'connectors', 'update', 'c1', '--name', 'Renamed']);

      expect(sdkMock.connectors.update).toHaveBeenCalledWith('c1', { name: 'Renamed' });
    });

    it('should update connector direction', async () => {
      sdkMock.connectors.update.mockResolvedValue({ ...mockConnector, syncDirection: 'push' });

      await program.parseAsync(['node', 'cli', 'connectors', 'update', 'c1', '--direction', 'push']);

      expect(sdkMock.connectors.update).toHaveBeenCalledWith('c1', { syncDirection: 'push' });
    });

    it('should handle update errors', async () => {
      sdkMock.connectors.update.mockRejectedValue(new Error('Forbidden'));

      await program.parseAsync(['node', 'cli', 'connectors', 'update', 'c1', '--name', 'X']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Forbidden');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Delete ────────────────────────────────────────────────────────

  describe('connectors delete', () => {
    it('should delete a connector', async () => {
      sdkMock.connectors.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'connectors', 'delete', 'c1']);

      expect(sdkMock.connectors.delete).toHaveBeenCalledWith('c1');
    });

    it('should handle deletion errors', async () => {
      sdkMock.connectors.delete.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'connectors', 'delete', 'c1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Test ──────────────────────────────────────────────────────────

  describe('connectors test', () => {
    it('should test connection successfully', async () => {
      sdkMock.connectors.test.mockResolvedValue({ success: true });

      await program.parseAsync(['node', 'cli', 'connectors', 'test', 'c1']);

      expect(sdkMock.connectors.test).toHaveBeenCalledWith('c1');
    });

    it('should display failure message', async () => {
      sdkMock.connectors.test.mockResolvedValue({ success: false, error: 'Bad credentials' });

      await program.parseAsync(['node', 'cli', 'connectors', 'test', 'c1']);

      expect(sdkMock.connectors.test).toHaveBeenCalledWith('c1');
    });

    it('should handle test errors', async () => {
      sdkMock.connectors.test.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'connectors', 'test', 'c1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Sync ──────────────────────────────────────────────────────────

  describe('connectors sync', () => {
    it('should trigger sync successfully', async () => {
      sdkMock.connectors.sync.mockResolvedValue({ message: 'Sync triggered successfully' });

      await program.parseAsync(['node', 'cli', 'connectors', 'sync', 'c1']);

      expect(sdkMock.connectors.sync).toHaveBeenCalledWith('c1');
    });

    it('should handle sync errors', async () => {
      sdkMock.connectors.sync.mockRejectedValue(new Error('Inactive connector'));

      await program.parseAsync(['node', 'cli', 'connectors', 'sync', 'c1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Inactive connector');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Logs ──────────────────────────────────────────────────────────

  describe('connectors logs', () => {
    it('should display sync logs', async () => {
      sdkMock.connectors.logs.mockResolvedValue([
        {
          id: 'log1',
          connectorId: 'c1',
          status: 'success',
          filesAdded: 5,
          filesUpdated: 2,
          filesDeleted: 0,
          errors: null,
          durationMs: 1234,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'connectors', 'logs', 'c1']);

      expect(sdkMock.connectors.logs).toHaveBeenCalledWith('c1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('success');
      expect(stdout).toContain('+5');
      expect(stdout).toContain('1234ms');
    });

    it('should show message when no logs exist', async () => {
      sdkMock.connectors.logs.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'connectors', 'logs', 'c1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No sync logs found');
    });

    it('should handle logs errors', async () => {
      sdkMock.connectors.logs.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'connectors', 'logs', 'c1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
