import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
vi.mock('./root-marker.js', () => ({ assertSyncRoot: vi.fn() }));
const mockedFs = vi.mocked(fs);

// Mock chokidar
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
  once: vi.fn().mockReturnThis(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock('chokidar', () => ({
  watch: vi.fn(() => mockWatcher),
}));

// Mock state module — use inline vi.fn() in factory (no closure references)
vi.mock('./state.js', () => ({
  loadSyncState: vi.fn(() => ({
    syncId: 'sync-1',
    local: {},
    remote: {},
    updatedAt: '',
  })),
  saveSyncState: vi.fn(),
  hashFileContent: vi.fn((content: string) => `hash-${content.slice(0, 8)}`),
  buildRemoteFileState: vi.fn((docPath: string, content: string, updatedAt: string) => ({
    path: docPath,
    hash: `hash-${content.slice(0, 8)}`,
    mtime: updatedAt,
    size: content.length,
  })),
}));

vi.mock('./config.js', () => ({
  updateLastSync: vi.fn(),
}));

vi.mock('./ignore.js', () => ({
  shouldIgnore: vi.fn(() => false),
}));

vi.mock('./conflict.js', () => ({
  detectConflict: vi.fn(() => false),
  resolveConflict: vi.fn(() => 'local'),
  createConflictFile: vi.fn(() => 'conflict-path.md'),
  formatConflictLog: vi.fn(() => 'conflict log'),
}));

// Import mocked modules after vi.mock so we can configure them per test
import { loadSyncState, saveSyncState, hashFileContent } from './state.js';
import { detectConflict, resolveConflict } from './conflict.js';

const mockLoadSyncState = vi.mocked(loadSyncState);
const mockSaveSyncState = vi.mocked(saveSyncState);
const mockHashFileContent = vi.mocked(hashFileContent);
const mockDetectConflict = vi.mocked(detectConflict);
const mockResolveConflict = vi.mocked(resolveConflict);

import { createWatcher } from './watcher.js';
import { watch } from 'chokidar';
import { assertSyncRoot } from './root-marker.js';
import type { SyncConfig } from './types.js';

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'sync-12345678-abcd-efgh',
    vaultId: 'vault-1',
    localPath: '/home/user/vault',
    mode: 'sync',
    onConflict: 'newer',
    ignore: [],
    lastSyncAt: '1970-01-01T00:00:00.000Z',
    autoSync: false,
    ...overrides,
  };
}

/**
 * Triggers the 'change' event on the mock watcher and waits for the async
 * handleFileChange handler to run (debounce is set to 0ms in test configs).
 */
async function triggerChange(absPath: string): Promise<void> {
  // The 'change' event callback is registered via watcher.on('change', handler)
  // Find it in mockWatcher.on's call list
  const changeCall = mockWatcher.on.mock.calls.find(
    (args: unknown[]) => args[0] === 'change',
  );
  const changeHandler = changeCall?.[1] as ((absPath: string) => void) | undefined;
  if (!changeHandler) throw new Error('No "change" handler registered on watcher');
  changeHandler(absPath);
  // Wait for debounce (0ms) + async handler execution
  await new Promise(r => setTimeout(r, 50));
}

async function triggerUnlink(absPath: string): Promise<void> {
  const call = mockWatcher.on.mock.calls.find((args: unknown[]) => args[0] === 'unlink');
  const handler = call?.[1] as ((absPath: string) => void) | undefined;
  if (!handler) throw new Error('No "unlink" handler registered on watcher');
  handler(absPath);
  await new Promise(r => setTimeout(r, 50));
}

describe('sync watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcher.on.mockReturnThis();
    mockWatcher.once.mockReturnThis();
    // Reset loadSyncState to default empty state
    mockLoadSyncState.mockReturnValue({
      syncId: 'sync-1',
      local: {},
      remote: {},
      updatedAt: '',
    });
    mockHashFileContent.mockImplementation((content: string) => `hash-${content.slice(0, 8)}`);
    mockDetectConflict.mockReturnValue(false);
    mockResolveConflict.mockReturnValue('local');
  });

  it('should create a chokidar watcher', () => {
    const client = {} as any;
    const config = makeConfig();

    createWatcher(client, config, { ignorePatterns: [] });

    expect(watch).toHaveBeenCalledWith(
      config.localPath,
      expect.objectContaining({
        ignoreInitial: true,
        persistent: true,
      }),
    );
  });

  it('should register event handlers', () => {
    const client = {} as any;
    const config = makeConfig();

    createWatcher(client, config, { ignorePatterns: [] });

    const events = mockWatcher.on.mock.calls.map((args: unknown[]) => args[0]);
    expect(events).toContain('add');
    expect(events).toContain('change');
    expect(events).toContain('unlink');
    expect(events).toContain('error');
    expect(mockWatcher.once).toHaveBeenCalledWith('ready', expect.any(Function));
  });

  it('resolves readiness only after chokidar emits ready', async () => {
    const { ready } = createWatcher({} as any, makeConfig(), { ignorePatterns: [] });
    let settled = false;
    void ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const readyHandler = mockWatcher.once.mock.calls.find((args: unknown[]) => args[0] === 'ready')?.[1] as (() => void);
    readyHandler();
    await expect(ready).resolves.toBeUndefined();
  });

  it('rejects readiness when chokidar errors before ready', async () => {
    const onError = vi.fn();
    const { ready } = createWatcher({} as any, makeConfig(), { ignorePatterns: [], onError });
    const errorHandler = mockWatcher.on.mock.calls.find((args: unknown[]) => args[0] === 'error')?.[1] as ((err: Error) => void);
    errorHandler(new Error('watch setup failed'));

    await expect(ready).rejects.toThrow('watch setup failed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'watch setup failed' }));
  });

  it('suppresses a poller-originated local write from being uploaded again', async () => {
    const put = vi.fn();
    const { markLocalWrite } = createWatcher({ documents: { put } } as any, makeConfig(), {
      ignorePatterns: [], debounceMs: 0,
    });
    markLocalWrite('notes/pulled.md');

    await triggerChange('/home/user/vault/notes/pulled.md');

    expect(put).not.toHaveBeenCalled();
  });

  it('serializes operations that share the sync-state file', async () => {
    const { serialize } = createWatcher({} as any, makeConfig(), { ignorePatterns: [] });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = serialize(async () => {
      order.push('first:start');
      await new Promise<void>(resolve => { releaseFirst = resolve; });
      order.push('first:end');
    });
    const second = serialize(async () => { order.push('second'); });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('should stop watcher and clear pending changes', async () => {
    const client = {} as any;
    const config = makeConfig();

    const { stop } = createWatcher(client, config, { ignorePatterns: [] });

    await stop();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it('drains a slow upload before shutdown completes', async () => {
    const content = '# pending upload';
    mockedFs.readFileSync.mockReturnValue(content as any);
    let releaseUpload!: () => void;
    const put = vi.fn(() => new Promise<void>(resolve => { releaseUpload = resolve; }));
    const { stop } = createWatcher({ documents: { put } } as any, makeConfig({ mode: 'push' }), {
      ignorePatterns: [], debounceMs: 0, shutdownTimeoutMs: 1_000,
    });

    const changeHandler = mockWatcher.on.mock.calls.find(
      (args: unknown[]) => args[0] === 'change',
    )?.[1] as (absPath: string) => void;
    changeHandler('/home/user/vault/notes/pending.md');
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseUpload();
    await stopping;
    expect(mockSaveSyncState).toHaveBeenCalled();
  });

  it('rejects shutdown when an upload exceeds the bounded drain deadline', async () => {
    mockedFs.readFileSync.mockReturnValue('# stalled upload' as any);
    const put = vi.fn(() => new Promise<void>(() => undefined));
    const { stop } = createWatcher({ documents: { put } } as any, makeConfig({ mode: 'push' }), {
      ignorePatterns: [], debounceMs: 0, shutdownTimeoutMs: 5,
    });
    const changeHandler = mockWatcher.on.mock.calls.find(
      (args: unknown[]) => args[0] === 'change',
    )?.[1] as (absPath: string) => void;
    changeHandler('/home/user/vault/notes/stalled.md');
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());

    await expect(stop()).rejects.toThrow('Watcher shutdown drain timed out after 5ms');
  });

  it('should call onLog callback', () => {
    const onLog = vi.fn();
    const client = {} as any;
    const config = makeConfig();

    createWatcher(client, config, { ignorePatterns: [], onLog });

    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining('Watching for changes'),
    );
  });

  it('should use custom debounce', () => {
    const client = {} as any;
    const config = makeConfig();

    createWatcher(client, config, { ignorePatterns: [], debounceMs: 1000 });

    expect(watch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        awaitWriteFinish: { stabilityThreshold: 1000 },
      }),
    );
  });

  it('does not delete remotely when the root becomes invalid', async () => {
    const deleteRemote = vi.fn();
    const onError = vi.fn();
    vi.mocked(assertSyncRoot)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('Sync root marker is missing'); });
    createWatcher({ documents: { delete: deleteRemote } } as any, makeConfig({ mode: 'push' }), {
      ignorePatterns: [], debounceMs: 0, onError,
    });

    await triggerUnlink('/home/user/vault/notes/deleted.md');

    expect(deleteRemote).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/marker is missing/) }));
  });

  // -----------------------------------------------------------------------
  // Phase 2: conditional GET tests for the conflict-check fetch
  // -----------------------------------------------------------------------

  it('conflict-check: 304 response — no conflict detected, push proceeds', async () => {
    const localContent = '# Local File\n\nContent.';
    const lastRemoteHash = `hash-${localContent.slice(0, 8)}`;

    // State has lastRemote set so conflict check is triggered
    mockLoadSyncState.mockReturnValue({
      syncId: 'sync-1',
      local: {},
      remote: {
        'notes/test.md': {
          path: 'notes/test.md',
          hash: lastRemoteHash,
          mtime: '2026-01-01T00:00:00.000Z',
          size: 100,
        },
      },
      updatedAt: '',
    });
    mockedFs.readFileSync.mockReturnValue(localContent as any);
    mockHashFileContent.mockImplementation((c: string) => `hash-${c.slice(0, 8)}`);

    const mockGet = vi.fn().mockResolvedValue({ notModified: true, etag: `"${lastRemoteHash}"` });
    const mockPut = vi.fn().mockResolvedValue({});
    const client = { documents: { get: mockGet, put: mockPut } } as any;

    const onLog = vi.fn();
    createWatcher(client, makeConfig({ mode: 'sync' }), { ignorePatterns: [], debounceMs: 0, onLog });

    await triggerChange('/home/user/vault/notes/test.md');

    // get() should have been called with ifNoneMatch
    expect(mockGet).toHaveBeenCalledWith(
      'vault-1',
      'notes/test.md',
      { ifNoneMatch: `"${lastRemoteHash}"` },
    );
    // 304 → no conflict → push proceeds
    expect(mockPut).toHaveBeenCalledWith('vault-1', 'notes/test.md', localContent);
  });

  it('conflict-check: server failure aborts instead of overwriting remote state', async () => {
    mockLoadSyncState.mockReturnValue({
      syncId: 'sync-1',
      local: {},
      remote: {
        'notes/test.md': { path: 'notes/test.md', hash: 'known', mtime: '2026-01-01T00:00:00.000Z', size: 10 },
      },
      updatedAt: '',
    });
    mockedFs.readFileSync.mockReturnValue('# local edit' as any);
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('server unavailable'), { statusCode: 500 }));
    const put = vi.fn();
    const onError = vi.fn();
    createWatcher({ documents: { get, put } } as any, makeConfig({ mode: 'sync' }), {
      ignorePatterns: [], debounceMs: 0, onError,
    });

    await triggerChange('/home/user/vault/notes/test.md');

    expect(put).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'server unavailable' }));
  });

  it('local delete with a concurrent remote edit restores the remote version under remote policy', async () => {
    const remoteContent = '# concurrent remote edit';
    mockLoadSyncState.mockReturnValue({
      syncId: 'sync-1',
      local: {
        'notes/deleted.md': { path: 'notes/deleted.md', hash: 'old', mtime: '2026-01-01T00:00:00.000Z', size: 10 },
      },
      remote: {
        'notes/deleted.md': { path: 'notes/deleted.md', hash: 'old', mtime: '2026-01-01T00:00:00.000Z', size: 10 },
      },
      updatedAt: '',
    });
    mockResolveConflict.mockReturnValue('remote');
    mockedFs.existsSync.mockReturnValue(false);
    const get = vi.fn().mockResolvedValue({
      notModified: false,
      content: remoteContent,
      document: { updatedAt: '2026-06-01T00:00:00.000Z' },
    });
    const deleteRemote = vi.fn();
    createWatcher({ documents: { get, delete: deleteRemote } } as any, makeConfig({ mode: 'sync', onConflict: 'remote' }), {
      ignorePatterns: [], debounceMs: 0,
    });

    await triggerUnlink('/home/user/vault/notes/deleted.md');

    expect(get).toHaveBeenCalledWith('vault-1', 'notes/deleted.md', { ifNoneMatch: '"old"' });
    expect(deleteRemote).not.toHaveBeenCalled();
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(expect.stringContaining('.tmp.'), remoteContent, 'utf-8');
    expect(mockedFs.renameSync).toHaveBeenCalledWith(expect.stringContaining('.tmp.'), '/home/user/vault/notes/deleted.md');
    expect(mockSaveSyncState).toHaveBeenCalled();
  });

  it('conflict-check: 200 + matching hash — push proceeds (list/cache mismatch)', async () => {
    const localContent = '# Same On Both Sides';
    const hash = `hash-${localContent.slice(0, 8)}`;

    mockLoadSyncState.mockReturnValue({
      syncId: 'sync-1',
      local: {},
      remote: {
        'notes/same.md': { path: 'notes/same.md', hash, mtime: '2026-01-01T00:00:00.000Z', size: 100 },
      },
      updatedAt: '',
    });
    mockedFs.readFileSync.mockReturnValue(localContent as any);
    mockHashFileContent.mockImplementation((c: string) => `hash-${c.slice(0, 8)}`);
    mockDetectConflict.mockReturnValue(false);

    // Server returns 200 but the content hash matches our last-known hash
    const mockGet = vi.fn().mockResolvedValue({
      notModified: false,
      etag: `"${hash}"`,
      document: { updatedAt: '2026-01-01T00:00:00.000Z' },
      content: localContent,
    });
    const mockPut = vi.fn().mockResolvedValue({});
    const client = { documents: { get: mockGet, put: mockPut } } as any;

    createWatcher(client, makeConfig({ mode: 'sync' }), { ignorePatterns: [], debounceMs: 0 });

    await triggerChange('/home/user/vault/notes/same.md');

    // get() called with ifNoneMatch
    expect(mockGet).toHaveBeenCalledWith('vault-1', 'notes/same.md', { ifNoneMatch: `"${hash}"` });
    // No conflict detected (hash matches) — push proceeds
    expect(mockPut).toHaveBeenCalledWith('vault-1', 'notes/same.md', localContent);
  });

  it('conflict-check: 200 + different hash — conflict handler invoked', async () => {
    const localContent = '# Local version';
    const remoteContent = '# Remote version with changes';
    const localHash = `hash-${localContent.slice(0, 8)}`;
    const remoteHash = `hash-${remoteContent.slice(0, 8)}`;
    const lastRemoteHash = 'hash-original';

    mockLoadSyncState.mockReturnValue({
      syncId: 'sync-1',
      local: {
        'notes/conflict.md': { path: 'notes/conflict.md', hash: 'hash-original', mtime: '2026-01-01T00:00:00.000Z', size: 100 },
      },
      remote: {
        'notes/conflict.md': { path: 'notes/conflict.md', hash: lastRemoteHash, mtime: '2026-01-01T00:00:00.000Z', size: 100 },
      },
      updatedAt: '',
    });
    mockedFs.readFileSync.mockReturnValue(localContent as any);
    mockedFs.existsSync.mockReturnValue(true);
    mockHashFileContent.mockImplementation((c: string) => {
      if (c === localContent) return localHash;
      if (c === remoteContent) return remoteHash;
      return `hash-${c.slice(0, 8)}`;
    });
    // detectConflict returns true → conflict handler is invoked
    mockDetectConflict.mockReturnValue(true);

    const mockGet = vi.fn().mockResolvedValue({
      notModified: false,
      etag: `"${remoteHash}"`,
      document: { updatedAt: '2026-03-01T10:00:00.000Z' },
      content: remoteContent,
    });
    const mockPut = vi.fn().mockResolvedValue({});
    const client = { documents: { get: mockGet, put: mockPut } } as any;

    createWatcher(client, makeConfig({ mode: 'sync', onConflict: 'local' }), { ignorePatterns: [], debounceMs: 0 });

    await triggerChange('/home/user/vault/notes/conflict.md');

    // get() called with ifNoneMatch against last-known remote hash
    expect(mockGet).toHaveBeenCalledWith('vault-1', 'notes/conflict.md', { ifNoneMatch: `"${lastRemoteHash}"` });
    // detectConflict was called — conflict handler ran
    expect(mockDetectConflict).toHaveBeenCalled();
  });
});
