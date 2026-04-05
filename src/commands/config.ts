import type { Command } from 'commander';
import chalk from 'chalk';
import {
  resolveProfileName,
  getActiveProfile,
  setActiveProfile,
  loadProfile,
  setProfileValue,
  getProfileValue,
  listProfiles,
  deleteProfile,
} from '../lib/profiles.js';

const SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i;

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Manage CLI configuration profiles')
    .addHelpText('after', `
EXAMPLES
  lsvault config set apiUrl https://api.example.com --profile prod
  lsvault config set apiKey lsv_k_abc123 --profile prod
  lsvault config get apiUrl --profile prod
  lsvault config list --profile prod
  lsvault config use prod
  lsvault config profiles`);

  config
    .command('set')
    .description('Set a configuration value in a profile')
    .argument('<key>', 'Configuration key (e.g., apiUrl, apiKey)')
    .argument('<value>', 'Configuration value')
    .option('-p, --profile <name>', 'Profile name (default: active profile)')
    .addHelpText('after', `
EXAMPLES
  lsvault config set apiUrl https://api.lifestream.com --profile prod
  lsvault config set apiKey lsv_k_prod... --profile prod
  lsvault config set apiUrl http://localhost:4660 --profile dev`)
    .action((key: string, value: string, opts: { profile?: string }) => {
      const profile = resolveProfileName(opts.profile);
      setProfileValue(profile, key, value);
      process.stdout.write(chalk.green(`Set ${chalk.bold(key)} in profile ${chalk.bold(profile)}`) + '\n');
    });

  config
    .command('get')
    .description('Get a configuration value from a profile')
    .argument('<key>', 'Configuration key to read')
    .option('-p, --profile <name>', 'Profile name (default: active profile)')
    .addHelpText('after', `
EXAMPLES
  lsvault config get apiUrl
  lsvault config get apiKey --profile prod`)
    .action((key: string, opts: { profile?: string }) => {
      const profile = resolveProfileName(opts.profile);
      const value = getProfileValue(profile, key);
      if (value !== undefined) {
        process.stdout.write(value + '\n');
      } else {
        process.stdout.write(chalk.yellow(`Key "${key}" not set in profile "${profile}"`) + '\n');
        process.exitCode = 1;
      }
    });

  config
    .command('list')
    .description('List all configuration values in a profile')
    .option('-p, --profile <name>', 'Profile name (default: active profile)')
    .addHelpText('after', `
EXAMPLES
  lsvault config list
  lsvault config list --profile prod`)
    .action((opts: { profile?: string }) => {
      const profile = resolveProfileName(opts.profile);
      const profileConfig = loadProfile(profile);
      const keys = Object.keys(profileConfig);

      if (keys.length === 0) {
        process.stdout.write(chalk.yellow(`Profile "${profile}" has no configuration values.`) + '\n');
        return;
      }

      process.stdout.write(chalk.bold(`Profile: ${profile}\n`) + '\n');
      for (const key of keys) {
        const value = profileConfig[key];
        // Mask sensitive values for display
        const display = SENSITIVE_KEY_PATTERN.test(key) && value
          ? value.slice(0, 12) + '...'
          : value;
        process.stdout.write(`  ${chalk.cyan(key)}: ${display}\n`);
      }
    });

  config
    .command('use')
    .description('Set the default active profile')
    .argument('<name>', 'Profile name to activate')
    .addHelpText('after', `
EXAMPLES
  lsvault config use prod
  lsvault config use dev`)
    .action((name: string) => {
      const profiles = listProfiles();
      if (!profiles.includes(name)) {
        process.stderr.write(chalk.red(`Profile '${name}' does not exist.`) + '\n');
        process.stderr.write(chalk.dim('Available profiles: ' + (profiles.length ? profiles.join(', ') : 'none')) + '\n');
        process.exitCode = 1;
        return;
      }
      setActiveProfile(name);
      process.stdout.write(chalk.green(`Active profile set to ${chalk.bold(name)}`) + '\n');
    });

  config
    .command('profiles')
    .description('List all available profiles')
    .addHelpText('after', `
EXAMPLES
  lsvault config profiles`)
    .action(() => {
      const profiles = listProfiles();
      const active = getActiveProfile();

      if (profiles.length === 0) {
        process.stdout.write(chalk.yellow('No profiles configured.') + '\n');
        process.stdout.write(chalk.dim('Create one with: lsvault config set <key> <value> --profile <name>') + '\n');
        return;
      }

      process.stdout.write(chalk.bold('Available profiles:\n') + '\n');
      for (const name of profiles) {
        const marker = name === active ? chalk.green(' (active)') : '';
        process.stdout.write(`  ${chalk.cyan(name)}${marker}\n`);
      }
    });

  config
    .command('delete')
    .description('Delete a configuration profile')
    .argument('<name>', 'Profile name to delete')
    .addHelpText('after', `
EXAMPLES
  lsvault config delete staging`)
    .action((name: string) => {
      if (deleteProfile(name)) {
        process.stdout.write(chalk.green(`Profile "${name}" deleted.`) + '\n');
      } else {
        process.stdout.write(chalk.yellow(`Profile "${name}" not found.`) + '\n');
      }
    });

  config
    .command('current')
    .description('Show the active profile name')
    .action(() => {
      const active = getActiveProfile();
      process.stdout.write(active + '\n');
    });
}
