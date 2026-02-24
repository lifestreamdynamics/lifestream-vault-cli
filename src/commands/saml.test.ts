import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSamlCommands } from './saml.js';
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

describe('saml commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  const mockConfig = {
    id: 'sso-1',
    domain: 'acmecorp.com',
    slug: 'acmecorp',
    entityId: 'https://idp.acmecorp.com/saml',
    ssoUrl: 'https://idp.acmecorp.com/sso',
    certificate: 'cert',
    spEntityId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerSamlCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  // ── list-configs ──────────────────────────────────────────────────────────

  describe('saml list-configs', () => {
    it('should list SSO configs', async () => {
      sdkMock.saml.listConfigs.mockResolvedValue([mockConfig]);

      await program.parseAsync(['node', 'cli', 'saml', 'list-configs']);

      expect(sdkMock.saml.listConfigs).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('acmecorp.com');
    });

    it('should show empty message when no configs', async () => {
      sdkMock.saml.listConfigs.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'saml', 'list-configs']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('No SSO configurations found.');
    });

    it('should handle errors', async () => {
      sdkMock.saml.listConfigs.mockRejectedValue(new Error('Admin required'));

      await program.parseAsync(['node', 'cli', 'saml', 'list-configs']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Admin required');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── get-config ────────────────────────────────────────────────────────────

  describe('saml get-config', () => {
    it('should display config details', async () => {
      sdkMock.saml.getConfig.mockResolvedValue(mockConfig);

      await program.parseAsync(['node', 'cli', 'saml', 'get-config', 'sso-1']);

      expect(sdkMock.saml.getConfig).toHaveBeenCalledWith('sso-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('acmecorp.com');
    });

    it('should handle not found error', async () => {
      sdkMock.saml.getConfig.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'saml', 'get-config', 'nonexistent']);

      expect(process.exitCode).toBe(1);
    });
  });

  // ── create-config ─────────────────────────────────────────────────────────

  describe('saml create-config', () => {
    it('should create an SSO config', async () => {
      sdkMock.saml.createConfig.mockResolvedValue(mockConfig);

      await program.parseAsync([
        'node', 'cli', 'saml', 'create-config',
        '--domain', 'acmecorp.com',
        '--slug', 'acmecorp',
        '--entity-id', 'https://idp.acmecorp.com/saml',
        '--sso-url', 'https://idp.acmecorp.com/sso',
        '--certificate', 'cert',
      ]);

      expect(sdkMock.saml.createConfig).toHaveBeenCalledWith(expect.objectContaining({
        domain: 'acmecorp.com',
        slug: 'acmecorp',
      }));
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('created');
    });

    it('should handle creation errors', async () => {
      sdkMock.saml.createConfig.mockRejectedValue(new Error('Slug already in use'));

      await program.parseAsync([
        'node', 'cli', 'saml', 'create-config',
        '--domain', 'acmecorp.com',
        '--slug', 'acmecorp',
        '--entity-id', 'e',
        '--sso-url', 's',
        '--certificate', 'c',
      ]);

      expect(process.exitCode).toBe(1);
    });
  });

  // ── update-config ─────────────────────────────────────────────────────────

  describe('saml update-config', () => {
    it('should update an SSO config', async () => {
      sdkMock.saml.updateConfig.mockResolvedValue({ ...mockConfig, ssoUrl: 'https://new.sso.url' });

      await program.parseAsync([
        'node', 'cli', 'saml', 'update-config', 'sso-1',
        '--sso-url', 'https://new.sso.url',
      ]);

      expect(sdkMock.saml.updateConfig).toHaveBeenCalledWith('sso-1', expect.objectContaining({ ssoUrl: 'https://new.sso.url' }));
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('updated');
    });

    it('should show error if no fields provided', async () => {
      await program.parseAsync(['node', 'cli', 'saml', 'update-config', 'sso-1']);

      expect(sdkMock.saml.updateConfig).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    });
  });

  // ── delete-config ─────────────────────────────────────────────────────────

  describe('saml delete-config', () => {
    it('should require --force flag', async () => {
      await program.parseAsync(['node', 'cli', 'saml', 'delete-config', 'sso-1']);

      expect(sdkMock.saml.deleteConfig).not.toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('--force');
    });

    it('should delete config with --force', async () => {
      sdkMock.saml.deleteConfig.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'saml', 'delete-config', 'sso-1', '--force']);

      expect(sdkMock.saml.deleteConfig).toHaveBeenCalledWith('sso-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('deleted');
    });
  });

  // ── metadata ──────────────────────────────────────────────────────────────

  describe('saml metadata', () => {
    it('should display SP metadata XML', async () => {
      sdkMock.saml.getMetadata.mockResolvedValue('<?xml version="1.0"?><EntityDescriptor/>');

      await program.parseAsync(['node', 'cli', 'saml', 'metadata', 'acmecorp']);

      expect(sdkMock.saml.getMetadata).toHaveBeenCalledWith('acmecorp');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('EntityDescriptor');
    });
  });

  // ── login-url ─────────────────────────────────────────────────────────────

  describe('saml login-url', () => {
    it('should display the login URL', async () => {
      sdkMock.saml.getLoginUrl.mockReturnValue('https://vault.example.com/api/v1/auth/saml/acmecorp/login');

      await program.parseAsync(['node', 'cli', 'saml', 'login-url', 'acmecorp']);

      expect(sdkMock.saml.getLoginUrl).toHaveBeenCalledWith('acmecorp');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('acmecorp/login');
    });
  });
});
