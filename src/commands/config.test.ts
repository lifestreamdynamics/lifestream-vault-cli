import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spyOutput } from '../__tests__/setup.js';

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
      const spy = spyOutput();
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'set', 'apiUrl', 'https://prod.com']);

      expect(mSetProfileValue).toHaveBeenCalledWith('default', 'apiUrl', 'https://prod.com');
      expect(spy.stdout.join('').includes('apiUrl')).toBe(true);
      spy.restore();
    });

    it('should use explicit --profile flag', async () => {
      const spy = spyOutput();
      mResolveProfileName.mockReturnValue('prod');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'set', 'apiKey', 'lsv_k_abc', '--profile', 'prod']);

      expect(mSetProfileValue).toHaveBeenCalledWith('prod', 'apiKey', 'lsv_k_abc');
      spy.restore();
    });
  });

  describe('config get', () => {
    it('should print the value for a key', async () => {
      const spy = spyOutput();
      mGetProfileValue.mockReturnValue('https://prod.com');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'get', 'apiUrl']);

      expect(spy.stdout.join('').includes('https://prod.com')).toBe(true);
      spy.restore();
    });

    it('should show a message when key is not set', async () => {
      const spy = spyOutput();
      mGetProfileValue.mockReturnValue(undefined);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'get', 'missing']);

      expect(spy.stdout.join('').includes('not set')).toBe(true);
      spy.restore();
    });
  });

  describe('config list', () => {
    it('should list all values in the profile', async () => {
      const spy = spyOutput();
      mLoadProfile.mockReturnValue({
        apiUrl: 'https://prod.com',
        apiKey: 'lsv_k_abc123def456',
      });
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'list']);

      const out = spy.stdout.join('');
      expect(out.includes('apiUrl')).toBe(true);
      expect(out.includes('https://prod.com')).toBe(true);
      // API key should be masked
      expect(out.includes('lsv_k_abc123...')).toBe(true);
      spy.restore();
    });

    it('should show message for empty profile', async () => {
      const spy = spyOutput();
      mLoadProfile.mockReturnValue({});
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'list']);

      expect(spy.stdout.join('').includes('no configuration values')).toBe(true);
      spy.restore();
    });
  });

  describe('config use', () => {
    it('should set the active profile', async () => {
      const spy = spyOutput();
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'use', 'prod']);

      expect(mSetActiveProfile).toHaveBeenCalledWith('prod');
      expect(spy.stdout.join('').includes('prod')).toBe(true);
      spy.restore();
    });
  });

  describe('config profiles', () => {
    it('should list available profiles', async () => {
      const spy = spyOutput();
      mListProfiles.mockReturnValue(['dev', 'prod', 'staging']);
      mGetActiveProfile.mockReturnValue('prod');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'profiles']);

      const out = spy.stdout.join('');
      expect(out.includes('dev')).toBe(true);
      expect(out.includes('prod')).toBe(true);
      expect(out.includes('staging')).toBe(true);
      expect(out.includes('active')).toBe(true);
      spy.restore();
    });

    it('should show message when no profiles exist', async () => {
      const spy = spyOutput();
      mListProfiles.mockReturnValue([]);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'profiles']);

      expect(spy.stdout.join('').includes('No profiles configured')).toBe(true);
      spy.restore();
    });
  });

  describe('config delete', () => {
    it('should delete a profile', async () => {
      const spy = spyOutput();
      mDeleteProfile.mockReturnValue(true);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'delete', 'staging']);

      expect(mDeleteProfile).toHaveBeenCalledWith('staging');
      expect(spy.stdout.join('').includes('deleted')).toBe(true);
      spy.restore();
    });

    it('should show message when profile not found', async () => {
      const spy = spyOutput();
      mDeleteProfile.mockReturnValue(false);
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'delete', 'nonexistent']);

      expect(spy.stdout.join('').includes('not found')).toBe(true);
      spy.restore();
    });
  });

  describe('config current', () => {
    it('should print the active profile name', async () => {
      const spy = spyOutput();
      mGetActiveProfile.mockReturnValue('prod');
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'current']);

      expect(spy.stdout.join('').includes('prod')).toBe(true);
      spy.restore();
    });
  });

  describe('config list masking', () => {
    it('should mask keys containing "token"', async () => {
      const spy = spyOutput();
      mLoadProfile.mockReturnValue({ accessToken: 'secret-token-value-xyz' });
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'list']);

      const out = spy.stdout.join('');
      // 'secret-token-value-xyz'.slice(0, 12) = 'secret-token' + '...'
      expect(out.includes('secret-token...')).toBe(true);
      expect(out.includes('secret-token-value-xyz')).toBe(false);
      spy.restore();
    });

    it('should mask keys containing "secret"', async () => {
      const spy = spyOutput();
      mLoadProfile.mockReturnValue({ hmacSecret: 'my-super-secret-value' });
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'list']);

      const out = spy.stdout.join('');
      // 'my-super-secret-value'.slice(0, 12) = 'my-super-sec' + '...'
      expect(out.includes('my-super-sec...')).toBe(true);
      spy.restore();
    });

    it('should mask keys containing "password"', async () => {
      const spy = spyOutput();
      mLoadProfile.mockReturnValue({ userPassword: 'hunter2' });
      const program = createProgram();

      await program.parseAsync(['node', 'lsvault', 'config', 'list']);

      const out = spy.stdout.join('');
      // 'hunter2'.slice(0, 12) = 'hunter2' + '...' (shorter than 12 chars)
      expect(out.includes('hunter2...')).toBe(true);
      spy.restore();
    });
  });
});
