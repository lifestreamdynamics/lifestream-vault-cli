import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerPublishCommands } from './publish.js';
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

describe('publish commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerPublishCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('publish list', () => {
    it('should list published documents', async () => {
      sdkMock.publish.listMine.mockResolvedValue([
        {
          id: 'p1', documentId: 'd1', vaultId: 'v1', publishedBy: 'u1',
          slug: 'my-post', seoTitle: 'My Post', seoDescription: null,
          ogImage: null, isPublished: true, publishedAt: '2024-01-01',
          updatedAt: '2024-01-01', documentPath: 'blog/post.md', documentTitle: 'My Post',
        },
        {
          id: 'p2', documentId: 'd2', vaultId: 'v1', publishedBy: 'u1',
          slug: 'draft-post', seoTitle: null, seoDescription: null,
          ogImage: null, isPublished: false, publishedAt: '2024-02-01',
          updatedAt: '2024-03-01', documentPath: 'blog/draft.md', documentTitle: null,
        },
      ]);

      await program.parseAsync(['node', 'cli', 'publish', 'list', 'v1']);

      expect(sdkMock.publish.listMine).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('my-post');
      expect(stdout).toContain('blog/post.md');
      expect(stdout).toContain('My Post');
      expect(stdout).toContain('draft-post');
    });

    it('should show message when no published docs exist', async () => {
      sdkMock.publish.listMine.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'publish', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No published documents found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.publish.listMine.mockRejectedValue(new Error('Unauthorized'));

      await program.parseAsync(['node', 'cli', 'publish', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Unauthorized');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('publish create', () => {
    it('should publish a document with required params', async () => {
      sdkMock.publish.create.mockResolvedValue({
        id: 'p1', documentId: 'd1', vaultId: 'v1', publishedBy: 'u1',
        slug: 'my-post', seoTitle: null, seoDescription: null,
        ogImage: null, isPublished: true, publishedAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'publish', 'create', 'v1', 'blog/post.md', '--slug', 'my-post',
      ]);

      expect(sdkMock.publish.create).toHaveBeenCalledWith('v1', 'blog/post.md', {
        slug: 'my-post',
      });
      // success() outputs to stderr in text mode
      const output = outputSpy.stdout.join('') + outputSpy.stderr.join('');
      expect(output).toContain('my-post');
    });

    it('should publish a document with full SEO options', async () => {
      sdkMock.publish.create.mockResolvedValue({
        id: 'p2', documentId: 'd2', vaultId: 'v1', publishedBy: 'u1',
        slug: 'seo-post', seoTitle: 'SEO Title', seoDescription: 'Description',
        ogImage: 'https://example.com/img.png', isPublished: true,
        publishedAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'publish', 'create', 'v1', 'blog/seo.md',
        '--slug', 'seo-post',
        '--title', 'SEO Title',
        '--description', 'Description',
        '--og-image', 'https://example.com/img.png',
      ]);

      expect(sdkMock.publish.create).toHaveBeenCalledWith('v1', 'blog/seo.md', {
        slug: 'seo-post',
        seoTitle: 'SEO Title',
        seoDescription: 'Description',
        ogImage: 'https://example.com/img.png',
      });
    });

    it('should handle publish errors', async () => {
      sdkMock.publish.create.mockRejectedValue(new Error('Slug already in use'));

      await program.parseAsync([
        'node', 'cli', 'publish', 'create', 'v1', 'doc.md', '--slug', 'taken',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Slug already in use');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('publish update', () => {
    it('should update a published document', async () => {
      sdkMock.publish.update.mockResolvedValue({
        id: 'p1', documentId: 'd1', vaultId: 'v1', publishedBy: 'u1',
        slug: 'updated-slug', seoTitle: 'New Title', seoDescription: null,
        ogImage: null, isPublished: true, publishedAt: '2024-01-01',
        updatedAt: '2024-06-01T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'publish', 'update', 'v1', 'blog/post.md',
        '--slug', 'updated-slug',
        '--title', 'New Title',
      ]);

      expect(sdkMock.publish.update).toHaveBeenCalledWith('v1', 'blog/post.md', {
        slug: 'updated-slug',
        seoTitle: 'New Title',
      });
      const output = outputSpy.stdout.join('') + outputSpy.stderr.join('');
      expect(output).toContain('updated-slug');
    });

    it('should handle update errors', async () => {
      sdkMock.publish.update.mockRejectedValue(new Error('Not found'));

      await program.parseAsync([
        'node', 'cli', 'publish', 'update', 'v1', 'doc.md', '--slug', 'slug',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('publish delete', () => {
    it('should unpublish a document', async () => {
      sdkMock.publish.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'publish', 'delete', 'v1', 'blog/post.md']);

      expect(sdkMock.publish.delete).toHaveBeenCalledWith('v1', 'blog/post.md');
    });

    it('should handle delete errors', async () => {
      sdkMock.publish.delete.mockRejectedValue(new Error('Published document not found'));

      await program.parseAsync(['node', 'cli', 'publish', 'delete', 'v1', 'missing.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Published document not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
