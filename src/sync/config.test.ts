import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

// Must import after mocking fs
import {
  loadSyncConfigs,
  saveSyncConfigs,
  getSyncConfig,
  getSyncConfigByVaultId,
  createSyncConfig,
  deleteSyncConfig,
  updateLastSync,
} from './config.js';
import type { SyncConfig } from './types.js';

function makeSyncConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'sync-1',
    vaultId: 'vault-1',
    localPath: '/home/user/vault',
    mode: 'sync',
    onConflict: 'newer',
    ignore: ['.git', '.DS_Store', 'node_modules'],
    lastSyncAt: '1970-01-01T00:00:00.000Z',
    autoSync: false,
    ...overrides,
  };
}

describe('sync config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadSyncConfigs', () => {
    it('should return empty array when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(loadSyncConfigs()).toEqual([]);
    });

    it('should return empty array for corrupt file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-json');
      expect(loadSyncConfigs()).toEqual([]);
    });

    it('should return empty array for non-array JSON', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('{"foo": "bar"}');
      expect(loadSyncConfigs()).toEqual([]);
    });

    it('should return parsed configs', () => {
      const configs = [makeSyncConfig()];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));
      expect(loadSyncConfigs()).toEqual(configs);
    });
  });

  describe('saveSyncConfigs', () => {
    it('should create config directory if it does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      saveSyncConfigs([]);
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.lsvault'),
        { recursive: true },
      );
    });

    it('should write JSON to file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      const configs = [makeSyncConfig()];
      saveSyncConfigs(configs);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('syncs.json'),
        expect.stringContaining('"vaultId": "vault-1"'),
      );
    });
  });

  describe('getSyncConfig', () => {
    it('should find config by ID', () => {
      const configs = [makeSyncConfig({ id: 'sync-1' }), makeSyncConfig({ id: 'sync-2' })];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));
      expect(getSyncConfig('sync-2')?.id).toBe('sync-2');
    });

    it('should return undefined for missing ID', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeSyncConfig()]));
      expect(getSyncConfig('nonexistent')).toBeUndefined();
    });
  });

  describe('getSyncConfigByVaultId', () => {
    it('should find config by vault ID', () => {
      const configs = [
        makeSyncConfig({ id: 'sync-1', vaultId: 'v-1' }),
        makeSyncConfig({ id: 'sync-2', vaultId: 'v-2' }),
      ];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));
      expect(getSyncConfigByVaultId('v-2')?.id).toBe('sync-2');
    });
  });

  describe('createSyncConfig', () => {
    it('should create a new config with defaults', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const config = createSyncConfig({
        vaultId: 'vault-1',
        localPath: '/home/user/vault',
      });

      expect(config.id).toBeDefined();
      expect(config.vaultId).toBe('vault-1');
      expect(config.localPath).toBe('/home/user/vault');
      expect(config.mode).toBe('sync');
      expect(config.onConflict).toBe('newer');
      expect(config.ignore).toEqual(['.git', '.DS_Store', 'node_modules']);
      expect(config.autoSync).toBe(false);
    });

    it('should create a config with custom options', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const config = createSyncConfig({
        vaultId: 'vault-1',
        localPath: '/home/user/vault',
        mode: 'pull',
        onConflict: 'remote',
        ignore: ['.git'],
        syncInterval: '5m',
        autoSync: true,
      });

      expect(config.mode).toBe('pull');
      expect(config.onConflict).toBe('remote');
      expect(config.ignore).toEqual(['.git']);
      expect(config.syncInterval).toBe('5m');
      expect(config.autoSync).toBe(true);
    });

    it('should reject duplicate vault+path combinations', () => {
      const existing = [makeSyncConfig({ vaultId: 'vault-1', localPath: '/home/user/vault' })];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

      expect(() =>
        createSyncConfig({ vaultId: 'vault-1', localPath: '/home/user/vault' }),
      ).toThrow('Sync already exists');
    });

    it('should allow same vault with different path', () => {
      const existing = [makeSyncConfig({ vaultId: 'vault-1', localPath: '/home/user/vault' })];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(existing));

      const config = createSyncConfig({
        vaultId: 'vault-1',
        localPath: '/home/user/vault-backup',
      });
      expect(config.vaultId).toBe('vault-1');
    });

    it('should persist the new config', () => {
      mockedFs.existsSync.mockReturnValue(false);
      createSyncConfig({ vaultId: 'vault-1', localPath: '/tmp/test' });
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('deleteSyncConfig', () => {
    it('should delete config by ID and return true', () => {
      const configs = [makeSyncConfig({ id: 'sync-1' }), makeSyncConfig({ id: 'sync-2' })];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));

      expect(deleteSyncConfig('sync-1')).toBe(true);
      expect(mockedFs.writeFileSync).toHaveBeenCalled();

      // Verify the written content doesn't include the deleted config
      const writtenContent = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenContent);
      expect(written).toHaveLength(1);
      expect(written[0].id).toBe('sync-2');
    });

    it('should return false when ID not found', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeSyncConfig()]));
      expect(deleteSyncConfig('nonexistent')).toBe(false);
    });
  });

  describe('updateLastSync', () => {
    it('should update the lastSyncAt field', () => {
      const configs = [makeSyncConfig({ id: 'sync-1' })];
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(configs));

      const ts = '2025-06-15T10:00:00.000Z';
      updateLastSync('sync-1', ts);

      const writtenContent = mockedFs.writeFileSync.mock.calls[0][1] as string;
      const written = JSON.parse(writtenContent);
      expect(written[0].lastSyncAt).toBe(ts);
    });

    it('should throw when config not found', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('[]');
      expect(() => updateLastSync('nonexistent')).toThrow('Sync config not found');
    });
  });
});
