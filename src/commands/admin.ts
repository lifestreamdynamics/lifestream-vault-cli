import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

export function registerAdminCommands(program: Command): void {
  const admin = program.command('admin').description('System administration (requires admin role)');

  // ── System Stats ────────────────────────────────────────────────────

  const stats = admin.command('stats').description('View system-wide statistics and metrics');

  const statsAction = async (_opts: Record<string, unknown>) => {
    const flags = resolveFlags(_opts);
    const out = createOutput(flags);
    out.startSpinner('Fetching system stats...');
    try {
      const client = getClient();
      const data = await client.admin.getStats();
      out.stopSpinner();
      out.record({
        totalUsers: data.totalUsers,
        activeUsers: data.activeUsers,
        totalVaults: data.totalVaults,
        totalDocuments: data.totalDocuments,
        totalStorageBytes: flags.output === 'text' ? formatBytes(data.totalStorageBytes) : data.totalStorageBytes,
      });
    } catch (err) {
      handleError(out, err, 'Failed to fetch system stats');
    }
  };

  addGlobalFlags(stats.command('overview')
    .description('Show system-wide statistics'))
    .action(statsAction);

  addGlobalFlags(stats)
    .action(statsAction);

  addGlobalFlags(stats.command('timeseries')
    .description('Show timeseries data for a metric')
    .requiredOption('--metric <metric>', 'Metric: signups, documents, or storage')
    .requiredOption('--period <period>', 'Period: 7d, 30d, or 90d'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching timeseries data...');
      try {
        const client = getClient();
        const data = await client.admin.getTimeseries(String(_opts.metric), String(_opts.period));
        out.stopSpinner();

        if (flags.output === 'text') {
          out.status(`${chalk.dim('Metric:')} ${data.metric}  ${chalk.dim('Period:')} ${data.period}`);
        }

        out.list(
          data.data.map((point: { date: string; value: number }) => ({
            date: point.date,
            value: point.value,
          })),
          {
            emptyMessage: 'No data points found.',
            columns: [
              { key: 'date', header: 'Date' },
              { key: 'value', header: 'Value' },
            ],
            textFn: (p) => {
              const bar = '#'.repeat(Math.min(Number(p.value), 50));
              return `  ${String(p.date)}  ${String(p.value).padStart(6)}  ${chalk.cyan(bar)}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch timeseries data');
      }
    });

  // ── User Management ─────────────────────────────────────────────────

  const users = admin.command('users').description('List, inspect, and update user accounts');

  addGlobalFlags(users.command('list')
    .description('List users')
    .option('--page <number>', 'Page number', parseInt)
    .option('--limit <number>', 'Results per page', parseInt)
    .option('--search <query>', 'Search by name or email')
    .option('--tier <tier>', 'Filter by tier (free, pro, business)'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching users...');
      try {
        const client = getClient();
        const result = await client.admin.listUsers({
          page: _opts.page as number | undefined,
          limit: _opts.limit as number | undefined,
          search: _opts.search as string | undefined,
          tier: _opts.tier as 'free' | 'pro' | 'business' | undefined,
        });
        out.stopSpinner();

        if (flags.output === 'text') {
          out.status(`${chalk.dim('Total:')} ${result.total}  ${chalk.dim('Page:')} ${result.page}  ${chalk.dim('Limit:')} ${result.limit}`);
        }

        out.list(
          result.users.map(u => ({
            email: u.email,
            id: u.id,
            name: u.name || '',
            role: u.role,
            subscriptionTier: u.subscriptionTier,
            isActive: u.isActive,
          })),
          {
            emptyMessage: 'No users found.',
            columns: [
              { key: 'email', header: 'Email' },
              { key: 'name', header: 'Name' },
              { key: 'role', header: 'Role' },
              { key: 'subscriptionTier', header: 'Tier' },
              { key: 'isActive', header: 'Active' },
            ],
            textFn: (u) => {
              const active = u.isActive ? chalk.green('active') : chalk.red('inactive');
              const name = u.name || chalk.dim('no name');
              return `  ${chalk.cyan(String(u.email))} ${chalk.dim(`(${String(u.id)})`)} -- ${name} -- ${chalk.magenta(String(u.role))} -- ${String(u.subscriptionTier)} -- ${active}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch users');
      }
    });

  addGlobalFlags(users.command('get')
    .description('Get user details')
    .argument('<userId>', 'User ID'))
    .action(async (userId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching user...');
      try {
        const client = getClient();
        const user = await client.admin.getUser(userId);
        out.stopSpinner();
        out.record({
          email: user.email,
          id: user.id,
          name: user.name,
          role: user.role,
          isActive: user.isActive,
          subscriptionTier: user.subscriptionTier,
          vaultCount: user.vaultCount,
          documentCount: user.documentCount,
          storageBytes: flags.output === 'text' ? formatBytes(user.storageBytes) : user.storageBytes,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch user');
      }
    });

  addGlobalFlags(users.command('update')
    .description('Update a user')
    .argument('<userId>', 'User ID')
    .option('--role <role>', 'Set role (user or admin)')
    .option('--active', 'Set user as active')
    .option('--inactive', 'Set user as inactive'))
    .action(async (userId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      const params: Record<string, unknown> = {};
      if (_opts.role) params.role = _opts.role;
      if (_opts.active) params.isActive = true;
      if (_opts.inactive) params.isActive = false;

      if (Object.keys(params).length === 0) {
        out.error('No updates specified. Use --role, --active, or --inactive.');
        process.exitCode = 2;
        return;
      }

      out.startSpinner('Updating user...');
      try {
        const client = getClient();
        const updated = await client.admin.updateUser(userId, params);
        out.success(`User updated: ${chalk.cyan(updated.email)} -- ${chalk.magenta(updated.role)} -- ${updated.isActive ? chalk.green('active') : chalk.red('inactive')}`, {
          email: updated.email,
          role: updated.role,
          isActive: updated.isActive,
        });
      } catch (err) {
        handleError(out, err, 'Failed to update user');
      }
    });

  // ── Activity ────────────────────────────────────────────────────────

  addGlobalFlags(admin.command('activity')
    .description('Show recent system-wide activity events')
    .option('--limit <number>', 'Number of entries (default: 20)', parseInt))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching activity...');
      try {
        const client = getClient();
        const activity = await client.admin.getActivity(_opts.limit as number | undefined);
        out.stopSpinner();
        out.list(
          activity.map(a => ({
            createdAt: a.createdAt,
            type: a.type,
            userId: a.userId,
            path: a.path || null,
          })),
          {
            emptyMessage: 'No recent activity.',
            columns: [
              { key: 'createdAt', header: 'Time' },
              { key: 'type', header: 'Type' },
              { key: 'userId', header: 'User' },
              { key: 'path', header: 'Path' },
            ],
            textFn: (a) => {
              const pathStr = a.path || chalk.dim('n/a');
              return `  ${String(a.createdAt)}  ${chalk.magenta(String(a.type).padEnd(8))}  ${chalk.dim(String(a.userId))}  ${pathStr}`;
            },
          },
        );
      } catch (err) {
        handleError(out, err, 'Failed to fetch activity');
      }
    });

  // ── Subscriptions ───────────────────────────────────────────────────

  addGlobalFlags(admin.command('subscriptions')
    .description('Show subscription tier distribution across all users'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching subscription summary...');
      try {
        const client = getClient();
        const summary = await client.admin.getSubscriptionSummary();
        out.stopSpinner();
        out.record({
          free: summary.free,
          pro: summary.pro,
          business: summary.business,
          total: summary.total,
        });
      } catch (err) {
        handleError(out, err, 'Failed to fetch subscription summary');
      }
    });

  // ── Health ──────────────────────────────────────────────────────────

  addGlobalFlags(admin.command('health')
    .description('Check database, Redis, and overall system health'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Checking system health...');
      try {
        const client = getClient();
        const health = await client.admin.getHealth();
        out.stopSpinner();
        out.record({
          status: health.status,
          database: health.database,
          redis: health.redis,
          uptime: flags.output === 'text' ? formatUptime(health.uptime) : health.uptime,
        });
      } catch (err) {
        handleError(out, err, 'Failed to check system health');
      }
    });
}
