import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerScimCommands } from './scim.js';
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

describe('scim commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  const mockUser = {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: 'user-1',
    userName: 'alice@acmecorp.com',
    name: { formatted: 'Alice Smith', givenName: 'Alice', familyName: 'Smith' },
    emails: [{ value: 'alice@acmecorp.com', primary: true }],
    active: true,
    meta: {
      resourceType: 'User',
      created: '2026-01-01T00:00:00.000Z',
      lastModified: '2026-01-01T00:00:00.000Z',
      location: '/api/v1/scim/v2/Users/user-1',
    },
  };

  const mockListResponse = {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 100,
    Resources: [mockUser],
  };

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerScimCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  // ── list-users ────────────────────────────────────────────────────────────

  describe('scim list-users', () => {
    it('should list SCIM users', async () => {
      sdkMock.scim.listUsers.mockResolvedValue(mockListResponse);

      await program.parseAsync(['node', 'cli', 'scim', 'list-users']);

      expect(sdkMock.scim.listUsers).toHaveBeenCalledWith(expect.objectContaining({}));
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('alice@acmecorp.com');
    });

    it('should show error when scim is not configured', async () => {
      (sdkMock as any).scim = null;

      await program.parseAsync(['node', 'cli', 'scim', 'list-users']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('SCIM resource is not configured');
      expect(process.exitCode).toBe(1);
    });

    it('should handle list errors', async () => {
      sdkMock.scim.listUsers.mockRejectedValue(new Error('Invalid SCIM token'));

      await program.parseAsync(['node', 'cli', 'scim', 'list-users']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Invalid SCIM token');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── get-user ──────────────────────────────────────────────────────────────

  describe('scim get-user', () => {
    it('should display user details', async () => {
      sdkMock.scim.getUser.mockResolvedValue(mockUser);

      await program.parseAsync(['node', 'cli', 'scim', 'get-user', 'user-1']);

      expect(sdkMock.scim.getUser).toHaveBeenCalledWith('user-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('alice@acmecorp.com');
    });

    it('should handle not found error', async () => {
      sdkMock.scim.getUser.mockRejectedValue(new Error('User not found'));

      await program.parseAsync(['node', 'cli', 'scim', 'get-user', 'nonexistent']);

      expect(process.exitCode).toBe(1);
    });
  });

  // ── create-user ───────────────────────────────────────────────────────────

  describe('scim create-user', () => {
    it('should create a SCIM user', async () => {
      sdkMock.scim.createUser.mockResolvedValue(mockUser);

      await program.parseAsync([
        'node', 'cli', 'scim', 'create-user',
        '--user-name', 'alice@acmecorp.com',
        '--email', 'alice@acmecorp.com',
        '--given-name', 'Alice',
        '--family-name', 'Smith',
      ]);

      expect(sdkMock.scim.createUser).toHaveBeenCalledWith(expect.objectContaining({
        userName: 'alice@acmecorp.com',
      }));
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('created');
    });

    it('should handle creation errors', async () => {
      sdkMock.scim.createUser.mockRejectedValue(new Error('User already exists'));

      await program.parseAsync([
        'node', 'cli', 'scim', 'create-user',
        '--user-name', 'alice@acmecorp.com',
        '--email', 'alice@acmecorp.com',
      ]);

      expect(process.exitCode).toBe(1);
    });
  });

  // ── update-user ───────────────────────────────────────────────────────────

  describe('scim update-user', () => {
    it('should update a SCIM user', async () => {
      sdkMock.scim.updateUser.mockResolvedValue(mockUser);

      await program.parseAsync([
        'node', 'cli', 'scim', 'update-user', 'user-1',
        '--family-name', 'Jones',
      ]);

      expect(sdkMock.scim.updateUser).toHaveBeenCalledWith('user-1', expect.objectContaining({
        name: expect.objectContaining({ familyName: 'Jones' }),
      }));
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('updated');
    });

    it('should show error if no fields provided', async () => {
      await program.parseAsync(['node', 'cli', 'scim', 'update-user', 'user-1']);

      expect(sdkMock.scim.updateUser).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    });
  });

  // ── delete-user ───────────────────────────────────────────────────────────

  describe('scim delete-user', () => {
    it('should require --force flag', async () => {
      await program.parseAsync(['node', 'cli', 'scim', 'delete-user', 'user-1']);

      expect(sdkMock.scim.deleteUser).not.toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('--force');
    });

    it('should delete user with --force', async () => {
      sdkMock.scim.deleteUser.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'scim', 'delete-user', 'user-1', '--force']);

      expect(sdkMock.scim.deleteUser).toHaveBeenCalledWith('user-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('deprovisioned');
    });
  });

  // ── service-config ────────────────────────────────────────────────────────

  describe('scim service-config', () => {
    it('should display SCIM service provider config', async () => {
      sdkMock.scim.getServiceProviderConfig.mockResolvedValue({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: false },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 100 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [],
      });

      await program.parseAsync(['node', 'cli', 'scim', 'service-config']);

      expect(sdkMock.scim.getServiceProviderConfig).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('100');
    });
  });
});
