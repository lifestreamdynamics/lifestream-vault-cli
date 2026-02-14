import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spyConsole } from '../__tests__/setup.js';

// Mock profiles module — factory must be self-contained (no external refs) due to hoisting
vi.mock('../lib/profiles.js', () => ({
  resolveProfileName: vi.fn((p?: string) => p || 'default'),
  getActiveProfile: vi.fn(() => 'default'),
  setActiveProfile: vi.fn(),
  loadProfile: vi.fn(() => ({})),
  setProfileValue: vi.fn(),
  getProfileValue: vi.fn(() => undefined as string | undefined),
  listProfiles: vi.fn(() => [] as string[]),
  deleteProfile: vi.fn(() => false),
  getProfilePath: vi.fn((name: string) => `/mock/.lsvault/profiles/${name}.json`),
}));

// Import the mocked module to access mock functions
import * as profiles from '../lib/profiles.js';
import { registerConfigCommands } from './config.js';
import { Command } from 'commander';

const mResolveProfileName = vi.mocked(profiles.resolveProfileName);
const mGetActiveProfile = vi.mocked(profiles.getActiveProfile);
const mSetActiveProfile = vi.mocked(profiles.setActiveProfile);
const mLoadProfile = vi.mocked(profiles.loadProfile);
const mSetProfileValue = vi.mocked(profiles.setProfileValue);
const mGetProfileValue = vi.mocked(profiles.getProfileValue);
const mListProfiles = vi.mocked(profiles.listProfiles);
const mDeleteProfile = vi.mocked(profiles.deleteProfile);

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerConfigCommands(program);
  return program;
}

describe('config commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mResolveProfileName.mockImplementation((p?: string) => p || 'default');
    mGetActiveProfile.mockReturnValue('default');
    mLoadProfile.mockReturnValue({});
    mGetProfileValue.mockReturnValue(undefined);
    mListProfiles.mockReturnValue([]);
    mDeleteProfile.mockReturnValue(false);
  });

  describe('config set', () => {
    it('should set a value in the resolved profile', async () => {
      const spy = spyConsole();
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'set', 'apiUrl', 'https://prod.com']);

      expect(mSetProfileValue).toHaveBeenCalledWith('default', 'apiUrl', 'https://prod.com');
      expect(spy.logs.some(l => l.includes('apiUrl'))).toBe(true);
      spy.restore();
    });

    it('should use explicit --profile flag', async () => {
      const spy = spyConsole();
      mResolveProfileName.mockReturnValue('prod');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'set', 'apiKey', 'lsv_k_abc', '--profile', 'prod']);

      expect(mSetProfileValue).toHaveBeenCalledWith('prod', 'apiKey', 'lsv_k_abc');
      spy.restore();
    });
  });

  describe('config get', () => {
    it('should print the value for a key', async () => {
      const spy = spyConsole();
      mGetProfileValue.mockReturnValue('https://prod.com');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'get', 'apiUrl']);

      expect(spy.logs.some(l => l.includes('https://prod.com'))).toBe(true);
      spy.restore();
    });

    it('should show a message when key is not set', async () => {
      const spy = spyConsole();
      mGetProfileValue.mockReturnValue(undefined);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'get', 'missing']);

      expect(spy.logs.some(l => l.includes('not set'))).toBe(true);
      spy.restore();
    });
  });

  describe('config list', () => {
    it('should list all values in the profile', async () => {
      const spy = spyConsole();
      mLoadProfile.mockReturnValue({
        apiUrl: 'https://prod.com',
        apiKey: 'lsv_k_abc123def456',
      });
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'list']);

      expect(spy.logs.some(l => l.includes('apiUrl'))).toBe(true);
      expect(spy.logs.some(l => l.includes('https://prod.com'))).toBe(true);
      // API key should be masked
      expect(spy.logs.some(l => l.includes('lsv_k_abc123...'))).toBe(true);
      spy.restore();
    });

    it('should show message for empty profile', async () => {
      const spy = spyConsole();
      mLoadProfile.mockReturnValue({});
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'list']);

      expect(spy.logs.some(l => l.includes('no configuration values'))).toBe(true);
      spy.restore();
    });
  });

  describe('config use', () => {
    it('should set the active profile', async () => {
      const spy = spyConsole();
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'use', 'prod']);

      expect(mSetActiveProfile).toHaveBeenCalledWith('prod');
      expect(spy.logs.some(l => l.includes('prod'))).toBe(true);
      spy.restore();
    });
  });

  describe('config profiles', () => {
    it('should list available profiles', async () => {
      const spy = spyConsole();
      mListProfiles.mockReturnValue(['dev', 'prod', 'staging']);
      mGetActiveProfile.mockReturnValue('prod');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'profiles']);

      expect(spy.logs.some(l => l.includes('dev'))).toBe(true);
      expect(spy.logs.some(l => l.includes('prod'))).toBe(true);
      expect(spy.logs.some(l => l.includes('staging'))).toBe(true);
      expect(spy.logs.some(l => l.includes('active'))).toBe(true);
      spy.restore();
    });

    it('should show message when no profiles exist', async () => {
      const spy = spyConsole();
      mListProfiles.mockReturnValue([]);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'profiles']);

      expect(spy.logs.some(l => l.includes('No profiles configured'))).toBe(true);
      spy.restore();
    });
  });

  describe('config delete', () => {
    it('should delete a profile', async () => {
      const spy = spyConsole();
      mDeleteProfile.mockReturnValue(true);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'delete', 'staging']);

      expect(mDeleteProfile).toHaveBeenCalledWith('staging');
      expect(spy.logs.some(l => l.includes('deleted'))).toBe(true);
      spy.restore();
    });

    it('should show message when profile not found', async () => {
      const spy = spyConsole();
      mDeleteProfile.mockReturnValue(false);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'delete', 'nonexistent']);

      expect(spy.logs.some(l => l.includes('not found'))).toBe(true);
      spy.restore();
    });
  });

  describe('config current', () => {
    it('should print the active profile name', async () => {
      const spy = spyConsole();
      mGetActiveProfile.mockReturnValue('prod');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'current']);

      expect(spy.logs.some(l => l.includes('prod'))).toBe(true);
      spy.restore();
    });
  });
});
