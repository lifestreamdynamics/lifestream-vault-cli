import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerCustomDomainCommands } from './custom-domains.js';
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

describe('custom-domains commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerCustomDomainCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('custom-domains list', () => {
    it('should list custom domains', async () => {
      sdkMock.customDomains.list.mockResolvedValue([
        {
          id: 'dom-1',
          userId: 'u1',
          domain: 'docs.example.com',
          verified: true,
          verificationToken: 'verify-token-abc',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'dom-2',
          userId: 'u1',
          domain: 'blog.example.com',
          verified: false,
          verificationToken: 'verify-token-xyz',
          createdAt: '2024-02-01T00:00:00Z',
          updatedAt: '2024-02-01T00:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'custom-domains', 'list']);

      expect(sdkMock.customDomains.list).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('docs.example.com');
      expect(stdout).toContain('blog.example.com');
      expect(stdout).toContain('verified');
      expect(stdout).toContain('unverified');
    });

    it('should show message when no custom domains exist', async () => {
      sdkMock.customDomains.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'custom-domains', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No custom domains found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.customDomains.list.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'custom-domains', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('custom-domains add', () => {
    it('should add a custom domain and display the verification token', async () => {
      sdkMock.customDomains.create.mockResolvedValue({
        id: 'dom-3',
        userId: 'u1',
        domain: 'new.example.com',
        verified: false,
        verificationToken: 'lsv-verify-abc123',
        createdAt: '2024-03-01T00:00:00Z',
        updatedAt: '2024-03-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'custom-domains', 'add', 'new.example.com']);

      expect(sdkMock.customDomains.create).toHaveBeenCalledWith({ domain: 'new.example.com' });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('new.example.com');
      expect(stdout).toContain('lsv-verify-abc123');
    });

    it('should handle errors when adding fails', async () => {
      sdkMock.customDomains.create.mockRejectedValue(new Error('Domain already registered'));

      await program.parseAsync(['node', 'cli', 'custom-domains', 'add', 'existing.example.com']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Domain already registered');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('custom-domains verify', () => {
    it('should verify a custom domain', async () => {
      sdkMock.customDomains.verify.mockResolvedValue({
        id: 'dom-1',
        userId: 'u1',
        domain: 'docs.example.com',
        verified: true,
        verificationToken: 'verify-token-abc',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-03-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'custom-domains', 'verify', 'dom-1']);

      expect(sdkMock.customDomains.verify).toHaveBeenCalledWith('dom-1');
      const stdout = outputSpy.stdout.join('');
      const stderr = outputSpy.stderr.join('');
      const combined = stdout + stderr;
      expect(combined).toContain('docs.example.com');
      expect(combined).toContain('dom-1');
      // out.success outputs "Domain verified: ..." to stderr, printKeyValue "Verified: true" to stdout
      expect(combined.toLowerCase()).toContain('verified');
    });

    it('should handle verification failure', async () => {
      sdkMock.customDomains.verify.mockRejectedValue(new Error('DNS record not found'));

      await program.parseAsync(['node', 'cli', 'custom-domains', 'verify', 'dom-1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('DNS record not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
