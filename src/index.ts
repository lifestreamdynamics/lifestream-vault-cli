#!/usr/bin/env node
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerVaultCommands } from './commands/vaults.js';
import { registerDocCommands } from './commands/docs.js';
import { registerSearchCommands } from './commands/search.js';
import { registerKeyCommands } from './commands/keys.js';
import { registerUserCommands } from './commands/user.js';
import { registerSubscriptionCommands } from './commands/subscription.js';
import { registerTeamCommands } from './commands/teams.js';
import { registerAuditCommands } from './commands/audit.js';
import { registerAdminCommands } from './commands/admin.js';
import { registerConnectorCommands } from './commands/connectors.js';
import { registerShareCommands } from './commands/shares.js';
import { registerPublishCommands } from './commands/publish.js';
import { registerHookCommands } from './commands/hooks.js';
import { registerWebhookCommands } from './commands/webhooks.js';
import { registerConfigCommands } from './commands/config.js';
import { registerSyncCommands } from './commands/sync.js';

const program = new Command();
program
  .name('lsvault')
  .description('Lifestream Vault CLI - manage vaults, documents, and settings')
  .version('0.1.0')
  .addHelpText('after', `
GETTING STARTED
  lsvault auth login --email <email>         Log in with email/password
  lsvault auth login --api-key <key>         Log in with an API key
  lsvault config use <profile>               Switch configuration profile

COMMON WORKFLOWS
  lsvault vaults list                        List your vaults
  lsvault docs list <vaultId>                List documents in a vault
  lsvault search <query>                     Search across documents
  lsvault docs get <vaultId> <path>          Print document content to stdout

CONFIGURATION
  lsvault config set <key> <value>           Set a config value
  lsvault config profiles                    List available profiles

LEARN MORE
  lsvault <command> --help                   Show help for a command
  lsvault <command> <subcommand> --help      Show help for a subcommand`);

registerAuthCommands(program);
registerVaultCommands(program);
registerDocCommands(program);
registerSearchCommands(program);
registerKeyCommands(program);
registerUserCommands(program);
registerSubscriptionCommands(program);
registerTeamCommands(program);
registerAuditCommands(program);
registerAdminCommands(program);
registerConnectorCommands(program);
registerShareCommands(program);
registerPublishCommands(program);
registerHookCommands(program);
registerWebhookCommands(program);
registerConfigCommands(program);
registerSyncCommands(program);

program.parse();
