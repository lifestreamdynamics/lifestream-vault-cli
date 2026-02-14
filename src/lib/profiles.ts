import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');
const ACTIVE_PROFILE_FILE = path.join(CONFIG_DIR, 'active-profile');

export interface ProfileConfig {
  apiUrl?: string;
  apiKey?: string;
  [key: string]: string | undefined;
}

/**
 * Returns the path to a named profile's config file.
 */
export function getProfilePath(name: string): string {
  return path.join(PROFILES_DIR, `${name}.json`);
}

/**
 * Returns the name of the currently active profile, or 'default' if none set.
 */
export function getActiveProfile(): string {
  try {
    if (fs.existsSync(ACTIVE_PROFILE_FILE)) {
      return fs.readFileSync(ACTIVE_PROFILE_FILE, 'utf-8').trim() || 'default';
    }
  } catch {
    // Fall through
  }
  return 'default';
}

/**
 * Sets the active profile name.
 */
export function setActiveProfile(name: string): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(ACTIVE_PROFILE_FILE, name + '\n');
}

/**
 * Loads a profile's configuration. Returns an empty object if the profile
 * does not exist.
 */
export function loadProfile(name: string): ProfileConfig {
  const filePath = getProfilePath(name);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Fall through — treat as empty
  }
  return {};
}

/**
 * Saves a value to a profile. Creates the profile directory and file if needed.
 */
export function setProfileValue(name: string, key: string, value: string): void {
  if (!fs.existsSync(PROFILES_DIR)) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
  }
  const config = loadProfile(name);
  config[key] = value;
  fs.writeFileSync(getProfilePath(name), JSON.stringify(config, null, 2) + '\n');
}

/**
 * Gets a single value from a profile.
 */
export function getProfileValue(name: string, key: string): string | undefined {
  const config = loadProfile(name);
  return config[key];
}

/**
 * Lists all available profile names (derived from filenames in the profiles dir).
 */
export function listProfiles(): string[] {
  try {
    if (!fs.existsSync(PROFILES_DIR)) {
      return [];
    }
    return fs.readdirSync(PROFILES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Deletes a profile.
 */
export function deleteProfile(name: string): boolean {
  const filePath = getProfilePath(name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Resolves the effective profile name: explicit --profile flag takes precedence,
 * otherwise the active profile is used.
 */
export function resolveProfileName(explicitProfile?: string): string {
  return explicitProfile || getActiveProfile();
}
