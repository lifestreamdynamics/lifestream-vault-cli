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

// Mock state module
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

describe('sync watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWatcher.on.mockReturnThis();
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
});
