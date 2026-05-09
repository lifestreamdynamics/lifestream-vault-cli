import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
const mockedFs = vi.mocked(fs);

// Mock chokidar
const mockWatcher = {
  on: vi.fn().mockReturnThis(),
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
import { detectConflict } from './conflict.js';

const mockLoadSyncState = vi.mocked(loadSyncState);
const mockSaveSyncState = vi.mocked(saveSyncState);
const mockHashFileContent = vi.mocked(hashFileContent);
const mockDetectConflict = vi.mocked(detectConflict);

import { createWatcher } from './watcher.js';
import { watch } from 'chokidar';
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

describe('sync watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcher.on.mockReturnThis();
    // Reset loadSyncState to default empty state
    mockLoadSyncState.mockReturnValue({
      syncId: 'sync-1',
      local: {},
      remote: {},
      updatedAt: '',
    });
    mockHashFileContent.mockImplementation((content: string) => `hash-${content.slice(0, 8)}`);
    mockDetectConflict.mockReturnValue(false);
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
  });

  it('should stop watcher and clear pending changes', async () => {
    const client = {} as any;
    const config = makeConfig();

    const { stop } = createWatcher(client, config, { ignorePatterns: [] });

    await stop();

    expect(mockWatcher.close).toHaveBeenCalled();
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
