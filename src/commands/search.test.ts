import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSearchCommands } from './search.js';
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

describe('search command', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerSearchCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('should search and display results', async () => {
    sdkMock.search.search.mockResolvedValue({
      results: [
        {
          documentId: 'd1', vaultId: 'v1', vaultName: 'My Vault',
          path: 'notes/hello.md', title: 'Hello World',
          snippet: 'This is a <b>test</b> snippet',
          tags: ['test'], rank: 1.5, fileModifiedAt: '2024-01-01',
        },
      ],
      total: 1,
      query: 'hello',
    });

    await program.parseAsync(['node', 'cli', 'search', 'hello']);

    expect(sdkMock.search.search).toHaveBeenCalledWith({
      q: 'hello',
      vault: undefined,
      tags: undefined,
      limit: 20,
      mode: 'text',
    });
    // "1 result(s)" goes to stderr via status()
    const stderr = outputSpy.stderr.join('');
    expect(stderr).toContain('1 result(s)');
    const stdout = outputSpy.stdout.join('');
    expect(stdout).toContain('Hello World');
    expect(stdout).toContain('My Vault');
    // HTML tags should be stripped from snippet
    expect(stdout).toContain('This is a test snippet');
    expect(stdout).not.toContain('<b>');
  });

  it('should pass vault filter when --vault is used', async () => {
    sdkMock.search.search.mockResolvedValue({ results: [], total: 0, query: 'test' });

    await program.parseAsync(['node', 'cli', 'search', 'test', '--vault', 'v1']);

    expect(sdkMock.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ vault: 'v1' }),
    );
  });

  it('should pass tags filter when --tags is used', async () => {
    sdkMock.search.search.mockResolvedValue({ results: [], total: 0, query: 'test' });

    await program.parseAsync(['node', 'cli', 'search', 'test', '--tags', 'javascript,react']);

    expect(sdkMock.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ tags: 'javascript,react' }),
    );
  });

  it('should use custom limit when --limit is provided', async () => {
    sdkMock.search.search.mockResolvedValue({ results: [], total: 0, query: 'test' });

    await program.parseAsync(['node', 'cli', 'search', 'test', '--limit', '5']);

    expect(sdkMock.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });

  it('should show message when no results found', async () => {
    sdkMock.search.search.mockResolvedValue({ results: [], total: 0, query: 'nonexistent' });

    await program.parseAsync(['node', 'cli', 'search', 'nonexistent']);

    const stderr = outputSpy.stderr.join('');
    expect(stderr).toContain('No results found');
  });

  it('should display results without snippets', async () => {
    sdkMock.search.search.mockResolvedValue({
      results: [
        {
          documentId: 'd1', vaultId: 'v1', vaultName: 'Vault',
          path: 'test.md', title: null,
          snippet: '',
          tags: [], rank: 1.0, fileModifiedAt: '2024-01-01',
        },
      ],
      total: 1,
      query: 'test',
    });

    await program.parseAsync(['node', 'cli', 'search', 'test']);

    // Should use path as title fallback
    const stdout = outputSpy.stdout.join('');
    expect(stdout).toContain('test.md');
  });

  it('should handle search errors', async () => {
    sdkMock.search.search.mockRejectedValue(new Error('Server error'));

    await program.parseAsync(['node', 'cli', 'search', 'test']);

    const stderr = outputSpy.stderr.join('');
    expect(stderr).toContain('Server error');
    expect(process.exitCode).toBe(1);
  });

  it('should pass mode parameter when --mode is provided', async () => {
    sdkMock.search.search.mockResolvedValue({ results: [], total: 0, query: 'ml', mode: 'semantic' });

    await program.parseAsync(['node', 'cli', 'search', 'ml', '--mode', 'semantic']);

    expect(sdkMock.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'semantic' }),
    );
  });

  it('should display mode in output when not text mode', async () => {
    sdkMock.search.search.mockResolvedValue({ results: [], total: 0, query: 'ml', mode: 'semantic' });

    await program.parseAsync(['node', 'cli', 'search', 'ml', '--mode', 'semantic']);

    const stderr = outputSpy.stderr.join('');
    expect(stderr).toContain('[semantic]');
  });

  it('should not display mode in output for text mode', async () => {
    sdkMock.search.search.mockResolvedValue({ results: [], total: 0, query: 'test' });

    await program.parseAsync(['node', 'cli', 'search', 'test']);

    const stderr = outputSpy.stderr.join('');
    expect(stderr).not.toContain('[text]');
  });
});
