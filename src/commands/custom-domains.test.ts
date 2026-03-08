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

// Shared mock domain using the corrected schema (status/sslStatus instead of verified)
const mockDomainPending = {
  id: 'dom-1',
  userId: 'u1',
  domain: 'docs.example.com',
  verificationToken: 'verify-token-abc',
  status: 'pending' as const,
  sslStatus: 'pending' as const,
  verificationAttempts: 0,
  lastVerifiedAt: null,
  verifiedAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockDomainVerified = {
  ...mockDomainPending,
  id: 'dom-2',
  domain: 'blog.example.com',
  verificationToken: 'verify-token-xyz',
  status: 'verified' as const,
  sslStatus: 'active' as const,
  verifiedAt: '2024-02-10T00:00:00Z',
  createdAt: '2024-02-01T00:00:00Z',
  updatedAt: '2024-02-10T00:00:00Z',
};

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
    it('should list custom domains showing status column', async () => {
      sdkMock.customDomains.list.mockResolvedValue([mockDomainPending, mockDomainVerified]);

      await program.parseAsync(['node', 'cli', 'custom-domains', 'list']);

      expect(sdkMock.customDomains.list).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('docs.example.com');
      expect(stdout).toContain('blog.example.com');
      // plain text output uses chalk-coloured status strings
      expect(stdout).toContain('verified');
      expect(stdout).toContain('pending');
    });

    it('should not contain the old "Verified" column header', async () => {
      sdkMock.customDomains.list.mockResolvedValue([mockDomainPending]);

      await program.parseAsync(['node', 'cli', 'custom-domains', 'list', '--output', 'table']);

      const stdout = outputSpy.stdout.join('');
      // Column header should be Status, not Verified
      expect(stdout).not.toMatch(/\bVerified\b/);
      expect(stdout).toContain('Status');
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

  describe('custom-domains get', () => {
    it('should display status and sslStatus fields for a domain', async () => {
      sdkMock.customDomains.get.mockResolvedValue(mockDomainVerified);

      await program.parseAsync(['node', 'cli', 'custom-domains', 'get', 'dom-2']);

      expect(sdkMock.customDomains.get).toHaveBeenCalledWith('dom-2');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('verified');
      expect(stdout).toContain('active');
      // Should not output the old boolean "verified" key
      expect(stdout).not.toMatch(/verified\s*:\s*(true|false)/);
    });
  });

  describe('custom-domains add', () => {
    it('should add a custom domain and display the correct DNS prefix', async () => {
      sdkMock.customDomains.create.mockResolvedValue({
        ...mockDomainPending,
        id: 'dom-3',
        domain: 'new.example.com',
        verificationToken: 'lsv-verify-abc123',
      });

      await program.parseAsync(['node', 'cli', 'custom-domains', 'add', 'new.example.com']);

      expect(sdkMock.customDomains.create).toHaveBeenCalledWith({ domain: 'new.example.com' });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('new.example.com');
      expect(stdout).toContain('lsv-verify-abc123');
      // DNS prefix must be _lsv-verify, not _lsvault-verification
      expect(stdout).toContain('_lsv-verify.new.example.com');
      expect(stdout).not.toContain('_lsvault-verification');
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
    it('should report verified when status is verified', async () => {
      sdkMock.customDomains.verify.mockResolvedValue(mockDomainVerified);

      await program.parseAsync(['node', 'cli', 'custom-domains', 'verify', 'dom-2']);

      expect(sdkMock.customDomains.verify).toHaveBeenCalledWith('dom-2');
      const combined = outputSpy.stdout.join('') + outputSpy.stderr.join('');
      expect(combined).toContain('blog.example.com');
      expect(combined).toContain('dom-2');
      expect(combined.toLowerCase()).toContain('verified');
    });

    it('should report not yet verified when status is pending', async () => {
      sdkMock.customDomains.verify.mockResolvedValue(mockDomainPending);

      await program.parseAsync(['node', 'cli', 'custom-domains', 'verify', 'dom-1']);

      const combined = outputSpy.stdout.join('') + outputSpy.stderr.join('');
      expect(combined).toContain('not yet verified');
    });

    it('should handle verification failure', async () => {
      sdkMock.customDomains.verify.mockRejectedValue(new Error('DNS record not found'));

      await program.parseAsync(['node', 'cli', 'custom-domains', 'verify', 'dom-1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('DNS record not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('custom-domains check', () => {
    it('should display each DNS check result with type, status, expected, and found', async () => {
      sdkMock.customDomains.checkDns.mockResolvedValue({
        domain: 'docs.example.com',
        checks: [
          {
            type: 'TXT',
            hostname: '_lsv-verify.docs.example.com',
            expected: 'lsvault-verify=verify-token-abc',
            found: ['lsvault-verify=verify-token-abc'],
            status: 'pass',
          },
        ],
      });

      await program.parseAsync(['node', 'cli', 'custom-domains', 'check', 'dom-1']);

      expect(sdkMock.customDomains.checkDns).toHaveBeenCalledWith('dom-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('docs.example.com');
      expect(stdout).toContain('TXT');
      expect(stdout).toContain('_lsv-verify.docs.example.com');
      expect(stdout).toContain('lsvault-verify=verify-token-abc');
      expect(stdout).toContain('pass');
    });

    it('should show failure message when checks fail', async () => {
      sdkMock.customDomains.checkDns.mockResolvedValue({
        domain: 'docs.example.com',
        checks: [
          {
            type: 'TXT',
            hostname: '_lsv-verify.docs.example.com',
            expected: 'lsvault-verify=verify-token-abc',
            found: [],
            status: 'fail',
          },
        ],
      });

      await program.parseAsync(['node', 'cli', 'custom-domains', 'check', 'dom-1']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('fail');
      expect(stdout).toContain('(none)');
    });

    it('should handle errors when check fails', async () => {
      sdkMock.customDomains.checkDns.mockRejectedValue(new Error('Domain not found'));

      await program.parseAsync(['node', 'cli', 'custom-domains', 'check', 'dom-1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Domain not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
