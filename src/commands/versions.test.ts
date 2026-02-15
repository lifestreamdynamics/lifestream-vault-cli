import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerVersionCommands } from './versions.js';
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

describe('versions commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerVersionCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('versions list', () => {
    it('should list versions for a document', async () => {
      sdkMock.documents.listVersions.mockResolvedValue([
        { id: 'v1', versionNum: 2, changeSource: 'api', sizeBytes: 200, isPinned: false, createdAt: '2024-01-02' },
        { id: 'v2', versionNum: 1, changeSource: 'web', sizeBytes: 150, isPinned: true, createdAt: '2024-01-01' },
      ]);

      await program.parseAsync(['node', 'cli', 'versions', 'list', 'vault-1', 'notes/todo.md']);

      expect(sdkMock.documents.listVersions).toHaveBeenCalledWith('vault-1', 'notes/todo.md');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('v2');
      expect(stdout).toContain('v1');
    });

    it('should show message when no versions found', async () => {
      sdkMock.documents.listVersions.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'versions', 'list', 'vault-1', 'notes/todo.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No versions found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.listVersions.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'versions', 'list', 'vault-1', 'notes/todo.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('versions view', () => {
    it('should display version content', async () => {
      sdkMock.documents.getVersion.mockResolvedValue({
        id: 'v1', versionNum: 3, content: '# Hello version 3',
        changeSource: 'api', sizeBytes: 18, isPinned: false, createdAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'versions', 'view', 'vault-1', 'notes/todo.md', '3']);

      expect(sdkMock.documents.getVersion).toHaveBeenCalledWith('vault-1', 'notes/todo.md', 3);
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('# Hello version 3');
    });

    it('should show error for pruned content', async () => {
      sdkMock.documents.getVersion.mockResolvedValue({
        id: 'v1', versionNum: 1, content: null,
        changeSource: 'api', sizeBytes: 10, isPinned: false, createdAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'versions', 'view', 'vault-1', 'notes/todo.md', '1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('no longer available');
      expect(process.exitCode).toBe(1);
    });

    it('should reject non-numeric version', async () => {
      await program.parseAsync(['node', 'cli', 'versions', 'view', 'vault-1', 'notes/todo.md', 'abc']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Version must be a number');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('versions diff', () => {
    it('should display diff output', async () => {
      sdkMock.documents.diffVersions.mockResolvedValue({
        fromVersion: 1,
        toVersion: 2,
        changes: [
          { value: 'Hello\n' },
          { removed: true, value: 'World\n' },
          { added: true, value: 'New World\n' },
        ],
      });

      await program.parseAsync(['node', 'cli', 'versions', 'diff', 'vault-1', 'notes/todo.md', '1', '2']);

      expect(sdkMock.documents.diffVersions).toHaveBeenCalledWith('vault-1', 'notes/todo.md', 1, 2);
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('v1');
      expect(stderr).toContain('v2');
    });

    it('should reject non-numeric version arguments', async () => {
      await program.parseAsync(['node', 'cli', 'versions', 'diff', 'vault-1', 'notes/todo.md', 'a', 'b']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Version numbers must be integers');
      expect(process.exitCode).toBe(1);
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.diffVersions.mockRejectedValue(new Error('Version not found'));

      await program.parseAsync(['node', 'cli', 'versions', 'diff', 'vault-1', 'notes/todo.md', '1', '2']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Version not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('versions restore', () => {
    it('should restore a version', async () => {
      sdkMock.documents.restoreVersion.mockResolvedValue({
        id: 'd1', path: 'notes/todo.md', title: 'Todo',
      });

      await program.parseAsync(['node', 'cli', 'versions', 'restore', 'vault-1', 'notes/todo.md', '2']);

      expect(sdkMock.documents.restoreVersion).toHaveBeenCalledWith('vault-1', 'notes/todo.md', 2);
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Restored');
      expect(stderr).toContain('notes/todo.md');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.restoreVersion.mockRejectedValue(new Error('Version content pruned'));

      await program.parseAsync(['node', 'cli', 'versions', 'restore', 'vault-1', 'notes/todo.md', '1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Version content pruned');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('versions pin', () => {
    it('should pin a version', async () => {
      sdkMock.documents.pinVersion.mockResolvedValue({
        id: 'v1', versionNum: 5, isPinned: true,
      });

      await program.parseAsync(['node', 'cli', 'versions', 'pin', 'vault-1', 'notes/todo.md', '5']);

      expect(sdkMock.documents.pinVersion).toHaveBeenCalledWith('vault-1', 'notes/todo.md', 5);
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Pinned');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.pinVersion.mockRejectedValue(new Error('Version not found'));

      await program.parseAsync(['node', 'cli', 'versions', 'pin', 'vault-1', 'notes/todo.md', '99']);

      expect(process.exitCode).toBe(1);
    });
  });

  describe('versions unpin', () => {
    it('should unpin a version', async () => {
      sdkMock.documents.unpinVersion.mockResolvedValue({
        id: 'v1', versionNum: 5, isPinned: false,
      });

      await program.parseAsync(['node', 'cli', 'versions', 'unpin', 'vault-1', 'notes/todo.md', '5']);

      expect(sdkMock.documents.unpinVersion).toHaveBeenCalledWith('vault-1', 'notes/todo.md', 5);
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Unpinned');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.unpinVersion.mockRejectedValue(new Error('Version not found'));

      await program.parseAsync(['node', 'cli', 'versions', 'unpin', 'vault-1', 'notes/todo.md', '99']);

      expect(process.exitCode).toBe(1);
    });
  });
});
