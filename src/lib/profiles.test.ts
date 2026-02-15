import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

const CONFIG_DIR = path.join(os.homedir(), '.lsvault');
const PROFILES_DIR = path.join(CONFIG_DIR, 'profiles');
const ACTIVE_PROFILE_FILE = path.join(CONFIG_DIR, 'active-profile');

import {
  getProfilePath,
  getActiveProfile,
  setActiveProfile,
  loadProfile,
  setProfileValue,
  getProfileValue,
  listProfiles,
  deleteProfile,
  resolveProfileName,
} from './profiles.js';

describe('profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getProfilePath', () => {
    it('should return the correct path for a profile name', () => {
      expect(getProfilePath('prod')).toBe(path.join(PROFILES_DIR, 'prod.json'));
    });

    it('should handle profile names with special characters', () => {
      expect(getProfilePath('my-profile')).toBe(path.join(PROFILES_DIR, 'my-profile.json'));
    });
  });

  describe('getActiveProfile', () => {
    it('should return "default" when no active-profile file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(getActiveProfile()).toBe('default');
    });

    it('should return the profile name from the active-profile file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('prod\n');
      expect(getActiveProfile()).toBe('prod');
    });

    it('should return "default" when active-profile file is empty', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('');
      expect(getActiveProfile()).toBe('default');
    });

    it('should return "default" on read error', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(() => { throw new Error('read error'); });
      expect(getActiveProfile()).toBe('default');
    });
  });

  describe('setActiveProfile', () => {
    it('should write the profile name to active-profile file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      setActiveProfile('staging');
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        ACTIVE_PROFILE_FILE,
        'staging\n',
      );
    });

    it('should create the config directory if it does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      setActiveProfile('dev');
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    });
  });

  describe('loadProfile', () => {
    it('should return an empty object when the profile does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(loadProfile('nonexistent')).toEqual({});
    });

    it('should parse and return profile config from file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiUrl: 'https://prod.example.com', apiKey: 'lsv_k_prod123' }),
      );
      const config = loadProfile('prod');
      expect(config.apiUrl).toBe('https://prod.example.com');
      expect(config.apiKey).toBe('lsv_k_prod123');
    });

    it('should return empty object on parse error', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not valid json');
      expect(loadProfile('bad')).toEqual({});
    });
  });

  describe('setProfileValue', () => {
    it('should create profiles directory if it does not exist', () => {
      mockedFs.existsSync.mockReturnValueOnce(false) // PROFILES_DIR check
        .mockReturnValueOnce(false); // profile file check in loadProfile
      setProfileValue('dev', 'apiUrl', 'https://vault.lifestreamdynamics.com');
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(PROFILES_DIR, { recursive: true });
    });

    it('should merge with existing profile config', () => {
      mockedFs.existsSync.mockReturnValueOnce(true) // PROFILES_DIR exists
        .mockReturnValueOnce(true); // profile file exists
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiUrl: 'https://existing.com' }),
      );
      setProfileValue('prod', 'apiKey', 'lsv_k_new');
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        getProfilePath('prod'),
        expect.stringContaining('"apiKey": "lsv_k_new"'),
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        getProfilePath('prod'),
        expect.stringContaining('"apiUrl": "https://existing.com"'),
      );
    });

    it('should create a new profile file when it does not exist', () => {
      mockedFs.existsSync.mockReturnValueOnce(true) // PROFILES_DIR exists
        .mockReturnValueOnce(false); // profile file does not exist
      setProfileValue('new', 'apiUrl', 'https://new.com');
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        getProfilePath('new'),
        expect.stringContaining('"apiUrl": "https://new.com"'),
      );
    });
  });

  describe('getProfileValue', () => {
    it('should return the value for a key', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ apiUrl: 'https://prod.com', apiKey: 'lsv_k_abc' }),
      );
      expect(getProfileValue('prod', 'apiUrl')).toBe('https://prod.com');
    });

    it('should return undefined for a missing key', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ apiUrl: 'https://prod.com' }));
      expect(getProfileValue('prod', 'apiKey')).toBeUndefined();
    });

    it('should return undefined for a missing profile', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(getProfileValue('nonexistent', 'apiUrl')).toBeUndefined();
    });
  });

  describe('listProfiles', () => {
    it('should return empty array when profiles directory does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(listProfiles()).toEqual([]);
    });

    it('should return sorted profile names from JSON files', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue(
        ['prod.json', 'dev.json', 'staging.json'] as unknown as ReturnType<typeof fs.readdirSync>,
      );
      expect(listProfiles()).toEqual(['dev', 'prod', 'staging']);
    });

    it('should filter out non-JSON files', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue(
        ['prod.json', '.DS_Store', 'notes.txt'] as unknown as ReturnType<typeof fs.readdirSync>,
      );
      expect(listProfiles()).toEqual(['prod']);
    });
  });

  describe('deleteProfile', () => {
    it('should delete the profile file and return true', () => {
      mockedFs.existsSync.mockReturnValue(true);
      expect(deleteProfile('staging')).toBe(true);
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(getProfilePath('staging'));
    });

    it('should return false when profile does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(deleteProfile('nonexistent')).toBe(false);
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('resolveProfileName', () => {
    it('should return the explicit profile if provided', () => {
      expect(resolveProfileName('staging')).toBe('staging');
    });

    it('should return the active profile when no explicit profile given', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('prod\n');
      expect(resolveProfileName()).toBe('prod');
    });

    it('should return "default" when no explicit profile and no active-profile file', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(resolveProfileName()).toBe('default');
    });

    it('should return the explicit profile even when active profile is set', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('prod\n');
      expect(resolveProfileName('dev')).toBe('dev');
    });
  });
});
