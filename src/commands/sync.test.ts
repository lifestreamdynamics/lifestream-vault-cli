import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSyncCommands } from './sync.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockCreateWatcher, mockCreateRemotePoller } = vi.hoisted(() => ({
  mockCreateWatcher: vi.fn(() => ({
    ready: Promise.resolve(),
    markLocalWrite: vi.fn(),
    serialize: async <T>(operation: () => Promise<T>) => operation(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  mockCreateRemotePoller: vi.fn(() => ({ stop: vi.fn().mockResolvedValue(undefined) })),
}));

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    text: '',
    stream: process.stderr,
  })),
}));

// Mock sync config module
const mockConfigs: Array<Record<string, unknown>> = [];
vi.mock('../sync/config.js', () => ({
  loadSyncConfigs: vi.fn(() => mockConfigs),
  createSyncConfig: vi.fn((opts: Record<string, unknown>) => ({
    id: 'test-sync-id',
    vaultId: opts.vaultId,
    localPath: opts.localPath,
    mode: opts.mode ?? 'sync',
    onConflict: opts.onConflict ?? 'newer',
    ignore: opts.ignore ?? ['.git', '.DS_Store', 'node_modules'],
    lastSyncAt: '1970-01-01T00:00:00.000Z',
    autoSync: opts.autoSync ?? false,
  })),
  deleteSyncConfig: vi.fn((id: string) => {
    const idx = mockConfigs.findIndex(c => c.id === id);
    if (idx === -1) return false;
    mockConfigs.splice(idx, 1);
    return true;
  }),
  getSyncConfig: vi.fn((id: string) => {
    return mockConfigs.find(c => c.id === id) ?? null;
  }),
  trustSyncRoot: vi.fn((id: string) => ({ ...(mockConfigs.find(c => c.id === id) ?? {}), rootMarkerVersion: 1 })),
}));

vi.mock('../sync/root-marker.js', () => ({
  assertSyncRoot: vi.fn(),
  prepareSyncRoot: vi.fn(),
  SYNC_ROOT_MARKER: '.lsvault-sync-root',
}));
vi.mock('../sync/watcher.js', () => ({ createWatcher: mockCreateWatcher }));
vi.mock('../sync/remote-poller.js', () => ({ createRemotePoller: mockCreateRemotePoller }));

// Mock sync state module
vi.mock('../sync/state.js', () => ({
  deleteSyncState: vi.fn(() => true),
  loadSyncState: vi.fn(() => ({
    syncId: 'test-sync-id',
    local: {},
    remote: {},
    remoteListEtag: undefined,
    updatedAt: '1970-01-01T00:00:00.000Z',
  })),
  saveSyncState: vi.fn(),
  hashFileContent: vi.fn(() => 'hash'),
  buildRemoteFileState: vi.fn(),
  pruneDeniedDeletes: vi.fn(() => []),
}));

// Mock sync engine module
vi.mock('../sync/engine.js', () => ({
  scanLocalFiles: vi.fn(() => ({})),
  scanRemoteFiles: vi.fn(async () => ({ files: {}, listEtag: '', vaultUnchanged: false })),
  executePull: vi.fn(async (_client: unknown, _config: unknown, _diff: unknown, onProgress?: (p: unknown) => void) => {
    if (onProgress) onProgress({ phase: 'complete', current: 0, total: 0 });
    return { filesDownloaded: 0, filesDeleted: 0, filesUploaded: 0, bytesTransferred: 0, errors: [] };
  }),
  executePush: vi.fn(async (_client: unknown, _config: unknown, _diff: unknown, onProgress?: (p: unknown) => void) => {
    if (onProgress) onProgress({ phase: 'complete', current: 0, total: 0 });
    return { filesDownloaded: 0, filesDeleted: 0, filesUploaded: 0, bytesTransferred: 0, errors: [] };
  }),
  computePullDiff: vi.fn(() => ({ downloads: [], deletes: [], uploads: [], totalBytes: 0 })),
  computePushDiff: vi.fn(() => ({ downloads: [], deletes: [], uploads: [], totalBytes: 0 })),
  resolveConcurrency: vi.fn((v?: number) => v ?? 4),
  sweepOrphanedTempFiles: vi.fn(() => 0),
}));

// Mock sync ignore module
vi.mock('../sync/ignore.js', () => ({
  resolveIgnorePatterns: vi.fn(() => []),
}));

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

import { createSyncConfig, deleteSyncConfig, loadSyncConfigs, trustSyncRoot } from '../sync/config.js';
import { deleteSyncState, saveSyncState, loadSyncState } from '../sync/state.js';
import { scanLocalFiles, scanRemoteFiles, computePullDiff, computePushDiff, executePull, executePush } from '../sync/engine.js';
import { assertSyncRoot, prepareSyncRoot } from '../sync/root-marker.js';

describe('sync commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerSyncCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    mockConfigs.length = 0;
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
  });

  describe('sync init', () => {
    it('fails before API access when the local root is invalid', async () => {
      vi.mocked(prepareSyncRoot).mockImplementationOnce(() => { throw new Error('Sync root does not exist'); });

      await program.parseAsync(['node', 'cli', 'sync', 'init', 'vault-1', '/missing/root']);

      expect(sdkMock.vaults.get).not.toHaveBeenCalled();
      expect(createSyncConfig).not.toHaveBeenCalled();
    });

    it('should initialize sync for a vault', async () => {
      sdkMock.vaults.get.mockResolvedValue({
        id: 'vault-1',
        name: 'My Vault',
        slug: 'my-vault',
      });

      await program.parseAsync(['node', 'cli', 'sync', 'init', 'vault-1', '/tmp/test-vault']);

      expect(sdkMock.vaults.get).toHaveBeenCalledWith('vault-1');
      expect(createSyncConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          vaultId: 'vault-1',
          mode: 'sync',
          onConflict: 'newer',
        }),
        expect.objectContaining({ markRoot: true }),
      );
    });

    it('should pass custom options', async () => {
      sdkMock.vaults.get.mockResolvedValue({
        id: 'vault-1',
        name: 'My Vault',
        slug: 'my-vault',
      });

      await program.parseAsync([
        'node', 'cli', 'sync', 'init', 'vault-1', '/tmp/test-vault',
        '--mode', 'pull',
        '--on-conflict', 'remote',
        '--auto-sync',
      ]);

      expect(createSyncConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'pull',
          onConflict: 'remote',
          autoSync: true,
        }),
        expect.objectContaining({ markRoot: true }),
      );
    });

    it('should handle vault not found error', async () => {
      sdkMock.vaults.get.mockRejectedValue(new Error('Not found'));

      await program.parseAsync(['node', 'cli', 'sync', 'init', 'bad-vault', '/tmp/test']);

      expect(outputSpy.stderr.some(l => l.includes('Not found'))).toBe(true);
    });

    it('rejects an unknown --mode before touching the filesystem or API', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'init', 'vault-1', '/tmp/test-vault', '--mode', 'mirror']);

      expect(prepareSyncRoot).not.toHaveBeenCalled();
      expect(sdkMock.vaults.get).not.toHaveBeenCalled();
      expect(outputSpy.stderr.join('')).toMatch(/--mode must be one of pull, push, sync/);
      expect(process.exitCode).toBe(1);
    });

    it('rejects an unknown --on-conflict strategy', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'init', 'vault-1', '/tmp/test-vault', '--on-conflict', 'merge']);

      expect(sdkMock.vaults.get).not.toHaveBeenCalled();
      expect(outputSpy.stderr.join('')).toMatch(/--on-conflict must be one of newer, local, remote, ask/);
      expect(process.exitCode).toBe(1);
    });

    it('removes a directory it created when initialization fails afterwards', async () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-init-'));
      const target = path.join(parent, 'new-root');
      vi.mocked(prepareSyncRoot).mockImplementationOnce((dir: string) => { fs.mkdirSync(dir, { recursive: true }); });
      sdkMock.vaults.get.mockRejectedValue(new Error('Not found'));
      try {
        await program.parseAsync(['node', 'cli', 'sync', 'init', 'vault-1', target, '--create-dir']);

        expect(fs.existsSync(target)).toBe(false);
        expect(process.exitCode).toBe(1);
      } finally {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    });

    it('leaves a pre-existing directory alone when initialization fails', async () => {
      const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-init-existing-'));
      sdkMock.vaults.get.mockRejectedValue(new Error('Not found'));
      try {
        await program.parseAsync(['node', 'cli', 'sync', 'init', 'vault-1', existing, '--create-dir']);
        expect(fs.existsSync(existing)).toBe(true);
      } finally {
        fs.rmSync(existing, { recursive: true, force: true });
      }
    });
  });

  describe('sync trust-root', () => {
    beforeEach(() => {
      mockConfigs.push({
        id: 'legacy-sync', vaultId: 'vault-1', localPath: '/tmp/legacy-root', mode: 'sync',
        onConflict: 'newer', ignore: [], lastSyncAt: '', autoSync: false,
      });
      vi.mocked(scanLocalFiles).mockReturnValue({
        'a.md': { path: 'a.md', hash: 'h', mtime: '', size: 1 },
        'b.md': { path: 'b.md', hash: 'h', mtime: '', size: 1 },
      });
    });

    it('shows the root path and file count, then trusts with --yes', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'trust-root', 'legacy-sync', '--yes']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('/tmp/legacy-root');
      expect(stderr).toMatch(/Markdown files that will be tracked: 2/);
      expect(trustSyncRoot).toHaveBeenCalledWith('legacy-sync');
    });

    it('refuses to prompt without a TTY and does not trust the root', async () => {
      const originalIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      try {
        await program.parseAsync(['node', 'cli', 'sync', 'trust-root', 'legacy-sync']);
      } finally {
        Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      }

      expect(trustSyncRoot).not.toHaveBeenCalled();
      expect(outputSpy.stderr.join('')).toMatch(/--yes/);
      expect(process.exitCode).toBe(1);
    });

    it('reports an unknown sync id without prompting', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'trust-root', 'nope', '--yes']);

      expect(trustSyncRoot).not.toHaveBeenCalled();
      expect(outputSpy.stderr.join('')).toContain('Sync configuration not found: nope');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('sync resolve root safety', () => {
    beforeEach(() => {
      mockConfigs.push({
        id: 'test-sync-id',
        vaultId: 'vault-1',
        localPath: '/tmp/test-vault',
        mode: 'sync',
        onConflict: 'newer',
        ignore: [],
        lastSyncAt: '1970-01-01T00:00:00.000Z',
        autoSync: false,
        rootMarkerVersion: 1,
      });
    });

    it('revalidates the root after fetching remote content and before writing locally', async () => {
      sdkMock.documents.get.mockResolvedValue({ content: '# remote' } as any);
      vi.mocked(assertSyncRoot)
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error('Sync root marker is missing'); });

      await program.parseAsync([
        'node', 'cli', 'sync', 'resolve', 'test-sync-id', 'note.md', '--use', 'remote',
      ]);

      expect(sdkMock.documents.get).toHaveBeenCalledOnce();
      expect(assertSyncRoot).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(1);
    });

    it('rejects traversal paths before local or remote access', async () => {
      await program.parseAsync([
        'node', 'cli', 'sync', 'resolve', 'test-sync-id', '../outside.md', '--use', 'local',
      ]);

      expect(sdkMock.documents.put).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('rejects a manual resolution path through a real symlink', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-manual-root-'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-manual-outside-'));
      fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
      mockConfigs[0].localPath = root;
      try {
        await program.parseAsync([
          'node', 'cli', 'sync', 'resolve', 'test-sync-id', 'linked/outside.md', '--use', 'local',
        ]);
        expect(sdkMock.documents.put).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe('sync resolve', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsvault-resolve-'));
      mockConfigs.push({
        id: 'resolve-1', vaultId: 'vault-1', localPath: root, mode: 'sync',
        onConflict: 'newer', ignore: [], lastSyncAt: '1970-01-01T00:00:00.000Z',
        autoSync: false, rootMarkerVersion: 1,
      });
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('--use remote writes atomically and keeps a backup of the local version', async () => {
      // `--use remote` is a one-way door, and the file being resolved is by
      // definition one the user edited. The plain writeFileSync here was also
      // the last non-atomic local write in the sync engine.
      fs.writeFileSync(path.join(root, 'note.md'), '# my local version', 'utf-8');
      sdkMock.documents.get.mockResolvedValue({ content: '# the remote version' } as never);

      await program.parseAsync([
        'node', 'cli', 'sync', 'resolve', 'resolve-1', 'note.md', '--use', 'remote',
      ]);

      expect(process.exitCode).toBeUndefined();
      expect(fs.readFileSync(path.join(root, 'note.md'), 'utf-8')).toBe('# the remote version');
      const backups = fs.readdirSync(root).filter(f => f.includes('.conflicted.local.'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, backups[0]), 'utf-8')).toBe('# my local version');
      // No temp file survives the write.
      expect(fs.readdirSync(root).some(f => f.includes('.tmp.'))).toBe(false);
    });

    it('--use remote makes no backup when the two sides already agree', async () => {
      fs.writeFileSync(path.join(root, 'note.md'), '# same', 'utf-8');
      sdkMock.documents.get.mockResolvedValue({ content: '# same' } as never);

      await program.parseAsync([
        'node', 'cli', 'sync', 'resolve', 'resolve-1', 'note.md', '--use', 'remote',
      ]);

      expect(fs.readdirSync(root).filter(f => f.includes('.conflicted.'))).toHaveLength(0);
    });

    it('--use local conditions the overwrite on the last-known remote hash', async () => {
      // Resolving a stale conflict must not destroy an edit that arrived after
      // the conflict was recorded; a 412 is the right answer there.
      fs.writeFileSync(path.join(root, 'note.md'), '# keep mine', 'utf-8');
      vi.mocked(loadSyncState).mockReturnValue({
        syncId: 'resolve-1', local: {},
        remote: { 'note.md': { path: 'note.md', hash: 'remote-hash', mtime: '', size: 1 } },
        updatedAt: '',
      });

      await program.parseAsync([
        'node', 'cli', 'sync', 'resolve', 'resolve-1', 'note.md', '--use', 'local',
      ]);

      expect(sdkMock.documents.put).toHaveBeenCalledWith(
        'vault-1', 'note.md', '# keep mine', { ifMatch: 'remote-hash' },
      );
    });

    it('--use local sends no precondition when no remote hash is known', async () => {
      fs.writeFileSync(path.join(root, 'note.md'), '# keep mine', 'utf-8');

      await program.parseAsync([
        'node', 'cli', 'sync', 'resolve', 'resolve-1', 'note.md', '--use', 'local',
      ]);

      expect(sdkMock.documents.put).toHaveBeenCalledWith('vault-1', 'note.md', '# keep mine', undefined);
    });
  });

  describe('sync push — mass-delete guard reporting', () => {
    beforeEach(() => {
      mockConfigs.push({
        id: 'push-1', vaultId: 'vault-1', localPath: '/tmp/test',
        mode: 'push', onConflict: 'newer', ignore: [],
        lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
      });
    });

    const anomaly = {
      target: 'remote' as const,
      detectedAt: '2026-09-06T00:00:00.000Z',
      removedCount: 50,
      knownCount: 50,
      reason: 'the local scan no longer contains any of the 50 document(s) this sync was tracking.',
    };

    it('warns about a refused deletion batch and records it under the remote key', async () => {
      vi.mocked(computePushDiff).mockReturnValueOnce({
        downloads: [], deletes: [], uploads: [], totalBytes: 0, deletionAnomaly: anomaly,
      });

      await program.parseAsync(['node', 'cli', 'sync', 'push', 'push-1']);

      expect(outputSpy.stderr.join('')).toContain('Refused 50 remote deletion(s)');
      // The push override, not the pull one — sending the operator to the wrong
      // command sends them round a loop.
      expect(outputSpy.stderr.join('')).toContain('lsvault sync push --allow-mass-delete');
      const saved = vi.mocked(saveSyncState).mock.calls.at(-1)?.[0];
      expect(saved?.deletionAnomalies?.remote).toEqual(anomaly);
      expect(saved?.deletionAnomalies?.local).toBeUndefined();
    });

    it('threads --allow-mass-delete into the diff', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'push', 'push-1', '--allow-mass-delete']);

      expect(computePushDiff).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), { allowMassDelete: true },
      );
    });

    it('does not set the flag by default', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'push', 'push-1']);

      expect(computePushDiff).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), { allowMassDelete: false },
      );
    });
  });

  describe('sync status persistent warnings', () => {
    beforeEach(() => {
      mockConfigs.push({
        id: 'status-1', vaultId: 'vault-1', localPath: '/tmp/test',
        mode: 'sync', onConflict: 'newer', ignore: [],
        lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
      });
      // These tests are about what `status` reads out of persisted state, so
      // both diffs must be quiet regardless of what ran before them.
      const empty = { downloads: [], deletes: [], uploads: [], totalBytes: 0 };
      vi.mocked(computePullDiff).mockReturnValue(empty);
      vi.mocked(computePushDiff).mockReturnValue(empty);
    });

    it('surfaces a recorded deletion anomaly, not just the run that found it', async () => {
      // The daemon has no operator watching its log, so a refusal has to stay
      // visible somewhere the user actually looks.
      vi.mocked(loadSyncState).mockReturnValue({
        syncId: 'status-1', local: {}, remote: {}, updatedAt: '',
        deletionAnomalies: {
          local: {
            target: 'local', detectedAt: '2026-09-06T00:00:00.000Z', removedCount: 50, knownCount: 50,
            reason: 'the remote listing no longer contains any of the 50 document(s)',
          },
          remote: {
            target: 'remote', detectedAt: '2026-09-06T01:00:00.000Z', removedCount: 40, knownCount: 40,
            reason: 'the local scan no longer contains any of the 40 document(s)',
          },
        },
      });

      await program.parseAsync(['node', 'cli', 'sync', 'status', 'status-1', '--output', 'json']);

      const jsonOutput = outputSpy.stdout.find(l => l.includes('"deletionAnomalies"'));
      expect(jsonOutput).toBeDefined();
      // Both sides are reported independently: a refused push and a refused pull
      // are different conditions and neither may hide the other.
      const reported = JSON.parse(jsonOutput!).deletionAnomalies as Array<{ target: string; removedCount: number }>;
      expect(reported.map(a => a.target)).toEqual(['local', 'remote']);
      expect(reported[0].removedCount).toBe(50);
      expect(reported[1].removedCount).toBe(40);
    });

    it('lists deletions the server refused so the user knows why they keep coming back', async () => {
      vi.mocked(loadSyncState).mockReturnValue({
        syncId: 'status-1', local: {}, remote: {}, updatedAt: '',
        deniedDeletes: {
          'team/report.md': { deniedAt: '2026-09-01T00:00:00.000Z', reason: 'requires the admin role' },
        },
      });

      await program.parseAsync(['node', 'cli', 'sync', 'status', 'status-1', '--output', 'json']);

      const jsonOutput = outputSpy.stdout.find(l => l.includes('"deniedDeletes"'));
      expect(jsonOutput).toBeDefined();
      expect(JSON.parse(jsonOutput!).deniedDeletes).toEqual([
        { path: 'team/report.md', deniedAt: '2026-09-01T00:00:00.000Z', reason: 'requires the admin role' },
      ]);
    });

    it('says nothing when the sync is healthy', async () => {
      vi.mocked(loadSyncState).mockReturnValue({
        syncId: 'status-1', local: {}, remote: {}, updatedAt: '',
      });

      await program.parseAsync(['node', 'cli', 'sync', 'status', 'status-1', '--output', 'json']);

      const jsonOutput = outputSpy.stdout.find(l => l.startsWith('{'));
      const parsed = JSON.parse(jsonOutput!);
      expect(parsed.deletionAnomalies).toBeUndefined();
      expect(parsed.deniedDeletes).toBeUndefined();
    });
  });

  describe('sync watch shutdown', () => {
    it('waits for an in-flight poll and exits nonzero when its bounded drain fails', async () => {
      mockConfigs.push({
        id: 'watch-sync', vaultId: 'vault-1', localPath: '/tmp/test-vault', mode: 'sync',
        onConflict: 'newer', ignore: [], lastSyncAt: '', autoSync: false, rootMarkerVersion: 1,
      });
      let rejectPoller!: (reason: Error) => void;
      const stopPoller = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPoller = reject; }));
      mockCreateRemotePoller.mockReturnValueOnce({ stop: stopPoller });
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        void program.parseAsync(['node', 'cli', 'sync', 'watch', 'watch-sync']);
        await vi.waitFor(() => expect(mockCreateRemotePoller).toHaveBeenCalledOnce());

        process.emit('SIGINT');
        await vi.waitFor(() => expect(stopPoller).toHaveBeenCalledOnce());
        expect(exit).not.toHaveBeenCalled();

        rejectPoller(new Error('Poller shutdown drain timed out after 35000ms'));
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      } finally {
        exit.mockRestore();
      }
    });
  });

  describe('sync list', () => {
    it('should show empty message when no syncs configured', async () => {
      vi.mocked(loadSyncConfigs).mockReturnValue([]);

      await program.parseAsync(['node', 'cli', 'sync', 'list', '--output', 'text']);

      expect(outputSpy.stderr.some(l => l.includes('No sync configurations found'))).toBe(true);
    });

    it('should list configured syncs', async () => {
      vi.mocked(loadSyncConfigs).mockReturnValue([
        {
          id: 'sync-1',
          vaultId: 'vault-1',
          localPath: '/home/user/vault',
          mode: 'sync' as const,
          onConflict: 'newer' as const,
          ignore: [],
          lastSyncAt: '1970-01-01T00:00:00.000Z',
          autoSync: false,
        },
      ]);

      await program.parseAsync(['node', 'cli', 'sync', 'list']);

      expect(outputSpy.stdout.some(l => l.includes('sync-1'))).toBe(true);
      expect(outputSpy.stdout.some(l => l.includes('vault-1'))).toBe(true);
    });

    it('should output JSON when --output json', async () => {
      vi.mocked(loadSyncConfigs).mockReturnValue([
        {
          id: 'sync-1',
          vaultId: 'vault-1',
          localPath: '/home/user/vault',
          mode: 'sync' as const,
          onConflict: 'newer' as const,
          ignore: [],
          lastSyncAt: '2025-01-01T00:00:00.000Z',
          autoSync: true,
        },
      ]);

      await program.parseAsync(['node', 'cli', 'sync', 'list', '--output', 'json']);

      const jsonOutput = outputSpy.stdout.find(l => l.startsWith('['));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe('sync-1');
    });
  });

  describe('sync delete', () => {
    it('should delete sync config and state', async () => {
      mockConfigs.push({ id: 'sync-1' });

      await program.parseAsync(['node', 'cli', 'sync', 'delete', 'sync-1', '--yes']);

      expect(deleteSyncConfig).toHaveBeenCalledWith('sync-1');
      expect(deleteSyncState).toHaveBeenCalledWith('sync-1');
    });

    it('should report error when sync not found', async () => {
      vi.mocked(deleteSyncConfig).mockReturnValue(false);

      await program.parseAsync(['node', 'cli', 'sync', 'delete', 'nonexistent', '--yes']);

      expect(process.exitCode).toBe(1);
    });
  });

  describe('sync pull', () => {
    beforeEach(() => {
      mockConfigs.push({
        id: 'pull-1', vaultId: 'vault-1', localPath: '/tmp/test',
        mode: 'pull', onConflict: 'newer', ignore: [],
        lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
      });
    });

    it('should include unchanged count in JSON when up to date', async () => {
      // 5 remote files, no changes
      vi.mocked(scanRemoteFiles).mockResolvedValue({
        files: {
          'a.md': { path: 'a.md', hash: '', mtime: '', size: 0 },
          'b.md': { path: 'b.md', hash: '', mtime: '', size: 0 },
          'c.md': { path: 'c.md', hash: '', mtime: '', size: 0 },
          'd.md': { path: 'd.md', hash: '', mtime: '', size: 0 },
          'e.md': { path: 'e.md', hash: '', mtime: '', size: 0 },
        },
        listEtag: '',
        vaultUnchanged: false,
      });
      vi.mocked(computePullDiff).mockReturnValue({ downloads: [], deletes: [], uploads: [], totalBytes: 0 });

      await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-1', '--output', 'json']);

      const jsonOutput = outputSpy.stdout.find(l => l.includes('"unchanged"'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput!);
      expect(parsed.unchanged).toBe(5);
      expect(parsed.downloaded).toBe(0);
    });

    it('should output only JSON (no text status) when --dry-run and --output json', async () => {
      vi.mocked(scanRemoteFiles).mockResolvedValue({
        files: {
          'a.md': { path: 'a.md', hash: '', mtime: '', size: 100 },
          'b.md': { path: 'b.md', hash: '', mtime: '', size: 200 },
        },
        listEtag: '',
        vaultUnchanged: false,
      });
      vi.mocked(computePullDiff).mockReturnValue({
        downloads: [
          { path: 'a.md', action: 'create' as const, direction: 'pull' as const, sizeBytes: 100, reason: 'new' },
        ],
        deletes: [
          { path: 'old.md', action: 'delete' as const, direction: 'pull' as const, sizeBytes: 0, reason: 'removed' },
        ],
        uploads: [],
        totalBytes: 100,
      });

      await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-1', '--dry-run', '--output', 'json']);

      const stdout = outputSpy.stdout.join('');
      const stderr = outputSpy.stderr.join('');

      // JSON output must be present
      const jsonLine = outputSpy.stdout.find(l => l.startsWith('{'));
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!);
      expect(parsed.dryRun).toBe(true);
      expect(parsed.downloads).toBe(1);
      expect(parsed.deletes).toBe(1);
      expect(parsed.unchanged).toBe(1);
      expect(parsed.totalBytes).toBe(100);

      // Text status lines must NOT be present when output is json
      expect(stderr).not.toContain('Dry run');
      expect(stdout).not.toContain('Dry run');
    });

    it('should include unchanged count after pull with changes', async () => {
      vi.mocked(scanRemoteFiles).mockResolvedValue({
        files: {
          'a.md': { path: 'a.md', hash: '', mtime: '', size: 100 },
          'b.md': { path: 'b.md', hash: '', mtime: '', size: 200 },
          'c.md': { path: 'c.md', hash: '', mtime: '', size: 300 },
        },
        listEtag: '',
        vaultUnchanged: false,
      });
      vi.mocked(computePullDiff).mockReturnValue({
        downloads: [
          { path: 'a.md', action: 'create' as const, direction: 'pull' as const, sizeBytes: 100, reason: 'new' },
        ],
        deletes: [],
        uploads: [],
        totalBytes: 100,
      });
      vi.mocked(executePull).mockResolvedValue({
        filesDownloaded: 1, filesDeleted: 0, filesUploaded: 0,
        bytesTransferred: 100, errors: [],
      });

      await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-1', '--output', 'json']);

      const jsonOutput = outputSpy.stdout.find(l => l.includes('"unchanged"'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput!);
      expect(parsed.unchanged).toBe(2);
      expect(parsed.downloaded).toBe(1);
    });
  });

  describe('sync pull — mass-delete guard reporting', () => {
    beforeEach(() => {
      mockConfigs.push({
        id: 'pull-1', vaultId: 'vault-1', localPath: '/tmp/test',
        mode: 'pull', onConflict: 'newer', ignore: [],
        lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
      });
    });

    const anomaly = {
      target: 'local' as const,
      detectedAt: '2026-09-06T00:00:00.000Z',
      removedCount: 50,
      knownCount: 50,
      reason: 'the remote listing no longer contains any of the 50 document(s) this sync was tracking.',
    };

    it('warns about a refused deletion batch and records it in the sync state', async () => {
      vi.mocked(computePullDiff).mockReturnValueOnce({
        downloads: [], deletes: [], uploads: [], totalBytes: 0, deletionAnomaly: anomaly,
      });

      await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-1']);

      expect(outputSpy.stderr.join('')).toContain('Refused 50 local deletion(s)');
      expect(outputSpy.stderr.join('')).toContain('lsvault sync pull --allow-mass-delete');
      const saved = vi.mocked(saveSyncState).mock.calls.at(-1)?.[0];
      expect(saved?.deletionAnomalies?.local).toEqual(anomaly);
    });

    it('threads --allow-mass-delete into the diff', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-1', '--allow-mass-delete']);

      expect(computePullDiff).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), { allowMassDelete: true },
      );
    });

    it('does not set the flag by default', async () => {
      await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-1']);

      expect(computePullDiff).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), { allowMassDelete: false },
      );
    });

    it('reports the conflict copies executePull made while deleting', async () => {
      // Without the 7th argument wired, these copies were made and never mentioned.
      vi.mocked(computePullDiff).mockReturnValueOnce({
        downloads: [], uploads: [], totalBytes: 0,
        deletes: [{ path: 'notes.md', action: 'delete', direction: 'download', sizeBytes: 0, reason: 'Deleted from remote' }],
      });
      vi.mocked(executePull).mockImplementation(async (
        _client: unknown, _config: unknown, _diff: unknown, _onProgress?: unknown,
        _concurrency?: unknown, _onThrottle?: unknown,
        onConflict?: (docPath: string, conflictFile: string) => void,
      ) => {
        onConflict?.('notes.md', 'notes.conflicted.local.2026-09-06.md');
        return { filesDownloaded: 0, filesDeleted: 1, filesUploaded: 0, filesSkipped: 0, bytesTransferred: 0, errors: [], failed: false };
      });

      await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-1']);

      expect(outputSpy.stderr.join('')).toContain('notes.conflicted.local.2026-09-06.md');
    });
  });

  describe('sync push', () => {
    beforeEach(() => {
      mockConfigs.push({
        id: 'push-1', vaultId: 'vault-1', localPath: '/tmp/test',
        mode: 'push', onConflict: 'newer', ignore: [],
        lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
      });
    });

    it('should include unchanged count in JSON when up to date', async () => {
      vi.mocked(scanLocalFiles).mockReturnValue({
        'a.md': { path: 'a.md', hash: 'h1', mtime: '', size: 0 },
        'b.md': { path: 'b.md', hash: 'h2', mtime: '', size: 0 },
        'c.md': { path: 'c.md', hash: 'h3', mtime: '', size: 0 },
      });
      vi.mocked(computePushDiff).mockReturnValue({ downloads: [], deletes: [], uploads: [], totalBytes: 0 });

      await program.parseAsync(['node', 'cli', 'sync', 'push', 'push-1', '--output', 'json']);

      const jsonOutput = outputSpy.stdout.find(l => l.includes('"unchanged"'));
      expect(jsonOutput).toBeDefined();
      const parsed = JSON.parse(jsonOutput!);
      expect(parsed.unchanged).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Throttle / 429 UX tests
  //
  // The SDK retries 429 responses transparently (ky retry config).  When a
  // throttled request is ultimately resolved the CLI must:
  //   - Report success (exit 0, errors: 0 in JSON)
  //   - Show "Rate limited — waiting and retrying…" in the spinner
  //
  // These tests mock executePull/executePush to invoke the onThrottle callback
  // (5th arg for progress, 6th arg for concurrency, 7th… wait — actual
  // signatures: executePull(client, config, diff, onProgress?, concurrency?,
  // onThrottle?)).  The mock receives all args; we capture the onThrottle cb
  // and call it to simulate the SDK observing a 429.
  // -----------------------------------------------------------------------
  describe('throttle / rate-limit UX', () => {
    describe('sync pull — 429 retried to success', () => {
      beforeEach(() => {
        mockConfigs.push({
          id: 'pull-throttle', vaultId: 'vault-1', localPath: '/tmp/test',
          mode: 'pull', onConflict: 'newer', ignore: [],
          lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
        });
      });

      it('reports success (errors: 0, exit 0) when pull is throttled then succeeds', async () => {
        vi.mocked(scanRemoteFiles).mockResolvedValue({
          files: {
            'notes/a.md': { path: 'notes/a.md', hash: 'h1', mtime: '', size: 100 },
          },
          listEtag: 'etag-1',
          vaultUnchanged: false,
        });
        vi.mocked(computePullDiff).mockReturnValue({
          downloads: [{ path: 'notes/a.md', action: 'create' as const, direction: 'pull' as const, sizeBytes: 100, reason: 'new' }],
          deletes: [],
          uploads: [],
          totalBytes: 100,
        });

        // Simulate SDK transparently retrying a 429: onThrottle is called but
        // the overall executePull still succeeds (no errors).
        vi.mocked(executePull).mockImplementationOnce(async (
          _client,
          _config,
          _diff,
          _onProgress,
          _concurrency,
          onThrottle,
        ) => {
          // Simulate the SDK encountering a 429 mid-transfer and calling back
          onThrottle?.('notes/a.md');
          // ...but ultimately succeeding
          return { filesDownloaded: 1, filesDeleted: 0, filesUploaded: 0, bytesTransferred: 100, errors: [] };
        });

        await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-throttle', '--output', 'json']);

        // Exit code must be 0 (success, not failure)
        expect(process.exitCode).not.toBe(1);

        // JSON output must record success — no spurious error
        const jsonLine = outputSpy.stdout.find(l => l.includes('"errors"'));
        expect(jsonLine).toBeDefined();
        const parsed = JSON.parse(jsonLine!);
        expect(parsed.errors).toBe(0);
        expect(parsed.downloaded).toBe(1);
      });

      it('passes an onThrottle callback to executePull so the spinner can show "Rate limited"', async () => {
        vi.mocked(scanRemoteFiles).mockResolvedValue({
          files: { 'doc.md': { path: 'doc.md', hash: 'h1', mtime: '', size: 50 } },
          listEtag: 'etag-2',
          vaultUnchanged: false,
        });
        vi.mocked(computePullDiff).mockReturnValue({
          downloads: [{ path: 'doc.md', action: 'create' as const, direction: 'pull' as const, sizeBytes: 50, reason: 'new' }],
          deletes: [],
          uploads: [],
          totalBytes: 50,
        });

        let capturedThrottleCb: ((file: string) => void) | undefined;

        vi.mocked(executePull).mockImplementationOnce(async (
          _client,
          _config,
          _diff,
          _onProgress,
          _concurrency,
          onThrottle,
        ) => {
          capturedThrottleCb = onThrottle as ((file: string) => void) | undefined;
          return { filesDownloaded: 1, filesDeleted: 0, filesUploaded: 0, bytesTransferred: 50, errors: [] };
        });

        await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-throttle']);

        // The command must wire a throttle callback so the SDK can signal rate-limiting
        expect(capturedThrottleCb).toBeDefined();
        expect(typeof capturedThrottleCb).toBe('function');

        // Calling it must not throw — it updates the spinner (or is a no-op in non-TTY tests)
        expect(() => capturedThrottleCb?.('doc.md')).not.toThrow();
      });
    });

    describe('sync push — 429 retried to success', () => {
      beforeEach(() => {
        mockConfigs.push({
          id: 'push-throttle', vaultId: 'vault-1', localPath: '/tmp/test',
          mode: 'push', onConflict: 'newer', ignore: [],
          lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
        });
      });

      it('reports success (errors: 0, exit 0) when push is throttled then succeeds', async () => {
        vi.mocked(scanLocalFiles).mockReturnValue({
          'notes/b.md': { path: 'notes/b.md', hash: 'h2', mtime: '', size: 200 },
        });
        vi.mocked(computePushDiff).mockReturnValue({
          downloads: [],
          deletes: [],
          uploads: [{ path: 'notes/b.md', action: 'create' as const, direction: 'push' as const, sizeBytes: 200, reason: 'new' }],
          totalBytes: 200,
        });

        vi.mocked(executePush).mockImplementationOnce(async (
          _client, _config, _diff, _onProgress, _concurrency, onThrottle,
        ) => {
          // SDK encountered 429 but backed off and ultimately succeeded
          onThrottle?.('notes/b.md');
          return { filesDownloaded: 0, filesDeleted: 0, filesUploaded: 1, bytesTransferred: 200, errors: [] };
        });

        await program.parseAsync(['node', 'cli', 'sync', 'push', 'push-throttle', '--output', 'json']);

        expect(process.exitCode).not.toBe(1);

        const jsonLine = outputSpy.stdout.find(l => l.includes('"errors"'));
        expect(jsonLine).toBeDefined();
        const parsed = JSON.parse(jsonLine!);
        expect(parsed.errors).toBe(0);
        expect(parsed.uploaded).toBe(1);
      });
    });

    describe('sync pull — 429 exhausted (SDK retries depleted)', () => {
      beforeEach(() => {
        mockConfigs.push({
          id: 'pull-429-fail', vaultId: 'vault-1', localPath: '/tmp/test',
          mode: 'pull', onConflict: 'newer', ignore: [],
          lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
        });
      });

      it('records the error when 429 exhausts all SDK retries', async () => {
        vi.mocked(scanRemoteFiles).mockResolvedValue({
          files: { 'doc.md': { path: 'doc.md', hash: 'h1', mtime: '', size: 50 } },
          listEtag: '',
          vaultUnchanged: false,
        });
        vi.mocked(computePullDiff).mockReturnValue({
          downloads: [{ path: 'doc.md', action: 'create' as const, direction: 'pull' as const, sizeBytes: 50, reason: 'new' }],
          deletes: [],
          uploads: [],
          totalBytes: 50,
        });

        // SDK threw after exhausting retries — one error recorded
        vi.mocked(executePull).mockResolvedValueOnce({
          filesDownloaded: 0, filesDeleted: 0, filesUploaded: 0, bytesTransferred: 0,
          errors: [{ path: 'doc.md', error: 'HTTP 429 Too Many Requests' }],
        });

        await program.parseAsync(['node', 'cli', 'sync', 'pull', 'pull-429-fail', '--output', 'json']);

        const jsonLine = outputSpy.stdout.find(l => l.includes('"errors"'));
        expect(jsonLine).toBeDefined();
        const parsed = JSON.parse(jsonLine!);
        // The error is recorded in the result so the operator knows about it
        expect(parsed.errors).toBe(1);
        expect(parsed.downloaded).toBe(0);
        // A partial result is still a failed run for scripts and cron.
        expect(process.exitCode).toBe(1);
      });
    });

    describe('sync push — partial failure exit code', () => {
      it('exits nonzero when a push completes with errors', async () => {
        mockConfigs.push({
          id: 'push-err', vaultId: 'vault-1', localPath: '/tmp/test',
          mode: 'push', onConflict: 'newer', ignore: [],
          lastSyncAt: '1970-01-01T00:00:00.000Z', autoSync: false,
        });
        vi.mocked(scanLocalFiles).mockReturnValue({ 'doc.md': { path: 'doc.md', hash: 'h1', mtime: '', size: 50 } });
        vi.mocked(computePushDiff).mockReturnValue({
          uploads: [{ path: 'doc.md', action: 'create' as const, direction: 'push' as const, sizeBytes: 50, reason: 'new' }],
          deletes: [], downloads: [], totalBytes: 50,
        });
        vi.mocked(executePush).mockResolvedValueOnce({
          filesDownloaded: 0, filesDeleted: 0, filesUploaded: 0, filesSkipped: 0, bytesTransferred: 0,
          errors: [{ path: 'doc.md', error: 'Remote delete was forbidden (403)', retryable: false }], failed: true,
        });

        await program.parseAsync(['node', 'cli', 'sync', 'push', 'push-err', '--output', 'json']);

        expect(process.exitCode).toBe(1);
        expect(outputSpy.stderr.join('')).toContain('forbidden (403)');
      });
    });
  });
});
