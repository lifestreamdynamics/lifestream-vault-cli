#!/usr/bin/env node
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerVaultCommands } from './commands/vaults.js';
import { registerDocCommands } from './commands/docs.js';
import { registerSearchCommands } from './commands/search.js';

const program = new Command();
program
  .name('lsvault')
  .description('Lifestream Vault CLI')
  .version('0.1.0');

registerAuthCommands(program);
registerVaultCommands(program);
registerDocCommands(program);
registerSearchCommands(program);

program.parse();
