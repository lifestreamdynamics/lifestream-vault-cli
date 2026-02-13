import { LifestreamVaultClient } from '@lifestream-vault/sdk';
import { loadConfig } from './config.js';
import chalk from 'chalk';

export function getClient(): LifestreamVaultClient {
  const config = loadConfig();

  if (!config.apiKey) {
    console.error(chalk.red('No API key configured.'));
    console.error('Run: lsvault auth login --api-key <key>');
    console.error('Or set LSVAULT_API_KEY environment variable');
    process.exit(1);
  }

  return new LifestreamVaultClient({
    baseUrl: config.apiUrl,
    apiKey: config.apiKey,
  });
}
