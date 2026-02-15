import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerHookCommands } from './hooks.js';
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

describe('hooks commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerHookCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('hooks list', () => {
    it('should list hooks with details', async () => {
      sdkMock.hooks.list.mockResolvedValue([
        {
          id: 'h1', vaultId: 'v1', name: 'Auto-tag', triggerEvent: 'document.create',
          triggerFilter: null, actionType: 'auto-tag', actionConfig: { tags: ['new'] },
          isActive: true, createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        {
          id: 'h2', vaultId: 'v1', name: 'Template', triggerEvent: 'document.create',
          triggerFilter: null, actionType: 'template', actionConfig: { template: 'default' },
          isActive: false, createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'hooks', 'list', 'v1']);

      expect(sdkMock.hooks.list).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Auto-tag');
      expect(stdout).toContain('document.create');
      expect(stdout).toContain('auto-tag');
      expect(stdout).toContain('Template');
    });

    it('should show message when no hooks exist', async () => {
      sdkMock.hooks.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'hooks', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No hooks found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.hooks.list.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'hooks', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('hooks create', () => {
    it('should create a hook with all params', async () => {
      sdkMock.hooks.create.mockResolvedValue({
        id: 'h1', vaultId: 'v1', name: 'My Hook', triggerEvent: 'document.create',
        triggerFilter: null, actionType: 'auto-tag', actionConfig: { tags: ['new'] },
        isActive: true, createdAt: '2024-01-01', updatedAt: '2024-01-01',
      });

      await program.parseAsync([
        'node', 'cli', 'hooks', 'create', 'v1', 'My Hook',
        '--trigger', 'document.create',
        '--action', 'auto-tag',
        '--config', '{"tags":["new"]}',
      ]);

      expect(sdkMock.hooks.create).toHaveBeenCalledWith('v1', {
        name: 'My Hook',
        triggerEvent: 'document.create',
        actionType: 'auto-tag',
        actionConfig: { tags: ['new'] },
      });
      // success() outputs to stderr (succeedSpinner) in text mode
      const output = outputSpy.stdout.join('') + outputSpy.stderr.join('');
      expect(output).toContain('h1');
    });

    it('should create a hook with a trigger filter', async () => {
      sdkMock.hooks.create.mockResolvedValue({
        id: 'h2', vaultId: 'v1', name: 'Filtered', triggerEvent: 'document.create',
        triggerFilter: { path: '*.md' }, actionType: 'template', actionConfig: { template: 'daily' },
        isActive: true, createdAt: '2024-01-01', updatedAt: '2024-01-01',
      });

      await program.parseAsync([
        'node', 'cli', 'hooks', 'create', 'v1', 'Filtered',
        '--trigger', 'document.create',
        '--action', 'template',
        '--config', '{"template":"daily"}',
        '--filter', '{"path":"*.md"}',
      ]);

      expect(sdkMock.hooks.create).toHaveBeenCalledWith('v1', {
        name: 'Filtered',
        triggerEvent: 'document.create',
        actionType: 'template',
        actionConfig: { template: 'daily' },
        triggerFilter: { path: '*.md' },
      });
    });

    it('should show error for invalid JSON config', async () => {
      await program.parseAsync([
        'node', 'cli', 'hooks', 'create', 'v1', 'Bad',
        '--trigger', 'document.create',
        '--action', 'auto-tag',
        '--config', 'not-json',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('--config must be valid JSON');
      expect(sdkMock.hooks.create).not.toHaveBeenCalled();
    });

    it('should show error for invalid JSON filter', async () => {
      await program.parseAsync([
        'node', 'cli', 'hooks', 'create', 'v1', 'Bad',
        '--trigger', 'document.create',
        '--action', 'auto-tag',
        '--config', '{"tags":[]}',
        '--filter', 'not-json',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('--filter must be valid JSON');
      expect(sdkMock.hooks.create).not.toHaveBeenCalled();
    });

    it('should handle creation errors', async () => {
      sdkMock.hooks.create.mockRejectedValue(new Error('Validation failed'));

      await program.parseAsync([
        'node', 'cli', 'hooks', 'create', 'v1', 'Hook',
        '--trigger', 'document.create',
        '--action', 'auto-tag',
        '--config', '{}',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Validation failed');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('hooks delete', () => {
    it('should delete a hook', async () => {
      sdkMock.hooks.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'hooks', 'delete', 'v1', 'h1']);

      expect(sdkMock.hooks.delete).toHaveBeenCalledWith('v1', 'h1');
    });

    it('should handle delete errors', async () => {
      sdkMock.hooks.delete.mockRejectedValue(new Error('Hook not found'));

      await program.parseAsync(['node', 'cli', 'hooks', 'delete', 'v1', 'h1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Hook not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('hooks executions', () => {
    it('should list executions with details', async () => {
      sdkMock.hooks.listExecutions.mockResolvedValue([
        {
          id: 'e1', hookId: 'h1', eventId: 'ev1', status: 'success',
          durationMs: 42, result: { tagged: true }, error: null, createdAt: '2024-01-01T12:00:00Z',
        },
        {
          id: 'e2', hookId: 'h1', eventId: 'ev2', status: 'error',
          durationMs: 100, result: null, error: 'Template not found', createdAt: '2024-01-02T12:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'hooks', 'executions', 'v1', 'h1']);

      expect(sdkMock.hooks.listExecutions).toHaveBeenCalledWith('v1', 'h1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('SUCCESS');
      expect(stdout).toContain('42ms');
      expect(stdout).toContain('ERROR');
      expect(stdout).toContain('Template not found');
    });

    it('should show message when no executions exist', async () => {
      sdkMock.hooks.listExecutions.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'hooks', 'executions', 'v1', 'h1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No executions found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.hooks.listExecutions.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'hooks', 'executions', 'v1', 'h1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
