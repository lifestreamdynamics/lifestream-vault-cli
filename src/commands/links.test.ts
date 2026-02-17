import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerLinkCommands } from './links.js';
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

describe('links commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerLinkCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('links list', () => {
    it('should list forward links with resolution status', async () => {
      sdkMock.documents.getLinks.mockResolvedValue([
        {
          id: 'l1',
          targetPath: 'notes/target.md',
          linkText: 'Target Note',
          isResolved: true,
          targetDocument: { id: 'd1', path: 'notes/target.md', title: 'Target Note' },
        },
        {
          id: 'l2',
          targetPath: 'missing.md',
          linkText: 'Missing',
          isResolved: false,
          targetDocument: null,
        },
      ]);

      await program.parseAsync(['node', 'cli', 'links', 'list', 'v1', 'source.md']);

      expect(sdkMock.documents.getLinks).toHaveBeenCalledWith('v1', 'source.md');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Target Note');
      expect(stdout).toContain('notes/target.md');
      expect(stdout).toContain('Missing');
      expect(stdout).toContain('missing.md');
    });

    it('should show message when no forward links exist', async () => {
      sdkMock.documents.getLinks.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'links', 'list', 'v1', 'source.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No forward links found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.getLinks.mockRejectedValue(new Error('Document not found'));

      await program.parseAsync(['node', 'cli', 'links', 'list', 'v1', 'source.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Document not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('links backlinks', () => {
    it('should list backlinks with context', async () => {
      sdkMock.documents.getBacklinks.mockResolvedValue([
        {
          id: 'bl1',
          sourceDocumentId: 'd1',
          linkText: 'Important',
          contextSnippet: 'This is important stuff',
          sourceDocument: { id: 'd1', path: 'notes/ref.md', title: 'Reference' },
        },
        {
          id: 'bl2',
          sourceDocumentId: 'd2',
          linkText: 'Important',
          contextSnippet: null,
          sourceDocument: { id: 'd2', path: 'other.md', title: null },
        },
      ]);

      await program.parseAsync(['node', 'cli', 'links', 'backlinks', 'v1', 'important.md']);

      expect(sdkMock.documents.getBacklinks).toHaveBeenCalledWith('v1', 'important.md');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Reference');
      expect(stdout).toContain('other.md');
      expect(stdout).toContain('Important');
      expect(stdout).toContain('This is important stuff');
    });

    it('should show message when no backlinks exist', async () => {
      sdkMock.documents.getBacklinks.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'links', 'backlinks', 'v1', 'lonely.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No backlinks found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.documents.getBacklinks.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'links', 'backlinks', 'v1', 'doc.md']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('links graph', () => {
    it('should output link graph as JSON', async () => {
      sdkMock.vaults.getGraph.mockResolvedValue({
        nodes: [
          { id: 'd1', path: 'a.md', title: 'A' },
          { id: 'd2', path: 'b.md', title: 'B' },
        ],
        edges: [
          { source: 'd1', target: 'd2', linkText: 'B' },
        ],
      });

      await program.parseAsync(['node', 'cli', 'links', 'graph', 'v1']);

      expect(sdkMock.vaults.getGraph).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      const json = JSON.parse(stdout);
      expect(json.nodes).toHaveLength(2);
      expect(json.edges).toHaveLength(1);
      expect(json.nodes[0].path).toBe('a.md');
      expect(json.edges[0].source).toBe('d1');
    });

    it('should handle empty graph', async () => {
      sdkMock.vaults.getGraph.mockResolvedValue({
        nodes: [],
        edges: [],
      });

      await program.parseAsync(['node', 'cli', 'links', 'graph', 'v1']);

      const stdout = outputSpy.stdout.join('');
      const json = JSON.parse(stdout);
      expect(json.nodes).toEqual([]);
      expect(json.edges).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      sdkMock.vaults.getGraph.mockRejectedValue(new Error('Vault not found'));

      await program.parseAsync(['node', 'cli', 'links', 'graph', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Vault not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('links broken', () => {
    it('should list broken links grouped by target', async () => {
      sdkMock.vaults.getUnresolvedLinks.mockResolvedValue([
        {
          targetPath: 'missing.md',
          references: [
            {
              sourceDocumentId: 'd1',
              sourcePath: 'notes/a.md',
              sourceTitle: 'Note A',
              linkText: 'Missing',
            },
            {
              sourceDocumentId: 'd2',
              sourcePath: 'notes/b.md',
              sourceTitle: null,
              linkText: 'missing',
            },
          ],
        },
        {
          targetPath: 'other/gone.md',
          references: [
            {
              sourceDocumentId: 'd3',
              sourcePath: 'c.md',
              sourceTitle: 'C',
              linkText: 'Gone',
            },
          ],
        },
      ]);

      await program.parseAsync(['node', 'cli', 'links', 'broken', 'v1']);

      expect(sdkMock.vaults.getUnresolvedLinks).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('missing.md');
      expect(stdout).toContain('notes/a.md');
      expect(stdout).toContain('notes/b.md');
      expect(stdout).toContain('other/gone.md');
      expect(stdout).toContain('c.md');
      expect(stdout).toContain('2 broken link target(s) found');
    });

    it('should show success message when no broken links', async () => {
      sdkMock.vaults.getUnresolvedLinks.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'links', 'broken', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No broken links found!');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.vaults.getUnresolvedLinks.mockRejectedValue(new Error('Permission denied'));

      await program.parseAsync(['node', 'cli', 'links', 'broken', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Permission denied');
      expect(process.exitCode).toBe(1);
    });
  });
});
