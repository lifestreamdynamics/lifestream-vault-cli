import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerPluginCommands } from './plugins.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

describe('plugins commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  const mockPlugin = {
    id: 'install-1',
    pluginId: 'org/my-plugin',
    version: '1.0.0',
    enabled: true,
    settings: {},
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerPluginCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('plugins list', () => {
    it('should list installed plugins', async () => {
      sdkMock.plugins.list.mockResolvedValue([mockPlugin]);

      await program.parseAsync(['node', 'cli', 'plugins', 'list']);

      expect(sdkMock.plugins.list).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('org/my-plugin');
    });

    it('should show empty message when no plugins', async () => {
      sdkMock.plugins.list.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'plugins', 'list']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('No plugins installed.');
    });

    it('should handle list errors', async () => {
      sdkMock.plugins.list.mockRejectedValue(new Error('Unauthorized'));

      await program.parseAsync(['node', 'cli', 'plugins', 'list']);

      expect(process.exitCode).toBe(1);
    });
  });

  // ── install ───────────────────────────────────────────────────────────────

  describe('plugins install', () => {
    it('should install a plugin', async () => {
      sdkMock.plugins.install.mockResolvedValue(mockPlugin);

      await program.parseAsync([
        'node', 'cli', 'plugins', 'install',
        '--plugin-id', 'org/my-plugin',
        '--version', '1.0.0',
      ]);

      expect(sdkMock.plugins.install).toHaveBeenCalledWith({
        pluginId: 'org/my-plugin',
        version: '1.0.0',
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('installed');
    });

    it('should handle installation errors', async () => {
      sdkMock.plugins.install.mockRejectedValue(new Error('Plugin already installed'));

      await program.parseAsync([
        'node', 'cli', 'plugins', 'install',
        '--plugin-id', 'org/my-plugin',
        '--version', '1.0.0',
      ]);

      expect(process.exitCode).toBe(1);
    });
  });

  // ── uninstall ─────────────────────────────────────────────────────────────

  describe('plugins uninstall', () => {
    it('should require --yes flag', async () => {
      await program.parseAsync(['node', 'cli', 'plugins', 'uninstall', 'org/my-plugin']);

      expect(sdkMock.plugins.uninstall).not.toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('--yes');
    });

    it('should uninstall with --confirm', async () => {
      sdkMock.plugins.uninstall.mockResolvedValue(undefined);

      await program.parseAsync([
        'node', 'cli', 'plugins', 'uninstall', 'org/my-plugin', '--confirm',
      ]);

      expect(sdkMock.plugins.uninstall).toHaveBeenCalledWith('org/my-plugin');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('uninstalled');
    });
  });

  // ── enable ────────────────────────────────────────────────────────────────

  describe('plugins enable', () => {
    it('should enable a plugin', async () => {
      sdkMock.plugins.enable.mockResolvedValue({ ...mockPlugin, enabled: true });

      await program.parseAsync(['node', 'cli', 'plugins', 'enable', 'org/my-plugin']);

      expect(sdkMock.plugins.enable).toHaveBeenCalledWith('org/my-plugin');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('enabled');
    });

    it('should handle errors', async () => {
      sdkMock.plugins.enable.mockRejectedValue(new Error('Plugin not found'));

      await program.parseAsync(['node', 'cli', 'plugins', 'enable', 'org/missing']);

      expect(process.exitCode).toBe(1);
    });
  });

  // ── disable ───────────────────────────────────────────────────────────────

  describe('plugins disable', () => {
    it('should disable a plugin', async () => {
      sdkMock.plugins.disable.mockResolvedValue({ ...mockPlugin, enabled: false });

      await program.parseAsync(['node', 'cli', 'plugins', 'disable', 'org/my-plugin']);

      expect(sdkMock.plugins.disable).toHaveBeenCalledWith('org/my-plugin');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('disabled');
    });
  });

  // ── update-settings ───────────────────────────────────────────────────────

  describe('plugins update-settings', () => {
    it('should update plugin settings', async () => {
      sdkMock.plugins.updateSettings.mockResolvedValue({
        ...mockPlugin,
        settings: { theme: 'dark' },
      });

      await program.parseAsync([
        'node', 'cli', 'plugins', 'update-settings', 'org/my-plugin',
        '--settings', '{"theme":"dark"}',
      ]);

      expect(sdkMock.plugins.updateSettings).toHaveBeenCalledWith(
        'org/my-plugin',
        { theme: 'dark' },
      );
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Settings updated');
    });

    it('should show error on invalid JSON', async () => {
      await program.parseAsync([
        'node', 'cli', 'plugins', 'update-settings', 'org/my-plugin',
        '--settings', 'not-json',
      ]);

      expect(sdkMock.plugins.updateSettings).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    });

    it('should handle update errors', async () => {
      sdkMock.plugins.updateSettings.mockRejectedValue(new Error('Plugin not found'));

      await program.parseAsync([
        'node', 'cli', 'plugins', 'update-settings', 'org/my-plugin',
        '--settings', '{}',
      ]);

      expect(process.exitCode).toBe(1);
    });
  });
});
