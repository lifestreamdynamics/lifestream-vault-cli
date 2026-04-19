import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerAiCommands } from './ai.js';
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

describe('ai commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAiCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('ai sessions create', () => {
    it('should create a new AI session', async () => {
      sdkMock.ai.createSession.mockResolvedValue({
        id: 'new-sess',
        title: 'My Session',
        vaultId: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'create', '--title', 'My Session']);

      expect(sdkMock.ai.createSession).toHaveBeenCalledWith({
        title: 'My Session',
        vaultId: undefined,
      });
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('new-sess');
    });

    it('should create a session with vault ID', async () => {
      sdkMock.ai.createSession.mockResolvedValue({
        id: 'new-sess',
        title: null,
        vaultId: 'vault-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'create', '--vault', 'vault-1']);

      expect(sdkMock.ai.createSession).toHaveBeenCalledWith({
        title: undefined,
        vaultId: 'vault-1',
      });
    });

    it('should handle errors gracefully', async () => {
      sdkMock.ai.createSession.mockRejectedValue(new Error('Pro plan required'));

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'create']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Pro plan required');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('ai sessions list', () => {
    it('should list AI chat sessions', async () => {
      sdkMock.ai.listSessions.mockResolvedValue([
        { id: 'sess-1', title: 'First session', vaultId: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
        { id: 'sess-2', title: 'Second session', vaultId: 'v1', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' },
      ]);

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'list']);

      expect(sdkMock.ai.listSessions).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('sess-1');
      expect(stdout).toContain('sess-2');
      expect(stdout).toContain('First session');
    });

    it('should show message when no sessions exist', async () => {
      sdkMock.ai.listSessions.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No AI sessions found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.ai.listSessions.mockRejectedValue(new Error('AI service unavailable'));

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('AI service unavailable');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('ai sessions get', () => {
    it('should get an AI session with messages', async () => {
      sdkMock.ai.getSession.mockResolvedValue({
        session: {
          id: 'sess-1',
          title: 'My Session',
          vaultId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        messages: [
          { id: 'm1', role: 'user', content: 'Hello AI', tokensUsed: 10, createdAt: '2024-01-01T00:01:00Z' },
          { id: 'm2', role: 'assistant', content: 'Hello! How can I help?', tokensUsed: 20, createdAt: '2024-01-01T00:01:05Z' },
        ],
      });

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'get', 'sess-1']);

      expect(sdkMock.ai.getSession).toHaveBeenCalledWith('sess-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('sess-1');
      expect(stdout).toContain('My Session');
      expect(stdout).toContain('Hello AI');
      expect(stdout).toContain('Hello! How can I help?');
    });

    it('should handle session not found error', async () => {
      sdkMock.ai.getSession.mockRejectedValue(new Error('Session not found'));

      await program.parseAsync(['node', 'cli', 'ai', 'sessions', 'get', 'missing-id']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Session not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('ai similar', () => {
    it('should find similar documents', async () => {
      sdkMock.ai.similar.mockResolvedValue({
        similar: [
          { id: 'd1', path: 'notes/a.md', title: 'Note A', similarity: 0.92 },
          { id: 'd2', path: 'notes/b.md', title: null, similarity: 0.85 },
        ],
      });

      await program.parseAsync(['node', 'cli', 'ai', 'similar', 'v1', 'doc1']);

      expect(sdkMock.ai.similar).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('notes/a.md');
    });

    it('should handle errors', async () => {
      sdkMock.ai.similar.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'ai', 'similar', 'v1', 'doc1']);

      expect(process.exitCode).toBe(1);
    });
  });

  describe('ai assist', () => {
    it('should return AI assistance result', async () => {
      sdkMock.ai.assist.mockResolvedValue({ result: 'Improved text.', tokensUsed: 100 });

      await program.parseAsync(['node', 'cli', 'ai', 'assist', 'v1', '--text', 'some text', '--instruction', 'make it better']);

      expect(sdkMock.ai.assist).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Improved text.');
    });

    it('should handle errors', async () => {
      sdkMock.ai.assist.mockRejectedValue(new Error('AI service error'));

      await program.parseAsync(['node', 'cli', 'ai', 'assist', 'v1', '--text', 'text', '--instruction', 'do it']);

      expect(process.exitCode).toBe(1);
    });
  });

  describe('ai suggest', () => {
    it('should return AI writing suggestion', async () => {
      sdkMock.ai.suggest.mockResolvedValue({ suggestion: 'Consider rephrasing.', type: 'style', tokensUsed: 60 });

      await program.parseAsync(['node', 'cli', 'ai', 'suggest', 'v1', 'notes/draft.md', '--type', 'style']);

      expect(sdkMock.ai.suggest).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Consider rephrasing.');
    });

    it('should handle errors', async () => {
      sdkMock.ai.suggest.mockRejectedValue(new Error('Suggestion failed'));

      await program.parseAsync(['node', 'cli', 'ai', 'suggest', 'v1', 'doc.md', '--type', 'grammar']);

      expect(process.exitCode).toBe(1);
    });
  });

  describe('ai chat', () => {
    it('should send a message in an AI session and output the response', async () => {
      sdkMock.ai.chat.mockResolvedValue({
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          content: 'Here is the answer to your question.',
          sources: ['doc1.md'],
        },
        tokensUsed: 45,
      });

      await program.parseAsync(['node', 'cli', 'ai', 'chat', 'sess-1', 'What is the summary?']);

      expect(sdkMock.ai.chat).toHaveBeenCalledWith({
        message: 'What is the summary?',
        sessionId: 'sess-1',
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Here is the answer to your question.');
    });

    it('should handle chat errors gracefully', async () => {
      sdkMock.ai.chat.mockRejectedValue(new Error('Rate limit exceeded'));

      await program.parseAsync(['node', 'cli', 'ai', 'chat', 'sess-1', 'Hi']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Rate limit exceeded');
      expect(process.exitCode).toBe(1);
    });
  });
});
