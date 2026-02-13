import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig } from '../config.js';

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication commands');

  auth.command('login')
    .description('Configure API key')
    .option('--api-key <key>', 'API key')
    .option('--api-url <url>', 'API URL')
    .action(async (opts: { apiKey?: string; apiUrl?: string }) => {
      if (opts.apiKey) {
        saveConfig({ apiKey: opts.apiKey });
        console.log(chalk.green('API key saved.'));
      }
      if (opts.apiUrl) {
        saveConfig({ apiUrl: opts.apiUrl });
        console.log(chalk.green(`API URL set to ${opts.apiUrl}`));
      }
      if (!opts.apiKey && !opts.apiUrl) {
        console.log('Usage: lsvault auth login --api-key <key> [--api-url <url>]');
      }
    });

  auth.command('whoami')
    .description('Show current configuration')
    .action(async () => {
      const config = loadConfig();
      console.log(`API URL: ${config.apiUrl}`);
      console.log(`API Key: ${config.apiKey ? config.apiKey.slice(0, 12) + '...' : chalk.yellow('not set')}`);
    });
}
