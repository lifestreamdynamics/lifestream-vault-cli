import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerAnalyticsCommands } from './analytics.js';
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

vi.mock('../utils/resolve-vault.js', () => ({
  resolveVaultId: vi.fn(async (id: string) => id),
}));

describe('analytics commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAnalyticsCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('analytics published', () => {
    it('should display summary of published document views', async () => {
      sdkMock.analytics.getPublishedSummary.mockResolvedValue({
        totalPublished: 3,
        totalViews: 150,
        documents: [
          { id: 'pd1', slug: 'my-first-post', title: 'My First Post', viewCount: 80, publishedAt: '2024-01-01T00:00:00Z' },
          { id: 'pd2', slug: 'second-post', title: 'Second Post', viewCount: 70, publishedAt: '2024-01-15T00:00:00Z' },
        ],
      });

      await program.parseAsync(['node', 'cli', 'analytics', 'published']);

      expect(sdkMock.analytics.getPublishedSummary).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('3');
      expect(stdout).toContain('150');
      expect(stdout).toContain('my-first-post');
      expect(stdout).toContain('80');
    });

    it('should show empty message when no documents published', async () => {
      sdkMock.analytics.getPublishedSummary.mockResolvedValue({
        totalPublished: 0,
        totalViews: 0,
        documents: [],
      });

      await program.parseAsync(['node', 'cli', 'analytics', 'published']);

      const stdout = outputSpy.stdout.join('');
      const stderr = outputSpy.stderr.join('');
      const combined = stdout + stderr;
      // Output: "Total published: 0, Total views: 0" + empty list message
      expect(combined).toContain('Total published: 0');
      expect(combined).toContain('Total views: 0');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.analytics.getPublishedSummary.mockRejectedValue(new Error('Analytics unavailable'));

      await program.parseAsync(['node', 'cli', 'analytics', 'published']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Analytics unavailable');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('analytics share', () => {
    it('should display share link analytics', async () => {
      sdkMock.analytics.getShareAnalytics.mockResolvedValue({
        shareId: 'sl-1',
        viewCount: 42,
        uniqueViewers: 15,
        lastViewedAt: '2024-03-01T12:00:00Z',
        viewsByDay: [
          { date: '2024-03-01', count: 10 },
          { date: '2024-03-02', count: 32 },
        ],
      });

      await program.parseAsync(['node', 'cli', 'analytics', 'share', 'v1', 'sl-1']);

      expect(sdkMock.analytics.getShareAnalytics).toHaveBeenCalledWith('v1', 'sl-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('42');
      expect(stdout).toContain('15');
      expect(stdout).toContain('sl-1');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.analytics.getShareAnalytics.mockRejectedValue(new Error('Share not found'));

      await program.parseAsync(['node', 'cli', 'analytics', 'share', 'v1', 'missing-share']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Share not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
