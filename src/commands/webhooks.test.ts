import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerWebhookCommands } from './webhooks.js';
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

describe('webhooks commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerWebhookCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('webhooks list', () => {
    it('should list webhooks with details', async () => {
      sdkMock.webhooks.list.mockResolvedValue([
        {
          id: 'wh1', vaultId: 'v1', url: 'https://example.com/hook',
          events: ['create', 'update'], isActive: true,
          createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        {
          id: 'wh2', vaultId: 'v1', url: 'https://other.com/webhook',
          events: ['delete'], isActive: false,
          createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'webhooks', 'list', 'v1']);

      expect(sdkMock.webhooks.list).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('https://example.com/hook');
      expect(stdout).toContain('create, update');
      expect(stdout).toContain('https://other.com/webhook');
    });

    it('should show message when no webhooks exist', async () => {
      sdkMock.webhooks.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'webhooks', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No webhooks found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.webhooks.list.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'webhooks', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('webhooks create', () => {
    it('should create a webhook with default events', async () => {
      sdkMock.webhooks.create.mockResolvedValue({
        id: 'wh1', vaultId: 'v1', url: 'https://example.com/hook',
        events: ['create', 'update', 'delete'], isActive: true,
        createdAt: '2024-01-01', updatedAt: '2024-01-01',
        secret: 'whsec_abc123',
      });

      await program.parseAsync(['node', 'cli', 'webhooks', 'create', 'v1', 'https://example.com/hook']);

      expect(sdkMock.webhooks.create).toHaveBeenCalledWith('v1', {
        url: 'https://example.com/hook',
        events: ['create', 'update', 'delete'],
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('whsec_abc123');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('IMPORTANT');
    });

    it('should create a webhook with custom events', async () => {
      sdkMock.webhooks.create.mockResolvedValue({
        id: 'wh2', vaultId: 'v1', url: 'https://example.com/hook',
        events: ['create'], isActive: true,
        createdAt: '2024-01-01', updatedAt: '2024-01-01',
        secret: 'whsec_def456',
      });

      await program.parseAsync([
        'node', 'cli', 'webhooks', 'create', 'v1', 'https://example.com/hook',
        '--events', 'create',
      ]);

      expect(sdkMock.webhooks.create).toHaveBeenCalledWith('v1', {
        url: 'https://example.com/hook',
        events: ['create'],
      });
    });

    it('should handle creation errors', async () => {
      sdkMock.webhooks.create.mockRejectedValue(new Error('URL not allowed'));

      await program.parseAsync(['node', 'cli', 'webhooks', 'create', 'v1', 'http://localhost']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('URL not allowed');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('webhooks update', () => {
    it('should update webhook URL', async () => {
      sdkMock.webhooks.update.mockResolvedValue({
        id: 'wh1', vaultId: 'v1', url: 'https://new.example.com/hook',
        events: ['create', 'update'], isActive: true,
        createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync([
        'node', 'cli', 'webhooks', 'update', 'v1', 'wh1',
        '--url', 'https://new.example.com/hook',
      ]);

      expect(sdkMock.webhooks.update).toHaveBeenCalledWith('v1', 'wh1', {
        url: 'https://new.example.com/hook',
      });
    });

    it('should update webhook events', async () => {
      sdkMock.webhooks.update.mockResolvedValue({
        id: 'wh1', vaultId: 'v1', url: 'https://example.com/hook',
        events: ['create', 'delete'], isActive: true,
        createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync([
        'node', 'cli', 'webhooks', 'update', 'v1', 'wh1',
        '--events', 'create,delete',
      ]);

      expect(sdkMock.webhooks.update).toHaveBeenCalledWith('v1', 'wh1', {
        events: ['create', 'delete'],
      });
    });

    it('should deactivate a webhook', async () => {
      sdkMock.webhooks.update.mockResolvedValue({
        id: 'wh1', vaultId: 'v1', url: 'https://example.com/hook',
        events: ['create'], isActive: false,
        createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync(['node', 'cli', 'webhooks', 'update', 'v1', 'wh1', '--inactive']);

      expect(sdkMock.webhooks.update).toHaveBeenCalledWith('v1', 'wh1', { isActive: false });
    });

    it('should activate a webhook', async () => {
      sdkMock.webhooks.update.mockResolvedValue({
        id: 'wh1', vaultId: 'v1', url: 'https://example.com/hook',
        events: ['create'], isActive: true,
        createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync(['node', 'cli', 'webhooks', 'update', 'v1', 'wh1', '--active']);

      expect(sdkMock.webhooks.update).toHaveBeenCalledWith('v1', 'wh1', { isActive: true });
    });

    it('should show error when no update options provided', async () => {
      await program.parseAsync(['node', 'cli', 'webhooks', 'update', 'v1', 'wh1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Must specify at least one update option');
      expect(sdkMock.webhooks.update).not.toHaveBeenCalled();
    });

    it('should handle update errors', async () => {
      sdkMock.webhooks.update.mockRejectedValue(new Error('Webhook not found'));

      await program.parseAsync([
        'node', 'cli', 'webhooks', 'update', 'v1', 'wh1',
        '--url', 'https://x.com',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Webhook not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('webhooks delete', () => {
    it('should delete a webhook', async () => {
      sdkMock.webhooks.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'webhooks', 'delete', 'v1', 'wh1']);

      expect(sdkMock.webhooks.delete).toHaveBeenCalledWith('v1', 'wh1');
    });

    it('should handle delete errors', async () => {
      sdkMock.webhooks.delete.mockRejectedValue(new Error('Webhook not found'));

      await program.parseAsync(['node', 'cli', 'webhooks', 'delete', 'v1', 'wh1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Webhook not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('webhooks deliveries', () => {
    it('should list deliveries with details', async () => {
      sdkMock.webhooks.listDeliveries.mockResolvedValue([
        {
          id: 'd1', webhookId: 'wh1', eventId: 'ev1', statusCode: 200,
          attempt: 1, requestBody: { event: 'document.create' },
          responseBody: 'OK', error: null,
          deliveredAt: '2024-01-01T12:00:00Z', createdAt: '2024-01-01T12:00:00Z',
        },
        {
          id: 'd2', webhookId: 'wh1', eventId: 'ev2', statusCode: null,
          attempt: 3, requestBody: { event: 'document.update' },
          responseBody: null, error: 'Connection refused',
          deliveredAt: null, createdAt: '2024-01-02T12:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'webhooks', 'deliveries', 'v1', 'wh1']);

      expect(sdkMock.webhooks.listDeliveries).toHaveBeenCalledWith('v1', 'wh1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('200');
      expect(stdout).toContain('attempt 1');
      expect(stdout).toContain('FAILED');
      expect(stdout).toContain('Connection refused');
    });

    it('should show message when no deliveries exist', async () => {
      sdkMock.webhooks.listDeliveries.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'webhooks', 'deliveries', 'v1', 'wh1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No deliveries found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.webhooks.listDeliveries.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'webhooks', 'deliveries', 'v1', 'wh1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
