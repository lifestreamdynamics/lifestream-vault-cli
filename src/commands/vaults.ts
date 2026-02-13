import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getClient } from '../client.js';

export function registerVaultCommands(program: Command): void {
  const vaults = program.command('vaults').description('Vault operations');

  vaults.command('list')
    .description('List all vaults')
    .action(async () => {
      const spinner = ora('Fetching vaults...').start();
      try {
        const client = getClient();
        const vaultList = await client.vaults.list();
        spinner.stop();
        if (vaultList.length === 0) {
          console.log(chalk.yellow('No vaults found.'));
          return;
        }
        for (const v of vaultList) {
          console.log(`${chalk.cyan(v.name)} ${chalk.dim(`(${v.slug})`)} -- ${v.description || 'No description'}`);
        }
      } catch (err) {
        spinner.fail('Failed to fetch vaults');
        console.error(err instanceof Error ? err.message : err);
      }
    });

  vaults.command('get')
    .description('Get vault details')
    .argument('<vaultId>', 'Vault ID')
    .action(async (vaultId: string) => {
      const spinner = ora('Fetching vault...').start();
      try {
        const client = getClient();
        const vault = await client.vaults.get(vaultId);
        spinner.stop();
        console.log(`Name:        ${chalk.cyan(vault.name)}`);
        console.log(`Slug:        ${vault.slug}`);
        console.log(`ID:          ${vault.id}`);
        console.log(`Description: ${vault.description || chalk.dim('none')}`);
        console.log(`Created:     ${vault.createdAt}`);
        console.log(`Updated:     ${vault.updatedAt}`);
      } catch (err) {
        spinner.fail('Failed to fetch vault');
        console.error(err instanceof Error ? err.message : err);
      }
    });

  vaults.command('create')
    .description('Create a vault')
    .argument('<name>', 'Vault name')
    .option('-d, --description <desc>', 'Description')
    .action(async (name: string, opts: { description?: string }) => {
      const spinner = ora('Creating vault...').start();
      try {
        const client = getClient();
        const vault = await client.vaults.create({ name, description: opts.description });
        spinner.succeed(`Vault created: ${chalk.cyan(vault.name)} (${vault.slug})`);
      } catch (err) {
        spinner.fail('Failed to create vault');
        console.error(err instanceof Error ? err.message : err);
      }
    });
}
