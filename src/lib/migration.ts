import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import type { CliConfig } from '../config.js';
import type { CredentialManager } from './credential-manager.js';

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface MigrationResult {
  migrated: boolean;
  method: string;
  error?: string;
}

/**
 * Checks if plaintext config contains an API key that should be migrated.
 */
export function hasPlaintextCredentials(): boolean {
  if (!fs.existsSync(CONFIG_FILE)) return false;

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw);
    return typeof config.apiKey === 'string' && config.apiKey.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads the plaintext config file.
 */
export function readPlaintextConfig(): Partial<CliConfig> {
  if (!fs.existsSync(CONFIG_FILE)) return {};

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Removes the apiKey from the plaintext config, keeping other fields (apiUrl).
 */
export function removePlaintextApiKey(): void {
  if (!fs.existsSync(CONFIG_FILE)) return;

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(raw);
    delete config.apiKey;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  } catch {
    // ignore errors
  }
}

/**
 * Migrates credentials from plaintext config to secure storage.
 */
export async function migrateCredentials(
  credentialManager: CredentialManager,
  promptFn?: () => Promise<boolean>,
): Promise<MigrationResult> {
  if (!hasPlaintextCredentials()) {
    return { migrated: false, method: 'none', error: 'No plaintext credentials found' };
  }

  // Ask user for confirmation if prompt function provided
  if (promptFn) {
    const confirmed = await promptFn();
    if (!confirmed) {
      return { migrated: false, method: 'skipped' };
    }
  }

  const plaintextConfig = readPlaintextConfig();

  try {
    await credentialManager.saveCredentials({
      apiKey: plaintextConfig.apiKey,
    });

    // Remove apiKey from plaintext config
    removePlaintextApiKey();

    const method = await credentialManager.getStorageMethod();

    return { migrated: true, method };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { migrated: false, method: 'error', error: message };
  }
}

/**
 * Prints migration warnings if plaintext credentials are detected.
 * Returns true if migration was performed.
 */
export async function checkAndPromptMigration(
  credentialManager: CredentialManager,
): Promise<boolean> {
  if (!hasPlaintextCredentials()) return false;

  console.log(chalk.yellow('\nWarning: API key found in plaintext config (~/.lsvault/config.json)'));
  console.log(chalk.yellow('Run `lsvault auth migrate` to migrate to secure storage.\n'));

  return false;
}

export { CONFIG_FILE, CONFIG_DIR };
