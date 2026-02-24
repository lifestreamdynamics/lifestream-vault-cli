import type { Command } from 'commander';
import chalk from 'chalk';
import { getClientAsync } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

export function registerPluginCommands(program: Command): void {
  const plugins = program.command('plugins').description('Plugin/extension marketplace management');

  // ── list ──────────────────────────────────────────────────────────────────

  addGlobalFlags(plugins.command('list')
    .description('List all installed plugins'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Loading plugins...');
      try {
        const client = await getClientAsync();
        const list = await client.plugins.list();
        out.stopSpinner();
        if (list.length === 0 && flags.output !== 'json') {
          out.raw('No plugins installed.\n');
        } else {
          out.list(
            list.map((p) => ({
              pluginId: p.pluginId,
              version: p.version,
              enabled: p.enabled ? 'yes' : 'no',
              settings: Object.keys(p.settings).length > 0 ? JSON.stringify(p.settings) : '',
              installedAt: p.installedAt.slice(0, 10),
            })),
            {
              columns: [
                { key: 'pluginId', header: 'Plugin ID' },
                { key: 'version', header: 'Version' },
                { key: 'enabled', header: 'Enabled' },
                { key: 'installedAt', header: 'Installed' },
              ],
              textFn: (p) =>
                `${chalk.cyan(String(p.pluginId))}@${p.version} ${p.enabled === 'yes' ? chalk.green('enabled') : chalk.dim('disabled')} ${chalk.dim(String(p.installedAt))}`,
            },
          );
        }
      } catch (err) {
        handleError(out, err, 'Failed to list plugins');
      }
    });

  // ── install ───────────────────────────────────────────────────────────────

  addGlobalFlags(plugins.command('install')
    .description('Install a plugin from the marketplace')
    .requiredOption('--plugin-id <pluginId>', 'Plugin marketplace identifier (e.g. org/plugin-name)')
    .requiredOption('--version <version>', 'Version to install'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Installing plugin...');
      try {
        const client = await getClientAsync();
        const installed = await client.plugins.install({
          pluginId: _opts.pluginId as string,
          version: _opts.version as string,
        });
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(installed, null, 2) + '\n');
        } else {
          out.raw(chalk.green(`Plugin installed: ${installed.pluginId}@${installed.version}`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to install plugin');
      }
    });

  // ── uninstall ─────────────────────────────────────────────────────────────

  addGlobalFlags(plugins.command('uninstall')
    .description('Uninstall a plugin')
    .argument('<pluginId>', 'Plugin marketplace identifier')
    .option('--confirm', 'Skip confirmation prompt'))
    .action(async (pluginId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      if (!_opts.confirm) {
        out.raw(chalk.yellow(`Pass --confirm to uninstall plugin ${pluginId}.`) + '\n');
        return;
      }
      out.startSpinner('Uninstalling plugin...');
      try {
        const client = await getClientAsync();
        await client.plugins.uninstall(pluginId);
        out.stopSpinner();
        out.raw(chalk.green(`Plugin ${pluginId} uninstalled.`) + '\n');
      } catch (err) {
        handleError(out, err, 'Failed to uninstall plugin');
      }
    });

  // ── enable ────────────────────────────────────────────────────────────────

  addGlobalFlags(plugins.command('enable')
    .description('Enable a plugin')
    .argument('<pluginId>', 'Plugin marketplace identifier'))
    .action(async (pluginId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Enabling plugin...');
      try {
        const client = await getClientAsync();
        const updated = await client.plugins.enable(pluginId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.raw(chalk.green(`Plugin ${updated.pluginId} enabled.`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to enable plugin');
      }
    });

  // ── disable ───────────────────────────────────────────────────────────────

  addGlobalFlags(plugins.command('disable')
    .description('Disable a plugin')
    .argument('<pluginId>', 'Plugin marketplace identifier'))
    .action(async (pluginId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Disabling plugin...');
      try {
        const client = await getClientAsync();
        const updated = await client.plugins.disable(pluginId);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.raw(chalk.dim(`Plugin ${updated.pluginId} disabled.`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to disable plugin');
      }
    });

  // ── update-settings ───────────────────────────────────────────────────────

  addGlobalFlags(plugins.command('update-settings')
    .description('Update plugin-specific settings')
    .argument('<pluginId>', 'Plugin marketplace identifier')
    .requiredOption('--settings <json>', 'Settings as a JSON string (e.g. \'{"theme":"dark"}\')'))
    .action(async (pluginId: string, _opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);

      let settings: Record<string, unknown>;
      try {
        settings = JSON.parse(_opts.settings as string) as Record<string, unknown>;
      } catch {
        out.error('Invalid JSON for --settings. Provide a valid JSON object.');
        process.exitCode = 2;
        return;
      }

      out.startSpinner('Updating plugin settings...');
      try {
        const client = await getClientAsync();
        const updated = await client.plugins.updateSettings(pluginId, settings);
        out.stopSpinner();
        if (flags.output === 'json') {
          out.raw(JSON.stringify(updated, null, 2) + '\n');
        } else {
          out.raw(chalk.green(`Settings updated for ${updated.pluginId}.`) + '\n');
        }
      } catch (err) {
        handleError(out, err, 'Failed to update plugin settings');
      }
    });
}
