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

vi.mock('../config.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
  getCredentialManager: vi.fn(() => ({
    saveVaultKey: vi.fn(async () => {}),
    getVaultKey: vi.fn(async () => null),
  })),
  loadConfigAsync: vi.fn(async () => ({ apiUrl: 'https://test.example.com', apiKey: 'lsv_k_test' })),
  DEFAULT_API_URL: 'https://vault.lifestreamdynamics.com',
}));

// Resolve vault IDs as-is in tests (no network slug lookup)
vi.mock('../utils/resolve-vault.js', () => ({
  resolveVaultId: vi.fn(async (id: string) => id),
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

      expect(sdkMock.documents.list).toHaveBeenCalledWith('v1', undefined, { limit: undefined, offset: undefined, tags: undefined });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('notes/hello.md');
      expect(stdout).toContain('Hello World');
      expect(stdout).toContain('greeting');
      expect(stdout).toContain('readme.md');
      // "2 document(s)" goes to stderr via status()
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('2 document(s)');
    });

    it('should pass directory filter when --dir is used (trailing slash stripped)', async () => {
      sdkMock.documents.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'docs', 'list', 'v1', '--dir', 'notes/']);

      expect(sdkMock.documents.list).toHaveBeenCalledWith('v1', 'notes', { limit: undefined, offset: undefined, tags: undefined });
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
    it('should delete a document successfully when --yes is provided', async () => {
      sdkMock.documents.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'docs', 'delete', 'v1', 'old.md', '--yes']);

      expect(sdkMock.documents.delete).toHaveBeenCalledWith('v1', 'old.md');
    });

    it('should abort when non-interactive and --yes not provided', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      await program.parseAsync(['node', 'cli', 'docs', 'delete', 'v1', 'old.md']);

      expect(sdkMock.documents.delete).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('non-interactive');
      expect(process.exitCode).toBe(1);
    });

    it('should handle deletion errors', async () => {
      sdkMock.documents.delete.mockRejectedValue(new Error('Permission denied'));

      await program.parseAsync(['node', 'cli', 'docs', 'delete', 'v1', 'protected.md', '--yes']);

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

    it('should skip the API call and print a preview when --dry-run is set', async () => {
      await program.parseAsync(['node', 'cli', 'docs', 'move', 'v1', 'old.md', 'new.md', '--dry-run']);

      expect(sdkMock.documents.move).not.toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      // In non-TTY environments the default output is json; confirm the dryRun flag and paths are present
      expect(stdout).toContain('old.md');
      expect(stdout).toContain('new.md');
      expect(stdout).toContain('true');
    });

    it('should emit dry-run JSON payload when --dry-run and --output json are combined', async () => {
      await program.parseAsync(['node', 'cli', 'docs', 'move', 'v1', 'old.md', 'new.md', '--dry-run', '--output', 'json']);

      expect(sdkMock.documents.move).not.toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      const parsed = JSON.parse(stdout);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.source).toBe('old.md');
      expect(parsed.destination).toBe('new.md');
    });
  });

  describe('docs put', () => {
    /**
     * Helper: replace process.stdin with a mock Readable that emits the given
     * content string then ends, and restore the original after the action runs.
     */
    function mockStdin(content: string): () => void {
      const { Readable } = require('stream');
      const mock = new Readable({ read() {} });
      const original = process.stdin;
      Object.defineProperty(process, 'stdin', { value: mock, configurable: true });
      // Schedule data + end so the Promise inside the action can settle
      process.nextTick(() => {
        if (content.length > 0) mock.push(content);
        mock.push(null); // EOF
      });
      return () => {
        Object.defineProperty(process, 'stdin', { value: original, configurable: true });
      };
    }

    it('should upload document content when stdin has non-empty content', async () => {
      const restore = mockStdin('# Hello World\n\nSome content here.');
      try {
        sdkMock.vaults.get.mockResolvedValue({ id: 'v1', encryptionEnabled: false });
        sdkMock.documents.put.mockResolvedValue({
          path: 'notes/hello.md',
          sizeBytes: 34,
          encrypted: false,
        });

        await program.parseAsync(['node', 'cli', 'docs', 'put', 'v1', 'notes/hello.md']);

        expect(sdkMock.documents.put).toHaveBeenCalledWith('v1', 'notes/hello.md', '# Hello World\n\nSome content here.');
        const stdout = outputSpy.stdout.join('');
        expect(stdout).toContain('notes/hello.md');
        expect(stdout).toContain('34');
        expect(process.exitCode).not.toBe(1);
      } finally {
        restore();
      }
    });

    it('should reject empty stdin and set exitCode 1', async () => {
      const restore = mockStdin('');
      try {
        await program.parseAsync(['node', 'cli', 'docs', 'put', 'v1', 'notes/hello.md']);

        expect(sdkMock.documents.put).not.toHaveBeenCalled();
        expect(sdkMock.vaults.get).not.toHaveBeenCalled();
        const stderr = outputSpy.stderr.join('');
        expect(stderr).toContain('No content received');
        expect(process.exitCode).toBe(1);
      } finally {
        restore();
      }
    });

    it('should reject whitespace-only stdin and set exitCode 1', async () => {
      const restore = mockStdin('   \n\t\n   ');
      try {
        await program.parseAsync(['node', 'cli', 'docs', 'put', 'v1', 'notes/hello.md']);

        expect(sdkMock.documents.put).not.toHaveBeenCalled();
        const stderr = outputSpy.stderr.join('');
        expect(stderr).toContain('No content received');
        expect(process.exitCode).toBe(1);
      } finally {
        restore();
      }
    });

    it('should include the vault id and doc path in the hint message', async () => {
      const restore = mockStdin('');
      try {
        await program.parseAsync(['node', 'cli', 'docs', 'put', 'abc123', 'notes/hello.md']);

        const stderr = outputSpy.stderr.join('');
        expect(stderr).toContain('abc123');
        expect(stderr).toContain('notes/hello.md');
      } finally {
        restore();
      }
    });

    it('should handle API errors gracefully', async () => {
      const restore = mockStdin('# content');
      try {
        sdkMock.vaults.get.mockResolvedValue({ id: 'v1', encryptionEnabled: false });
        sdkMock.documents.put.mockRejectedValue(new Error('Storage quota exceeded'));

        await program.parseAsync(['node', 'cli', 'docs', 'put', 'v1', 'notes/hello.md']);

        const stderr = outputSpy.stderr.join('');
        expect(stderr).toContain('Storage quota exceeded');
        expect(process.exitCode).toBe(1);
      } finally {
        restore();
      }
    });
  });
});
