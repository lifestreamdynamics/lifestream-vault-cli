import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  apiUrl: string;
  apiKey?: string;
}

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
