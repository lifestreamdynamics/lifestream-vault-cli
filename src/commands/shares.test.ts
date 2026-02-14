import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerShareCommands } from './shares.js';
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
  getClient: vi.fn(() => sdkMock),
}));

describe('shares commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerShareCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('shares list', () => {
    it('should list share links for a document', async () => {
      sdkMock.shares.list.mockResolvedValue([
        {
          id: 'sl1', documentId: 'd1', vaultId: 'v1', createdBy: 'u1',
          tokenPrefix: 'abc12345', permission: 'view', expiresAt: null,
          maxViews: null, viewCount: 5, isActive: true, createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'sl2', documentId: 'd1', vaultId: 'v1', createdBy: 'u1',
          tokenPrefix: 'def67890', permission: 'edit', expiresAt: '2025-12-31T00:00:00Z',
          maxViews: 100, viewCount: 12, isActive: false, createdAt: '2024-02-01T00:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'shares', 'list', 'v1', 'notes/meeting.md']);

      expect(sdkMock.shares.list).toHaveBeenCalledWith('v1', 'notes/meeting.md');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('abc12345');
      expect(stdout).toContain('def67890');
      expect(stdout).toContain('view');
      expect(stdout).toContain('edit');
      expect(stdout).toContain('5');
      expect(stdout).toContain('12/100');
    });

    it('should show message when no share links exist', async () => {
      sdkMock.shares.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'shares', 'list', 'v1', 'doc.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No share links found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.shares.list.mockRejectedValue(new Error('Document not found'));

      await program.parseAsync(['node', 'cli', 'shares', 'list', 'v1', 'missing.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Document not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('shares create', () => {
    it('should create a share link with defaults', async () => {
      sdkMock.shares.create.mockResolvedValue({
        shareLink: {
          id: 'sl1', documentId: 'd1', vaultId: 'v1', createdBy: 'u1',
          tokenPrefix: 'abc12345', permission: 'view', expiresAt: null,
          maxViews: null, viewCount: 0, isActive: true, createdAt: '2024-01-01',
        },
        fullToken: 'abc12345_full_secret_token',
      });

      await program.parseAsync(['node', 'cli', 'shares', 'create', 'v1', 'notes/doc.md']);

      expect(sdkMock.shares.create).toHaveBeenCalledWith('v1', 'notes/doc.md', {
        permission: 'view',
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('abc12345_full_secret_token');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('IMPORTANT');
    });

    it('should create a share link with all options', async () => {
      sdkMock.shares.create.mockResolvedValue({
        shareLink: {
          id: 'sl2', documentId: 'd1', vaultId: 'v1', createdBy: 'u1',
          tokenPrefix: 'xyz98765', permission: 'edit', expiresAt: '2025-12-31T00:00:00Z',
          maxViews: 50, viewCount: 0, isActive: true, createdAt: '2024-01-01',
        },
        fullToken: 'xyz98765_secret',
      });

      await program.parseAsync([
        'node', 'cli', 'shares', 'create', 'v1', 'docs/secret.md',
        '--permission', 'edit',
        '--password', 'mypassword',
        '--expires', '2025-12-31T00:00:00Z',
        '--max-views', '50',
      ]);

      expect(sdkMock.shares.create).toHaveBeenCalledWith('v1', 'docs/secret.md', {
        permission: 'edit',
        password: 'mypassword',
        expiresAt: '2025-12-31T00:00:00Z',
        maxViews: 50,
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('xyz98765_secret');
    });

    it('should handle creation errors', async () => {
      sdkMock.shares.create.mockRejectedValue(new Error('Invalid password'));

      await program.parseAsync(['node', 'cli', 'shares', 'create', 'v1', 'doc.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Invalid password');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('shares revoke', () => {
    it('should revoke a share link', async () => {
      sdkMock.shares.revoke.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'shares', 'revoke', 'v1', 'sl1']);

      expect(sdkMock.shares.revoke).toHaveBeenCalledWith('v1', 'sl1');
    });

    it('should handle revoke errors', async () => {
      sdkMock.shares.revoke.mockRejectedValue(new Error('Share link not found'));

      await program.parseAsync(['node', 'cli', 'shares', 'revoke', 'v1', 'sl1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Share link not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
