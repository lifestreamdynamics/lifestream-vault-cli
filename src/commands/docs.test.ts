import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerDocCommands } from './docs.js';
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

vi.mock('../lib/credential-manager.js', () => ({
  createCredentialManager: vi.fn(() => ({
    saveVaultKey: vi.fn(async () => {}),
    getVaultKey: vi.fn(async () => null),
  })),
}));

describe('docs commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerDocCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('docs list', () => {
    it('should list documents with path, title, and tags', async () => {
      sdkMock.documents.list.mockResolvedValue([
        { path: 'notes/hello.md', title: 'Hello World', tags: ['greeting', 'test'], sizeBytes: 1024, fileModifiedAt: '2024-01-01' },
        { path: 'readme.md', title: null, tags: [], sizeBytes: 512, fileModifiedAt: '2024-01-01' },
      ]);

      await program.parseAsync(['node', 'cli', 'docs', 'list', 'v1']);

      expect(sdkMock.documents.list).toHaveBeenCalledWith('v1', undefined);
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('notes/hello.md');
      expect(stdout).toContain('Hello World');
      expect(stdout).toContain('greeting');
      expect(stdout).toContain('readme.md');
      // "2 document(s)" goes to stderr via status()
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('2 document(s)');
    });

    it('should pass directory filter when --dir is used', async () => {
      sdkMock.documents.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'docs', 'list', 'v1', '--dir', 'notes/']);

      expect(sdkMock.documents.list).toHaveBeenCalledWith('v1', 'notes/');
    });

    it('should show message when no documents found', async () => {
      sdkMock.documents.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'docs', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No documents found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.list.mockRejectedValue(new Error('Vault not found'));

      await program.parseAsync(['node', 'cli', 'docs', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Vault not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('docs get', () => {
    it('should print document content to stdout', async () => {
      sdkMock.documents.get.mockResolvedValue({
        document: {
          id: 'd1', vaultId: 'v1', path: 'hello.md', title: 'Hello',
          contentHash: 'abc', sizeBytes: 100, tags: [], fileModifiedAt: '2024-01-01',
          createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        content: '# Hello World\n\nThis is content.',
      });

      await program.parseAsync(['node', 'cli', 'docs', 'get', 'v1', 'hello.md']);

      expect(sdkMock.documents.get).toHaveBeenCalledWith('v1', 'hello.md');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('# Hello World\n\nThis is content.');
    });

    it('should display metadata when --meta flag is used', async () => {
      sdkMock.documents.get.mockResolvedValue({
        document: {
          id: 'd1', vaultId: 'v1', path: 'hello.md', title: 'Hello',
          contentHash: 'sha256abc', sizeBytes: 1024, tags: ['test', 'doc'],
          fileModifiedAt: '2024-06-15T12:00:00Z',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-06-15T12:00:00Z',
        },
        content: '# Hello',
      });

      await program.parseAsync(['node', 'cli', 'docs', 'get', 'v1', 'hello.md', '--meta']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('hello.md');
      expect(stdout).toContain('Hello');
      expect(stdout).toContain('1024');
      expect(stdout).toContain('test, doc');
      expect(stdout).toContain('sha256abc');
    });

    it('should handle errors', async () => {
      sdkMock.documents.get.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'docs', 'get', 'v1', 'missing.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Failed to get document');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('docs delete', () => {
    it('should delete a document successfully', async () => {
      sdkMock.documents.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'docs', 'delete', 'v1', 'old.md']);

      expect(sdkMock.documents.delete).toHaveBeenCalledWith('v1', 'old.md');
    });

    it('should handle deletion errors', async () => {
      sdkMock.documents.delete.mockRejectedValue(new Error('Permission denied'));

      await program.parseAsync(['node', 'cli', 'docs', 'delete', 'v1', 'protected.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Permission denied');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('docs move', () => {
    it('should move a document to a new path', async () => {
      sdkMock.documents.move.mockResolvedValue({
        message: 'Moved',
        source: 'old-path.md',
        destination: 'new-path.md',
      });

      await program.parseAsync(['node', 'cli', 'docs', 'move', 'v1', 'old-path.md', 'new-path.md']);

      expect(sdkMock.documents.move).toHaveBeenCalledWith('v1', 'old-path.md', 'new-path.md', undefined);
    });

    it('should pass overwrite flag when --overwrite is used', async () => {
      sdkMock.documents.move.mockResolvedValue({
        message: 'Moved',
        source: 'a.md',
        destination: 'b.md',
      });

      await program.parseAsync(['node', 'cli', 'docs', 'move', 'v1', 'a.md', 'b.md', '--overwrite']);

      expect(sdkMock.documents.move).toHaveBeenCalledWith('v1', 'a.md', 'b.md', true);
    });

    it('should handle move errors', async () => {
      sdkMock.documents.move.mockRejectedValue(new Error('Destination exists'));

      await program.parseAsync(['node', 'cli', 'docs', 'move', 'v1', 'a.md', 'b.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Destination exists');
      expect(process.exitCode).toBe(1);
    });
  });
});
