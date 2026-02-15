import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerAdminCommands } from './admin.js';
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

describe('admin commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAdminCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('admin stats', () => {
    it('should display system stats', async () => {
      sdkMock.admin.getStats.mockResolvedValue({
        totalUsers: 150,
        totalVaults: 300,
        totalDocuments: 5000,
        totalStorageBytes: 1073741824,
        activeUsers: 80,
      });

      await program.parseAsync(['node', 'cli', 'admin', 'stats']);

      expect(sdkMock.admin.getStats).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('150');
      expect(stdout).toContain('80');
      expect(stdout).toContain('300');
      expect(stdout).toContain('5000');
    });

    it('should handle stats errors', async () => {
      sdkMock.admin.getStats.mockRejectedValue(new Error('Admin access required'));

      await program.parseAsync(['node', 'cli', 'admin', 'stats']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Admin access required');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('admin stats timeseries', () => {
    it('should display timeseries data', async () => {
      sdkMock.admin.getTimeseries.mockResolvedValue({
        metric: 'signups',
        period: '30d',
        data: [
          { date: '2024-06-01', value: 5 },
          { date: '2024-06-02', value: 8 },
        ],
      });

      await program.parseAsync([
        'node', 'cli', 'admin', 'stats', 'timeseries',
        '--metric', 'signups',
        '--period', '30d',
      ]);

      expect(sdkMock.admin.getTimeseries).toHaveBeenCalledWith('signups', '30d');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('2024-06-01');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('signups');
    });

    it('should show message when no data points', async () => {
      sdkMock.admin.getTimeseries.mockResolvedValue({
        metric: 'signups',
        period: '7d',
        data: [],
      });

      await program.parseAsync([
        'node', 'cli', 'admin', 'stats', 'timeseries',
        '--metric', 'signups',
        '--period', '7d',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No data points found');
    });

    it('should handle timeseries errors', async () => {
      sdkMock.admin.getTimeseries.mockRejectedValue(new Error('Invalid metric'));

      await program.parseAsync([
        'node', 'cli', 'admin', 'stats', 'timeseries',
        '--metric', 'invalid',
        '--period', '30d',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Invalid metric');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('admin users list', () => {
    it('should list users', async () => {
      sdkMock.admin.listUsers.mockResolvedValue({
        users: [
          {
            id: 'u1',
            email: 'alice@example.com',
            name: 'Alice',
            role: 'user',
            isActive: true,
            subscriptionTier: 'pro',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1,
        page: 1,
        limit: 50,
      });

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'list']);

      expect(sdkMock.admin.listUsers).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('alice@example.com');
      expect(stdout).toContain('Alice');
    });

    it('should pass filter options', async () => {
      sdkMock.admin.listUsers.mockResolvedValue({
        users: [],
        total: 0,
        page: 2,
        limit: 10,
      });

      await program.parseAsync([
        'node', 'cli', 'admin', 'users', 'list',
        '--page', '2',
        '--limit', '10',
        '--search', 'alice',
        '--tier', 'pro',
      ]);

      expect(sdkMock.admin.listUsers).toHaveBeenCalledWith({
        page: 2,
        limit: 10,
        search: 'alice',
        tier: 'pro',
      });
    });

    it('should show message when no users found', async () => {
      sdkMock.admin.listUsers.mockResolvedValue({
        users: [],
        total: 0,
        page: 1,
        limit: 50,
      });

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No users found');
    });

    it('should handle errors', async () => {
      sdkMock.admin.listUsers.mockRejectedValue(new Error('Forbidden'));

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Forbidden');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('admin users get', () => {
    it('should display user details', async () => {
      sdkMock.admin.getUser.mockResolvedValue({
        id: 'u1',
        email: 'alice@example.com',
        name: 'Alice',
        role: 'admin',
        isActive: true,
        subscriptionTier: 'pro',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-06-01T00:00:00Z',
        vaultCount: 5,
        documentCount: 120,
        storageBytes: 10485760,
      });

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'get', 'u1']);

      expect(sdkMock.admin.getUser).toHaveBeenCalledWith('u1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('alice@example.com');
      expect(stdout).toContain('120');
    });

    it('should handle errors', async () => {
      sdkMock.admin.getUser.mockRejectedValue(new Error('User not found'));

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'get', 'nonexistent']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('User not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('admin users update', () => {
    it('should update user role', async () => {
      sdkMock.admin.updateUser.mockResolvedValue({
        id: 'u1',
        email: 'alice@example.com',
        name: 'Alice',
        role: 'admin',
        isActive: true,
        subscriptionTier: 'pro',
        createdAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'update', 'u1', '--role', 'admin']);

      expect(sdkMock.admin.updateUser).toHaveBeenCalledWith('u1', { role: 'admin' });
    });

    it('should update user to active', async () => {
      sdkMock.admin.updateUser.mockResolvedValue({
        id: 'u1',
        email: 'alice@example.com',
        name: 'Alice',
        role: 'user',
        isActive: true,
        subscriptionTier: 'free',
        createdAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'update', 'u1', '--active']);

      expect(sdkMock.admin.updateUser).toHaveBeenCalledWith('u1', { isActive: true });
    });

    it('should update user to inactive', async () => {
      sdkMock.admin.updateUser.mockResolvedValue({
        id: 'u1',
        email: 'alice@example.com',
        name: 'Alice',
        role: 'user',
        isActive: false,
        subscriptionTier: 'free',
        createdAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'update', 'u1', '--inactive']);

      expect(sdkMock.admin.updateUser).toHaveBeenCalledWith('u1', { isActive: false });
    });

    it('should show error when no updates specified', async () => {
      await program.parseAsync(['node', 'cli', 'admin', 'users', 'update', 'u1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No updates specified');
      expect(sdkMock.admin.updateUser).not.toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      sdkMock.admin.updateUser.mockRejectedValue(new Error('Cannot demote self'));

      await program.parseAsync(['node', 'cli', 'admin', 'users', 'update', 'u1', '--role', 'user']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Cannot demote self');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('admin activity', () => {
    it('should display recent activity', async () => {
      sdkMock.admin.getActivity.mockResolvedValue([
        {
          type: 'create',
          userId: 'u1',
          vaultId: 'v1',
          path: 'notes/hello.md',
          createdAt: '2024-06-01T12:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'admin', 'activity']);

      expect(sdkMock.admin.getActivity).toHaveBeenCalledWith(undefined);
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('create');
      expect(stdout).toContain('notes/hello.md');
    });

    it('should pass limit parameter', async () => {
      sdkMock.admin.getActivity.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'admin', 'activity', '--limit', '10']);

      expect(sdkMock.admin.getActivity).toHaveBeenCalledWith(10);
    });

    it('should show message when no activity', async () => {
      sdkMock.admin.getActivity.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'admin', 'activity']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No recent activity');
    });

    it('should handle errors', async () => {
      sdkMock.admin.getActivity.mockRejectedValue(new Error('Forbidden'));

      await program.parseAsync(['node', 'cli', 'admin', 'activity']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Forbidden');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('admin subscriptions', () => {
    it('should display subscription summary', async () => {
      sdkMock.admin.getSubscriptionSummary.mockResolvedValue({
        free: 100,
        pro: 40,
        business: 10,
        total: 150,
      });

      await program.parseAsync(['node', 'cli', 'admin', 'subscriptions']);

      expect(sdkMock.admin.getSubscriptionSummary).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('100');
      expect(stdout).toContain('40');
      expect(stdout).toContain('10');
      expect(stdout).toContain('150');
    });

    it('should handle errors', async () => {
      sdkMock.admin.getSubscriptionSummary.mockRejectedValue(new Error('Forbidden'));

      await program.parseAsync(['node', 'cli', 'admin', 'subscriptions']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Forbidden');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('admin health', () => {
    it('should display system health', async () => {
      sdkMock.admin.getHealth.mockResolvedValue({
        status: 'healthy',
        database: 'connected',
        redis: 'connected',
        uptime: 86400,
      });

      await program.parseAsync(['node', 'cli', 'admin', 'health']);

      expect(sdkMock.admin.getHealth).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('healthy');
      expect(stdout).toContain('connected');
      expect(stdout).toContain('1d');
    });

    it('should handle degraded health', async () => {
      sdkMock.admin.getHealth.mockResolvedValue({
        status: 'degraded',
        database: 'connected',
        redis: 'disconnected',
        uptime: 3600,
      });

      await program.parseAsync(['node', 'cli', 'admin', 'health']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('degraded');
      expect(stdout).toContain('disconnected');
    });

    it('should handle errors', async () => {
      sdkMock.admin.getHealth.mockRejectedValue(new Error('Forbidden'));

      await program.parseAsync(['node', 'cli', 'admin', 'health']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Forbidden');
      expect(process.exitCode).toBe(1);
    });
  });
});
