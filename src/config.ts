import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCredentialManager, type CredentialManager } from './lib/credential-manager.js';

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  apiUrl: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
}

// Singleton credential manager
let _credentialManager: CredentialManager | undefined;

export function getCredentialManager(): CredentialManager {
  if (!_credentialManager) {
    _credentialManager = createCredentialManager();
  }
  return _credentialManager;
}

/**
 * Sets the credential manager instance (for testing).
 */
export function setCredentialManager(cm: CredentialManager): void {
  _credentialManager = cm;
}

/**
 * Loads config synchronously from env vars and plaintext config file.
 * This is the legacy loader — still used by commands that need sync access.
 * For secure credential loading, use loadConfigAsync().
 */
export function loadConfig(): CliConfig {
  const config: CliConfig = {
    apiUrl: process.env.LSVAULT_API_URL || 'http://localhost:4660',
  };

  if (process.env.LSVAULT_API_KEY) {
    config.apiKey = process.env.LSVAULT_API_KEY;
  }

  // Read config file if it exists
  if (fs.existsSync(CONFIG_FILE)) {
    const fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (fileConfig.apiUrl) config.apiUrl = fileConfig.apiUrl;
    if (fileConfig.apiKey && !config.apiKey) config.apiKey = fileConfig.apiKey;
  }

  return config;
}

/**
 * Loads config with secure credential resolution.
 * Priority: env vars > keychain > encrypted config > plaintext config (deprecated).
 */
export async function loadConfigAsync(): Promise<CliConfig> {
  const cm = getCredentialManager();
  const secureCreds = await cm.getCredentials();

  const config: CliConfig = {
    apiUrl: secureCreds.apiUrl || process.env.LSVAULT_API_URL || 'http://localhost:4660',
  };

  // Load JWT tokens if available
  if (secureCreds.accessToken) {
    config.accessToken = secureCreds.accessToken;
  }
  if (secureCreds.refreshToken) {
    config.refreshToken = secureCreds.refreshToken;
  }

  if (secureCreds.apiKey) {
    config.apiKey = secureCreds.apiKey;
    return config;
  }

  // JWT tokens are sufficient auth (no API key needed)
  if (config.accessToken) {
    return config;
  }

  // Fall back to plaintext config (deprecated)
  if (fs.existsSync(CONFIG_FILE)) {
    const fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (fileConfig.apiUrl && !config.apiUrl) config.apiUrl = fileConfig.apiUrl;
    if (fileConfig.apiKey && !config.apiKey) config.apiKey = fileConfig.apiKey;
  }

  return config;
}

export function saveConfig(config: Partial<CliConfig>): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }

  const merged = { ...existing, ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
}
