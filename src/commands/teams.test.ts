import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerTeamCommands } from './teams.js';
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

describe('teams commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerTeamCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  // ── Team CRUD ──────────────────────────────────────────────────────

  describe('teams list', () => {
    it('should list teams', async () => {
      sdkMock.teams.list.mockResolvedValue([
        { id: 't1', name: 'Engineering', description: 'Eng team', ownerId: 'u1', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 't2', name: 'Design', description: null, ownerId: 'u2', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ]);

      await program.parseAsync(['node', 'cli', 'teams', 'list']);

      expect(sdkMock.teams.list).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Engineering');
      expect(stdout).toContain('Eng team');
      expect(stdout).toContain('No description');
    });

    it('should show message when no teams exist', async () => {
      sdkMock.teams.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'teams', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No teams found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.teams.list.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'teams', 'list']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('teams get', () => {
    it('should display team details', async () => {
      sdkMock.teams.get.mockResolvedValue({
        id: 't1', name: 'Engineering', description: 'Eng team', ownerId: 'u1', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-06-15T12:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'teams', 'get', 't1']);

      expect(sdkMock.teams.get).toHaveBeenCalledWith('t1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Engineering');
      expect(stdout).toContain('t1');
      expect(stdout).toContain('u1');
      expect(stdout).toContain('Eng team');
    });

    it('should handle missing description', async () => {
      sdkMock.teams.get.mockResolvedValue({
        id: 't1', name: 'Empty', description: null, ownerId: 'u1', createdAt: '2024-01-01', updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'teams', 'get', 't1']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('none');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.teams.get.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'teams', 'get', 't1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('teams create', () => {
    it('should create a team with name only', async () => {
      sdkMock.teams.create.mockResolvedValue({
        id: 't1', name: 'New Team', description: null, ownerId: 'u1', createdAt: '2024-01-01', updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'teams', 'create', 'New Team']);

      expect(sdkMock.teams.create).toHaveBeenCalledWith({ name: 'New Team', description: undefined });
    });

    it('should create a team with description', async () => {
      sdkMock.teams.create.mockResolvedValue({
        id: 't1', name: 'Work', description: 'Work team', ownerId: 'u1', createdAt: '2024-01-01', updatedAt: '2024-01-01',
      });

      await program.parseAsync(['node', 'cli', 'teams', 'create', 'Work', '-d', 'Work team']);

      expect(sdkMock.teams.create).toHaveBeenCalledWith({ name: 'Work', description: 'Work team' });
    });

    it('should handle creation errors', async () => {
      sdkMock.teams.create.mockRejectedValue(new Error('Validation failed'));

      await program.parseAsync(['node', 'cli', 'teams', 'create', 'Bad']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Validation failed');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('teams update', () => {
    it('should update team name', async () => {
      sdkMock.teams.update.mockResolvedValue({
        id: 't1', name: 'Updated', description: null, ownerId: 'u1', createdAt: '2024-01-01', updatedAt: '2024-01-02',
      });

      await program.parseAsync(['node', 'cli', 'teams', 'update', 't1', '--name', 'Updated']);

      expect(sdkMock.teams.update).toHaveBeenCalledWith('t1', { name: 'Updated' });
    });

    it('should handle update errors', async () => {
      sdkMock.teams.update.mockRejectedValue(new Error('Forbidden'));

      await program.parseAsync(['node', 'cli', 'teams', 'update', 't1', '--name', 'X']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Forbidden');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('teams delete', () => {
    it('should delete a team', async () => {
      sdkMock.teams.delete.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'teams', 'delete', 't1']);

      expect(sdkMock.teams.delete).toHaveBeenCalledWith('t1');
    });

    it('should handle deletion errors', async () => {
      sdkMock.teams.delete.mockRejectedValue(new Error('Not owner'));

      await program.parseAsync(['node', 'cli', 'teams', 'delete', 't1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not owner');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Members ────────────────────────────────────────────────────────

  describe('teams members list', () => {
    it('should list team members', async () => {
      sdkMock.teams.listMembers.mockResolvedValue([
        { id: 'm1', teamId: 't1', userId: 'u1', role: 'owner', joinedAt: '2024-01-01', user: { id: 'u1', email: 'owner@test.com', name: 'Owner' } },
        { id: 'm2', teamId: 't1', userId: 'u2', role: 'member', joinedAt: '2024-01-02', user: { id: 'u2', email: 'member@test.com', name: null } },
      ]);

      await program.parseAsync(['node', 'cli', 'teams', 'members', 'list', 't1']);

      expect(sdkMock.teams.listMembers).toHaveBeenCalledWith('t1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Owner');
      expect(stdout).toContain('owner');
      expect(stdout).toContain('member@test.com');
    });

    it('should show message when no members found', async () => {
      sdkMock.teams.listMembers.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'teams', 'members', 'list', 't1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No members found');
    });
  });

  describe('teams members update', () => {
    it('should update a member role', async () => {
      sdkMock.teams.updateMemberRole.mockResolvedValue({
        id: 'm2', teamId: 't1', userId: 'u2', role: 'admin', joinedAt: '2024-01-02', user: { id: 'u2', email: 'user@test.com', name: 'User' },
      });

      await program.parseAsync(['node', 'cli', 'teams', 'members', 'update', 't1', 'u2', '--role', 'admin']);

      expect(sdkMock.teams.updateMemberRole).toHaveBeenCalledWith('t1', 'u2', 'admin');
    });

    it('should handle update errors', async () => {
      sdkMock.teams.updateMemberRole.mockRejectedValue(new Error('Cannot change owner'));

      await program.parseAsync(['node', 'cli', 'teams', 'members', 'update', 't1', 'u1', '--role', 'member']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Cannot change owner');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('teams members remove', () => {
    it('should remove a member', async () => {
      sdkMock.teams.removeMember.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'teams', 'members', 'remove', 't1', 'u2']);

      expect(sdkMock.teams.removeMember).toHaveBeenCalledWith('t1', 'u2');
    });

    it('should handle removal errors', async () => {
      sdkMock.teams.removeMember.mockRejectedValue(new Error('Cannot remove owner'));

      await program.parseAsync(['node', 'cli', 'teams', 'members', 'remove', 't1', 'u1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Cannot remove owner');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('teams leave', () => {
    it('should leave a team', async () => {
      sdkMock.teams.leave.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'teams', 'leave', 't1']);

      expect(sdkMock.teams.leave).toHaveBeenCalledWith('t1');
    });

    it('should handle leave errors', async () => {
      sdkMock.teams.leave.mockRejectedValue(new Error('Owner cannot leave'));

      await program.parseAsync(['node', 'cli', 'teams', 'leave', 't1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Owner cannot leave');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Invitations ────────────────────────────────────────────────────

  describe('teams invitations list', () => {
    it('should list pending invitations', async () => {
      sdkMock.teams.listInvitations.mockResolvedValue([
        { id: 'inv1', teamId: 't1', email: 'pending@test.com', role: 'member', invitedBy: 'u1', createdAt: '2024-01-01', expiresAt: '2024-01-08' },
      ]);

      await program.parseAsync(['node', 'cli', 'teams', 'invitations', 'list', 't1']);

      expect(sdkMock.teams.listInvitations).toHaveBeenCalledWith('t1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('pending@test.com');
      expect(stdout).toContain('member');
    });

    it('should show message when no invitations', async () => {
      sdkMock.teams.listInvitations.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'teams', 'invitations', 'list', 't1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No pending invitations');
    });
  });

  describe('teams invitations create', () => {
    it('should invite a member', async () => {
      sdkMock.teams.inviteMember.mockResolvedValue({
        id: 'inv1', teamId: 't1', email: 'new@test.com', role: 'member', invitedBy: 'u1', createdAt: '2024-01-01', expiresAt: '2024-01-08',
      });

      await program.parseAsync(['node', 'cli', 'teams', 'invitations', 'create', 't1', 'new@test.com', '--role', 'member']);

      expect(sdkMock.teams.inviteMember).toHaveBeenCalledWith('t1', 'new@test.com', 'member');
    });

    it('should handle invitation errors', async () => {
      sdkMock.teams.inviteMember.mockRejectedValue(new Error('Already a member'));

      await program.parseAsync(['node', 'cli', 'teams', 'invitations', 'create', 't1', 'existing@test.com', '--role', 'admin']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Already a member');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('teams invitations revoke', () => {
    it('should revoke an invitation', async () => {
      sdkMock.teams.revokeInvitation.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'cli', 'teams', 'invitations', 'revoke', 't1', 'inv1']);

      expect(sdkMock.teams.revokeInvitation).toHaveBeenCalledWith('t1', 'inv1');
    });

    it('should handle revocation errors', async () => {
      sdkMock.teams.revokeInvitation.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'teams', 'invitations', 'revoke', 't1', 'inv1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Not found');
      expect(process.exitCode).toBe(1);
    });
  });

  // ── Team Vaults ────────────────────────────────────────────────────

  describe('teams vaults list', () => {
    it('should list team vaults', async () => {
      sdkMock.teams.listVaults.mockResolvedValue([
        { id: 'v1', name: 'Shared Docs', slug: 'shared-docs', description: 'Team docs' },
      ]);

      await program.parseAsync(['node', 'cli', 'teams', 'vaults', 'list', 't1']);

      expect(sdkMock.teams.listVaults).toHaveBeenCalledWith('t1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Shared Docs');
    });

    it('should show message when no vaults', async () => {
      sdkMock.teams.listVaults.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'teams', 'vaults', 'list', 't1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No team vaults found');
    });
  });

  describe('teams vaults create', () => {
    it('should create a team vault', async () => {
      sdkMock.teams.createVault.mockResolvedValue({
        id: 'v1', name: 'Wiki', slug: 'wiki', description: null,
      });

      await program.parseAsync(['node', 'cli', 'teams', 'vaults', 'create', 't1', 'Wiki']);

      expect(sdkMock.teams.createVault).toHaveBeenCalledWith('t1', { name: 'Wiki', description: undefined });
    });

    it('should create a team vault with description', async () => {
      sdkMock.teams.createVault.mockResolvedValue({
        id: 'v1', name: 'Docs', slug: 'docs', description: 'Documentation',
      });

      await program.parseAsync(['node', 'cli', 'teams', 'vaults', 'create', 't1', 'Docs', '-d', 'Documentation']);

      expect(sdkMock.teams.createVault).toHaveBeenCalledWith('t1', { name: 'Docs', description: 'Documentation' });
    });

    it('should handle creation errors', async () => {
      sdkMock.teams.createVault.mockRejectedValue(new Error('Slug conflict'));

      await program.parseAsync(['node', 'cli', 'teams', 'vaults', 'create', 't1', 'Existing']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Slug conflict');
      expect(process.exitCode).toBe(1);
    });
  });
});
