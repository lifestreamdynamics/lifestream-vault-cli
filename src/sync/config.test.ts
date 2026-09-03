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
  trustSyncRoot,
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
    vi.resetAllMocks();
  });

  describe('loadSyncConfigs', () => {
    it('should return empty array when no file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(loadSyncConfigs()).toEqual([]);
    });

    it('throws for a corrupt file instead of silently reporting no syncs', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-json');
      expect(() => loadSyncConfigs()).toThrow(/syncs\.json is not valid JSON/);
    });

    it('throws for non-array JSON', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('{"foo": "bar"}');
      expect(() => loadSyncConfigs()).toThrow(/must contain a JSON array/);
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
        { recursive: true, mode: 0o700 },
      );
    });

    it('writes JSON to a temp file and renames it over syncs.json (mode 0600)', () => {
      mockedFs.existsSync.mockReturnValue(true);
      const configs = [makeSyncConfig()];
      saveSyncConfigs(configs);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/syncs\.json\.tmp\.[0-9a-f]{8}$/),
        expect.stringContaining('"vaultId": "vault-1"'),
        { encoding: 'utf-8', mode: 0o600 },
      );
      expect(mockedFs.renameSync).toHaveBeenCalledWith(
        expect.stringMatching(/syncs\.json\.tmp\.[0-9a-f]{8}$/),
        expect.stringMatching(/syncs\.json$/),
      );
    });

    it('removes the temp file and rethrows when the rename fails', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.renameSync.mockImplementation(() => { throw new Error('EXDEV'); });
      expect(() => saveSyncConfigs([])).toThrow('EXDEV');
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/syncs\.json\.tmp\./));
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

    it('writes the root marker before persisting a marked configuration', () => {
      mockedFs.existsSync.mockImplementation(target => {
        const value = String(target);
        return value === '/home/user/vault' || value.endsWith('syncs.json');
      });
      mockedFs.readFileSync.mockReturnValue('[]');
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

      const config = createSyncConfig(
        { vaultId: 'vault-1', localPath: '/home/user/vault' },
        { markRoot: true },
      );

      expect(config.rootMarkerVersion).toBe(1);
      const writes = mockedFs.writeFileSync.mock.calls;
      expect(String(writes[0][0])).toContain('.lsvault-sync-root');
      expect(writes[0][2]).toEqual(expect.objectContaining({ flag: 'wx', mode: 0o600 }));
      expect(String(writes[1][0])).toContain('syncs.json');
      expect(String(writes[1][1])).toContain('"rootMarkerVersion": 1');
    });

    it('refuses to mark a directory that already carries a marker', () => {
      mockedFs.existsSync.mockImplementation(target => {
        const value = String(target);
        return value === '/home/user/vault' || value.endsWith('.lsvault-sync-root') || value.endsWith('syncs.json');
      });
      mockedFs.readFileSync.mockReturnValue('[]');
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

      expect(() => createSyncConfig(
        { vaultId: 'vault-1', localPath: '/home/user/vault' },
        { markRoot: true },
      )).toThrow(/already contains \.lsvault-sync-root/);
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rolls the marker back when persisting the configuration fails', () => {
      mockedFs.existsSync.mockImplementation(target => {
        const value = String(target);
        return value === '/home/user/vault' || value.endsWith('syncs.json');
      });
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
      mockedFs.lstatSync.mockReturnValue({ isFile: () => true, isSymbolicLink: () => false } as fs.Stats);
      let markerContent = '';
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target).endsWith('.lsvault-sync-root')) return markerContent;
        return '[]';
      });
      mockedFs.writeFileSync.mockImplementation((target, content) => {
        if (String(target).endsWith('.lsvault-sync-root')) { markerContent = String(content); return; }
        throw new Error('disk full');
      });

      expect(() => createSyncConfig(
        { vaultId: 'vault-1', localPath: '/home/user/vault' },
        { markRoot: true },
      )).toThrow('disk full');
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.lsvault-sync-root$/));
    });
  });

  describe('trustSyncRoot', () => {
    it('marks and upgrades a legacy configuration', () => {
      const legacy = makeSyncConfig({ rootMarkerVersion: undefined });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify([legacy]));
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

      const trusted = trustSyncRoot(legacy.id);

      expect(trusted.rootMarkerVersion).toBe(1);
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.lsvault-sync-root'),
        expect.stringContaining('"syncId": "sync-1"'),
        expect.objectContaining({ flag: 'wx', mode: 0o600 }),
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/syncs\.json\.tmp\./),
        expect.stringContaining('"rootMarkerVersion": 1'),
        { encoding: 'utf-8', mode: 0o600 },
      );
    });

    it('rejects an already-trusted configuration without touching the marker', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify([makeSyncConfig({ rootMarkerVersion: 1 })]));

      expect(() => trustSyncRoot('sync-1')).toThrow(/already trusted/);
      expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
    });

    it('rejects an unknown sync id', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('[]');

      expect(() => trustSyncRoot('missing')).toThrow('Sync config not found: missing');
    });

    it('refuses a root that already carries a marker (conflict)', () => {
      const legacy = makeSyncConfig({ rootMarkerVersion: undefined });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(JSON.stringify([legacy]));
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
      mockedFs.writeFileSync.mockImplementation((_target, _content, options) => {
        if (typeof options === 'object' && options !== null && 'flag' in options && options.flag === 'wx') {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      });

      expect(() => trustSyncRoot(legacy.id)).toThrow(/refusing to overwrite/);
      expect(mockedFs.renameSync).not.toHaveBeenCalled();
    });

    it('rolls the marker back when the config write fails', () => {
      const legacy = makeSyncConfig({ rootMarkerVersion: undefined });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
      mockedFs.lstatSync.mockReturnValue({ isFile: () => true, isSymbolicLink: () => false } as fs.Stats);
      let markerContent = '';
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target).endsWith('.lsvault-sync-root')) return markerContent;
        return JSON.stringify([legacy]);
      });
      mockedFs.writeFileSync.mockImplementation((target, content) => {
        if (String(target).endsWith('.lsvault-sync-root')) { markerContent = String(content); return; }
        throw new Error('disk full');
      });

      expect(() => trustSyncRoot(legacy.id)).toThrow('disk full');
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.lsvault-sync-root$/));
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
