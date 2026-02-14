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
      console.log(chalk.green(`Set ${chalk.bold(key)} in profile ${chalk.bold(profile)}`));
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
        console.log(value);
      } else {
        console.log(chalk.yellow(`Key "${key}" not set in profile "${profile}"`));
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
        console.log(chalk.yellow(`Profile "${profile}" has no configuration values.`));
        return;
      }

      console.log(chalk.bold(`Profile: ${profile}\n`));
      for (const key of keys) {
        const value = profileConfig[key];
        // Mask API keys for display
        const display = key.toLowerCase().includes('key') && value
          ? value.slice(0, 12) + '...'
          : value;
        console.log(`  ${chalk.cyan(key)}: ${display}`);
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
      setActiveProfile(name);
      console.log(chalk.green(`Active profile set to ${chalk.bold(name)}`));
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
        console.log(chalk.yellow('No profiles configured.'));
        console.log(chalk.dim('Create one with: lsvault config set <key> <value> --profile <name>'));
        return;
      }

      console.log(chalk.bold('Available profiles:\n'));
      for (const name of profiles) {
        const marker = name === active ? chalk.green(' (active)') : '';
        console.log(`  ${chalk.cyan(name)}${marker}`);
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
        console.log(chalk.green(`Profile "${name}" deleted.`));
      } else {
        console.log(chalk.yellow(`Profile "${name}" not found.`));
      }
    });

  config
    .command('current')
    .description('Show the active profile name')
    .action(() => {
      const active = getActiveProfile();
      console.log(active);
    });
}
