import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerTeamCommands(program: Command): void {
  const teams = program.command('teams').description('Manage teams, members, invitations, and shared vaults');

  // ── Team CRUD ──────────────────────────────────────────────────────

  addGlobalFlags(teams.command('list')
    .description('List all teams you belong to'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching teams...');
      try {
        const client = await getClientAsync();
        const teamList = await client.teams.list();
        out.stopSpinner();
        out.list(
          teamList.map(t => ({ name: t.name, id: t.id, description: t.description || 'No description' })),
          {
            emptyMessage: 'No teams found.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'id', header: 'ID' },
              { key: 'description', header: 'Description' },
            ],
            textFn: (t) => `${chalk.cyan(String(t.name))} ${chalk.dim(`(${String(t.id)})`)} -- ${String(t.description)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch teams');
      }
    });

  addGlobalFlags(teams.command('get')
    .description('Show detailed information about a team')
    .argument('<teamId>', 'Team ID'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching team...');
      try {
        const client = await getClientAsync();
        const team = await client.teams.get(teamId);
        out.stopSpinner();
        out.record({
          name: team.name,
          id: team.id,
          ownerId: team.ownerId,
          description: team.description,
          createdAt: team.createdAt,
          updatedAt: team.updatedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch team');
      }
    });

  addGlobalFlags(teams.command('create')
    .description('Create a new team workspace')
    .argument('<name>', 'Team name')
    .option('-d, --description <desc>', 'Team description')
    .addHelpText('after', `
EXAMPLES
  lsvault teams create "Engineering" --description "Dev team workspace"
  lsvault teams create "Marketing"`))
    .action(async (name: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating team...');
      try {
        const client = await getClientAsync();
        const team = await client.teams.create({ name, description: _opts.description as string | undefined });
        out.success(`Team created: ${chalk.cyan(team.name)} (${team.id})`, { id: team.id, name: team.name });
      } catch (err) {
        handleError(out, err, 'Failed to create team');
      }
    });

  addGlobalFlags(teams.command('update')
    .description('Update a team')
    .argument('<teamId>', 'Team ID')
    .option('-n, --name <name>', 'New team name')
    .option('-d, --description <desc>', 'New description'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Updating team...');
      try {
        const client = await getClientAsync();
        const team = await client.teams.update(teamId, {
          name: _opts.name as string | undefined,
          description: _opts.description as string | undefined,
        });
        out.success(`Team updated: ${chalk.cyan(team.name)}`, { id: team.id, name: team.name });
      } catch (err) {
        handleError(out, err, 'Failed to update team');
      }
    });

  addGlobalFlags(teams.command('delete')
    .description('Permanently delete a team and all its data')
    .argument('<teamId>', 'Team ID'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Deleting team...');
      try {
        const client = await getClientAsync();
        await client.teams.delete(teamId);
        out.success('Team deleted.', { id: teamId, deleted: true });
      } catch (err) {
        handleError(out, err, 'Failed to delete team');
      }
    });

  // ── Members ────────────────────────────────────────────────────────

  const members = teams.command('members').description('List, update roles, and remove team members');

  addGlobalFlags(members.command('list')
    .description('List team members')
    .argument('<teamId>', 'Team ID'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching members...');
      try {
        const client = await getClientAsync();
        const memberList = await client.teams.listMembers(teamId);
        out.stopSpinner();
        out.list(
          memberList.map(m => ({
            name: m.user.name || m.user.email,
            userId: m.userId,
            role: m.role,
            email: m.user.email,
          })),
          {
            emptyMessage: 'No members found.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'email', header: 'Email' },
              { key: 'role', header: 'Role' },
            ],
            textFn: (m) => `${chalk.cyan(String(m.name))} ${chalk.dim(`(${String(m.userId)})`)} -- ${chalk.magenta(String(m.role))}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch members');
      }
    });

  addGlobalFlags(members.command('update')
    .description('Update a member role')
    .argument('<teamId>', 'Team ID')
    .argument('<userId>', 'User ID')
    .requiredOption('-r, --role <role>', 'New role (admin or member)'))
    .action(async (teamId: string, userId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const role = String(_opts.role) as 'admin' | 'member';
      out.startSpinner('Updating member role...');
      try {
        const client = await getClientAsync();
        const member = await client.teams.updateMemberRole(teamId, userId, role);
        out.success(`Role updated to ${chalk.magenta(member.role)} for ${member.user.email}`, {
          userId,
          role: member.role,
          email: member.user.email,
        });
      } catch (err) {
        handleError(out, err, 'Failed to update member role');
      }
    });

  addGlobalFlags(members.command('remove')
    .description('Remove a member from the team')
    .argument('<teamId>', 'Team ID')
    .argument('<userId>', 'User ID'))
    .action(async (teamId: string, userId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Removing member...');
      try {
        const client = await getClientAsync();
        await client.teams.removeMember(teamId, userId);
        out.success('Member removed.', { teamId, userId, removed: true });
      } catch (err) {
        handleError(out, err, 'Failed to remove member');
      }
    });

  addGlobalFlags(teams.command('leave')
    .description('Leave a team')
    .argument('<teamId>', 'Team ID'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Leaving team...');
      try {
        const client = await getClientAsync();
        await client.teams.leave(teamId);
        out.success('Left the team.', { teamId, left: true });
      } catch (err) {
        handleError(out, err, 'Failed to leave team');
      }
    });

  // ── Invitations ────────────────────────────────────────────────────

  const invitations = teams.command('invitations').description('Send, list, and revoke team invitations');

  addGlobalFlags(invitations.command('list')
    .description('List pending invitations')
    .argument('<teamId>', 'Team ID'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching invitations...');
      try {
        const client = await getClientAsync();
        const invitationList = await client.teams.listInvitations(teamId);
        out.stopSpinner();
        out.list(
          invitationList.map(inv => ({
            email: inv.email,
            id: inv.id,
            role: inv.role,
            expiresAt: inv.expiresAt,
          })),
          {
            emptyMessage: 'No pending invitations.',
            columns: [
              { key: 'email', header: 'Email' },
              { key: 'role', header: 'Role' },
              { key: 'expiresAt', header: 'Expires' },
            ],
            textFn: (inv) => `${chalk.cyan(String(inv.email))} ${chalk.dim(`(${String(inv.id)})`)} -- ${chalk.magenta(String(inv.role))} -- expires ${String(inv.expiresAt)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch invitations');
      }
    });

  addGlobalFlags(invitations.command('create')
    .description('Invite a user to the team')
    .argument('<teamId>', 'Team ID')
    .argument('<email>', 'Email address')
    .requiredOption('-r, --role <role>', 'Role (admin or member)'))
    .action(async (teamId: string, email: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      const role = String(_opts.role) as 'admin' | 'member';
      out.startSpinner('Sending invitation...');
      try {
        const client = await getClientAsync();
        const invitation = await client.teams.inviteMember(teamId, email, role);
        out.success(`Invited ${chalk.cyan(invitation.email)} as ${chalk.magenta(invitation.role)}`, {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
        });
      } catch (err) {
        handleError(out, err, 'Failed to send invitation');
      }
    });

  addGlobalFlags(invitations.command('revoke')
    .description('Revoke a pending invitation')
    .argument('<teamId>', 'Team ID')
    .argument('<invitationId>', 'Invitation ID'))
    .action(async (teamId: string, invitationId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Revoking invitation...');
      try {
        const client = await getClientAsync();
        await client.teams.revokeInvitation(teamId, invitationId);
        out.success('Invitation revoked.', { id: invitationId, revoked: true });
      } catch (err) {
        handleError(out, err, 'Failed to revoke invitation');
      }
    });

  // ── Team Vaults ────────────────────────────────────────────────────

  const vaults = teams.command('vaults').description('Manage shared vaults within a team');

  addGlobalFlags(vaults.command('list')
    .description('List team vaults')
    .argument('<teamId>', 'Team ID'))
    .action(async (teamId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching team vaults...');
      try {
        const client = await getClientAsync();
        const vaultList = await client.teams.listVaults(teamId);
        out.stopSpinner();
        out.list(
          vaultList.map(v => ({ name: String(v.name), slug: String(v.slug), description: String(v.description) || 'No description' })),
          {
            emptyMessage: 'No team vaults found.',
            columns: [
              { key: 'name', header: 'Name' },
              { key: 'slug', header: 'Slug' },
              { key: 'description', header: 'Description' },
            ],
            textFn: (v) => `${chalk.cyan(String(v.name))} ${chalk.dim(`(${String(v.slug)})`)} -- ${String(v.description)}`,
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch team vaults');
      }
    });

  addGlobalFlags(vaults.command('create')
    .description('Create a team vault')
    .argument('<teamId>', 'Team ID')
    .argument('<name>', 'Vault name')
    .option('-d, --description <desc>', 'Description'))
    .action(async (teamId: string, name: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Creating team vault...');
      try {
        const client = await getClientAsync();
        const vault = await client.teams.createVault(teamId, { name, description: _opts.description as string | undefined });
        out.success(`Team vault created: ${chalk.cyan(String(vault.name))}`, {
          name: String(vault.name),
          slug: String(vault.slug),
        });
      } catch (err) {
        handleError(out, err, 'Failed to create team vault');
      }
    });
}
