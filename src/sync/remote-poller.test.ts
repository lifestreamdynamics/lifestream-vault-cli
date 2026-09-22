/**
 * Tests for the remote poller.
 * Verifies that the poll() function uses syncList for efficient conditional
 * polling, and only issues per-document GETs when content genuinely changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node:fs');
vi.mock('./root-marker.js', () => ({ assertSyncRoot: vi.fn(), SYNC_ROOT_MARKER: '.lsvault-sync-root' }));
const mockedFs = vi.mocked(fs);

// ---- SDK mock (factory only references literals, no closures) ----
vi.mock('@lifestreamdynamics/vault-sdk', () => ({
  LifestreamVaultClient: vi.fn(function() {
    return {
      documents: {
        syncList: vi.fn(),
        get: vi.fn(),
        put: vi.fn(),
      },
    };
  }),
}));

// ---- Sync module mocks (use inline vi.fn(), no closure references) ----
vi.mock('./state.js', () => ({
  loadSyncState: vi.fn(() => ({
    syncId: 'sync-12345678-abcd-efgh',
    local: {},
    remote: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
  })),
  saveSyncState: vi.fn(),
  hashFileContent: vi.fn((content: string) => `sha256-${content.slice(0, 16)}`),
  buildRemoteFileState: vi.fn((docPath: string, content: string, updatedAt: string) => ({
    path: docPath,
    hash: `sha256-${content.slice(0, 16)}`,
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
import { loadSyncState, saveSyncState, hashFileContent, buildRemoteFileState } from './state.js';
import { updateLastSync } from './config.js';

const mockLoadSyncState = vi.mocked(loadSyncState);
const mockSaveSyncState = vi.mocked(saveSyncState);
const mockHashFileContent = vi.mocked(hashFileContent);
const mockBuildRemoteFileState = vi.mocked(buildRemoteFileState);
const mockUpdateLastSync = vi.mocked(updateLastSync);

import { createRemotePoller, clampPollIntervalMs, DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS } from './remote-poller.js';
import { assertSyncRoot } from './root-marker.js';
import type { SyncConfig, SyncState } from './types.js';

// ---- helpers ----

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'sync-12345678-abcd-efgh',
    vaultId: 'vault-abc',
    localPath: '/home/user/vault',
    mode: 'sync',
    onConflict: 'newer',
    ignore: [],
    lastSyncAt: '1970-01-01T00:00:00.000Z',
    autoSync: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    syncId: 'sync-12345678-abcd-efgh',
    local: {},
    remote: {},
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRemoteFileState(docPath: string, hash: string, mtime = '2026-01-01T00:00:00.000Z') {
  return { path: docPath, hash, mtime, size: 100 };
}

/**
 * Filler entries for the tracked remote state.
 *
 * The mass-delete guard refuses a batch that removes every tracked path, so a
 * test about *one* ordinary deletion needs a realistic baseline around it.
 */
function trackedPaths(count: number): Record<string, ReturnType<typeof makeRemoteFileState>> {
  const files: Record<string, ReturnType<typeof makeRemoteFileState>> = {};
  for (let i = 0; i < count; i++) {
    files[`tracked-${i}.md`] = makeRemoteFileState(`tracked-${i}.md`, `hash-${i}`);
  }
  return files;
}

function makeClient() {
  const syncList = vi.fn();
  const get = vi.fn();
  const put = vi.fn();
  return {
    documents: { syncList, get, put },
    _syncList: syncList,
    _get: get,
    _put: put,
  };
}

// ---- tests ----

describe('remote-poller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.lstatSync.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    // Default fs stubs
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.openSync.mockReturnValue(7);
    mockedFs.writeSync.mockReturnValue(0);
    mockedFs.fsyncSync.mockImplementation(() => undefined);
    mockedFs.closeSync.mockImplementation(() => undefined);
    mockedFs.chmodSync.mockImplementation(() => undefined);
    mockedFs.renameSync.mockImplementation(() => undefined);
    mockedFs.unlinkSync.mockImplementation(() => undefined);
    mockedFs.readFileSync.mockReturnValue('file-content' as any);
    mockedFs.statSync.mockReturnValue({ mtime: new Date('2026-01-01T00:00:00.000Z') } as any);

    // Reset hash fn to default
    mockHashFileContent.mockImplementation((content: string) => `sha256-${content.slice(0, 16)}`);
    mockBuildRemoteFileState.mockImplementation((docPath: string, content: string, updatedAt: string) => ({
      path: docPath,
      hash: `sha256-${content.slice(0, 16)}`,
      mtime: updatedAt,
      size: content.length,
    }));
  });

  it('performs zero network operations when the root is invalid', async () => {
    vi.mocked(assertSyncRoot).mockImplementationOnce(() => { throw new Error('Sync root marker is missing'); });
    const client = makeClient();
    const onError = vi.fn();
    const poller = createRemotePoller(client as any, makeConfig(), { ignorePatterns: [], intervalMs: 60_000, onError });
    await new Promise(r => setTimeout(r, 25));
    await poller.stop();
    expect(client._syncList).not.toHaveBeenCalled();
    expect(client._get).not.toHaveBeenCalled();
    expect(client._put).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('uses the shared serializer and marks downloaded files before writing them', async () => {
    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [{ path: 'notes/pulled.md', contentHash: 'new', fileModifiedAt: '2026-05-01T00:00:00.000Z', kind: 'created' }],
      removed: [], unchanged: [], listEtag: 'W/"new"',
    });
    client._get.mockResolvedValue({ content: 'remote content', document: { updatedAt: '2026-05-01T00:00:00.000Z' } });
    const serialize = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const onLocalWrite = vi.fn();

    const poller = createRemotePoller(client as any, makeConfig(), {
      ignorePatterns: [], intervalMs: 60_000, serialize, onLocalWrite,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    expect(serialize).toHaveBeenCalledOnce();
    // The hash travels with the mark: the watcher suppresses an event only when
    // the file still holds exactly these bytes.
    expect(onLocalWrite).toHaveBeenCalledWith('notes/pulled.md', 'sha256-remote content');
  });

  it.each(['../outside.md', '/tmp/absolute.md', 'notes\\windows-escape.md', '.lsvault-sync-root'])(
    'rejects unsafe remote path %s before download or filesystem mutation',
    async unsafePath => {
      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [{ path: unsafePath, contentHash: 'new', fileModifiedAt: '2026-05-01T00:00:00.000Z', kind: 'created' }],
        removed: [], unchanged: [], listEtag: 'W/"new"',
      });
      const onError = vi.fn();
      const poller = createRemotePoller(client as any, makeConfig(), {
        ignorePatterns: [], intervalMs: 60_000, onError,
      });
      await poller.stop();

      expect(client._get).not.toHaveBeenCalled();
      expect(mockedFs.writeSync).not.toHaveBeenCalled();
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Unsafe|reserved/) }));
    },
  );

  it('drains a slow download before shutdown completes', async () => {
    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [{ path: 'notes/slow.md', contentHash: 'new', fileModifiedAt: '2026-05-01T00:00:00.000Z', kind: 'created' }],
      removed: [], unchanged: [], listEtag: 'W/"new"',
    });
    let releaseDownload!: (value: unknown) => void;
    client._get.mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const poller = createRemotePoller(client as any, makeConfig(), {
      ignorePatterns: [], intervalMs: 60_000, shutdownTimeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(client._get).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = poller.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseDownload({ content: '# downloaded', document: { updatedAt: '2026-05-01T00:00:00.000Z' } });
    await stopping;
    expect(mockedFs.writeSync).toHaveBeenCalled();
    expect(mockSaveSyncState).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Case 1: Steady-state unchanged
  // syncList returns vaultUnchanged: true → zero documents.get calls
  // -----------------------------------------------------------------------
  it('steady-state: syncList returns vaultUnchanged — no document GETs issued', async () => {
    const config = makeConfig();
    const state = makeState({
      remote: {
        'notes/a.md': makeRemoteFileState('notes/a.md', 'hash-aaa'),
        'notes/b.md': makeRemoteFileState('notes/b.md', 'hash-bbb'),
      },
      remoteListEtag: 'W/"etag-1"',
    });
    mockLoadSyncState.mockReturnValue(state);

    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: true,
      changes: [],
      removed: [],
      unchanged: ['notes/a.md', 'notes/b.md'],
      listEtag: 'W/"etag-1"',
    });

    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    expect(client._syncList).toHaveBeenCalledTimes(1);
    expect(client._syncList).toHaveBeenCalledWith(
      config.vaultId,
      expect.objectContaining({
        hashes: { 'notes/a.md': 'hash-aaa', 'notes/b.md': 'hash-bbb' },
        listEtag: 'W/"etag-1"',
      }),
    );
    expect(client._get).not.toHaveBeenCalled();
    // State should NOT be saved when vault is unchanged
    expect(mockSaveSyncState).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Case 2: One doc's hash changed → exactly one conditional GET
  // -----------------------------------------------------------------------
  it('changed doc: issues exactly one conditional GET with correct If-None-Match', async () => {
    const config = makeConfig();
    const state = makeState({
      remote: {
        'notes/changed.md': makeRemoteFileState('notes/changed.md', 'old-hash-123'),
      },
    });
    mockLoadSyncState.mockReturnValue(state);

    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [{
        path: 'notes/changed.md',
        contentHash: 'new-hash-456',
        fileModifiedAt: '2026-05-01T10:00:00.000Z',
        kind: 'changed',
      }],
      removed: [],
      unchanged: [],
      listEtag: 'W/"etag-2"',
    });
    // Simulate server returning 200 with new content
    const newContent = 'updated document content';
    client._get.mockResolvedValue({
      notModified: false,
      etag: '"new-hash-456"',
      document: { updatedAt: '2026-05-01T10:00:00.000Z' },
      content: newContent,
    });
    // File doesn't exist locally → no conflict check needed
    mockedFs.existsSync.mockReturnValue(false);

    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    expect(client._syncList).toHaveBeenCalledTimes(1);
    expect(client._get).toHaveBeenCalledTimes(1);
    expect(client._get).toHaveBeenCalledWith(
      config.vaultId,
      'notes/changed.md',
      { ifNoneMatch: '"old-hash-123"' },
    );
    expect(mockSaveSyncState).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Case 3: Server 304 on the changed-doc fetch (race condition)
  // poller treats as unchanged; no file write; lastRemote.mtime updated
  // -----------------------------------------------------------------------
  it('conditional GET 304: no file write, mtime updated in state', async () => {
    const config = makeConfig();
    const oldMtime = '2026-01-01T00:00:00.000Z';
    const newMtime = '2026-05-01T10:00:00.000Z';
    const state = makeState({
      remote: {
        'notes/doc.md': makeRemoteFileState('notes/doc.md', 'hash-unchanged', oldMtime),
      },
    });
    mockLoadSyncState.mockReturnValue(state);

    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [{
        path: 'notes/doc.md',
        contentHash: 'hash-different-from-list', // list hash differs
        fileModifiedAt: newMtime,
        kind: 'changed',
      }],
      removed: [],
      unchanged: [],
      listEtag: 'W/"etag-3"',
    });
    // Server 304s the conditional GET — our copy is current
    client._get.mockResolvedValue({
      notModified: true,
      etag: '"hash-unchanged"',
    });

    const onLog = vi.fn();
    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
      onLog,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    expect(client._get).toHaveBeenCalledTimes(1);
    // No file write should occur
    expect(mockedFs.writeSync).not.toHaveBeenCalled();
    expect(mockedFs.renameSync).not.toHaveBeenCalled();
    // State should still be saved (stateMutated = true because mtime changed + listEtag updated)
    expect(mockSaveSyncState).toHaveBeenCalled();
    const savedState = mockSaveSyncState.mock.calls[0][0] as SyncState;
    // mtime should be updated to the new value from the change
    expect(savedState.remote['notes/doc.md'].mtime).toBe(newMtime);
    // Hash should remain the same
    expect(savedState.remote['notes/doc.md'].hash).toBe('hash-unchanged');
    // No log entry for "Pulled:"
    const logMessages = onLog.mock.calls.map((c: any[]) => c[0] as string);
    expect(logMessages.some((m: string) => m.includes('Pulled:'))).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Case 4: Server 200 with new content → file written atomically, state updated
  // -----------------------------------------------------------------------
  it('conditional GET 200: file written atomically, state updated with new hash', async () => {
    const config = makeConfig();
    const state = makeState({
      remote: {
        'notes/new-content.md': makeRemoteFileState('notes/new-content.md', 'old-hash'),
      },
    });
    mockLoadSyncState.mockReturnValue(state);

    const newContent = '# Updated Note\n\nNew content here.';
    const newHash = 'sha256-newhash';
    mockHashFileContent.mockImplementation((c: string) =>
      c === newContent ? newHash : `sha256-${c.slice(0, 16)}`,
    );

    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [{
        path: 'notes/new-content.md',
        contentHash: newHash,
        fileModifiedAt: '2026-05-01T12:00:00.000Z',
        kind: 'changed',
      }],
      removed: [],
      unchanged: [],
      listEtag: 'W/"etag-4"',
    });
    client._get.mockResolvedValue({
      notModified: false,
      etag: `"${newHash}"`,
      document: { updatedAt: '2026-05-01T12:00:00.000Z' },
      content: newContent,
    });
    // File doesn't exist locally
    mockedFs.existsSync.mockReturnValue(false);

    const onLog = vi.fn();
    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
      onLog,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    // File was written atomically via tmp + rename
    expect(mockedFs.openSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      'wx',
      expect.any(Number),
    );
    expect(mockedFs.writeSync).toHaveBeenCalledWith(
      expect.anything(),
      newContent,
      0,
      'utf-8',
    );
    expect(mockedFs.renameSync).toHaveBeenCalled();
    // State persisted
    expect(mockSaveSyncState).toHaveBeenCalled();
    expect(mockUpdateLastSync).toHaveBeenCalledWith(config.id);
    // Log message
    const logMessages = onLog.mock.calls.map((c: any[]) => c[0] as string);
    expect(logMessages.some((m: string) => m.includes('Pulled: notes/new-content.md'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 5: Drift correction — syncList returns no changes (vault changed ETag
  // but syncList still classified all docs as unchanged)
  // Zero GETs; state ETag updated; state persists
  // -----------------------------------------------------------------------
  it('drift correction: vault ETag updated but no doc changes — no GETs, state saved', async () => {
    const config = makeConfig();
    const state = makeState({
      remote: {
        'notes/drift.md': makeRemoteFileState('notes/drift.md', 'hash-drift', '2026-01-01T00:00:00.000Z'),
      },
      remoteListEtag: 'W/"etag-old"',
    });
    mockLoadSyncState.mockReturnValue(state);

    const client = makeClient();
    // syncList returns vault IS changed (new list ETag) but the single doc is unchanged
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [], // no changes — hash matched
      removed: [],
      unchanged: ['notes/drift.md'],
      listEtag: 'W/"etag-new"',
    });

    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    // No document GETs should be issued
    expect(client._get).not.toHaveBeenCalled();
    // State should still be saved because remoteListEtag changed
    expect(mockSaveSyncState).toHaveBeenCalled();
    const savedState = mockSaveSyncState.mock.calls[0][0] as SyncState;
    expect(savedState.remoteListEtag).toBe('W/"etag-new"');
  });

  // -----------------------------------------------------------------------
  // Case 6: First-time doc (not in state.remote) → unconditional GET, file created
  // -----------------------------------------------------------------------
  it('first-time doc: unconditional GET (no ifNoneMatch), file created', async () => {
    const config = makeConfig();
    const state = makeState({ remote: {} }); // empty remote state
    mockLoadSyncState.mockReturnValue(state);

    const newDocContent = '# Brand New\n\nFirst time.';
    const newDocHash = 'sha256-brandnew';
    mockHashFileContent.mockImplementation((c: string) =>
      c === newDocContent ? newDocHash : `sha256-${c.slice(0, 16)}`,
    );

    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [{
        path: 'notes/brand-new.md',
        contentHash: newDocHash,
        fileModifiedAt: '2026-05-01T09:00:00.000Z',
        kind: 'added',
      }],
      removed: [],
      unchanged: [],
      listEtag: 'W/"etag-6"',
    });
    // Unconditional GET returns DocumentWithContent (no notModified field)
    client._get.mockResolvedValue({
      document: { updatedAt: '2026-05-01T09:00:00.000Z' },
      content: newDocContent,
    });
    mockedFs.existsSync.mockReturnValue(false);

    const onLog = vi.fn();
    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
      onLog,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    // Called without ifNoneMatch (unconditional 2-arg call)
    expect(client._get).toHaveBeenCalledTimes(1);
    expect(client._get).toHaveBeenCalledWith(config.vaultId, 'notes/brand-new.md');
    // File was created
    expect(mockedFs.writeSync).toHaveBeenCalled();
    expect(mockedFs.renameSync).toHaveBeenCalled();
    // Log message
    const logMessages = onLog.mock.calls.map((c: any[]) => c[0] as string);
    expect(logMessages.some((m: string) => m.includes('Pulled: notes/brand-new.md'))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 7: Removed doc → local file deleted, state cleaned up
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Case 8: 429 / throttle error from syncList
  // When the SDK exhausts its retry budget and throws a 429 error, the poller
  // should log "rate limited" rather than calling onError, and the polling
  // loop should remain alive for the next scheduled interval.
  // -----------------------------------------------------------------------
  it('429 / throttle from syncList: logs warning, does NOT call onError, keeps polling alive', async () => {
    const config = makeConfig();
    const state = makeState();
    mockLoadSyncState.mockReturnValue(state);

    const client = makeClient();
    // Simulate SDK throwing after exhausting its own retry budget
    client._syncList.mockRejectedValue(new Error('HTTP 429 Too Many Requests'));

    const onLog = vi.fn();
    const onError = vi.fn();
    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
      onLog,
      onError,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    // onError must NOT be called for a throttle error
    expect(onError).not.toHaveBeenCalled();

    // A warning should be logged instead
    const logMessages = onLog.mock.calls.map((c: any[]) => c[0] as string);
    expect(logMessages.some((m: string) => /rate.?limit|retry|throttl/i.test(m))).toBe(true);

    // State was not mutated (no saveSyncState)
    expect(mockSaveSyncState).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Case 9: Non-429 error from syncList still calls onError
  // -----------------------------------------------------------------------
  it('non-throttle error from syncList: calls onError as before', async () => {
    const config = makeConfig();
    const state = makeState();
    mockLoadSyncState.mockReturnValue(state);

    const client = makeClient();
    client._syncList.mockRejectedValue(new Error('Network connection refused'));

    const onError = vi.fn();
    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
      onError,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    // onError MUST be called for non-throttle errors
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toMatch(/connection refused/i);
  });

  it('removed doc: local file deleted and state cleaned up', async () => {
    const config = makeConfig();
    const state = makeState({
      remote: {
        ...trackedPaths(20),
        'notes/deleted.md': makeRemoteFileState('notes/deleted.md', 'hash-old'),
      },
      local: {
        'notes/deleted.md': makeRemoteFileState('notes/deleted.md', 'hash-old'),
      },
    });
    mockLoadSyncState.mockReturnValue(state);
    mockHashFileContent.mockReturnValue('hash-old');

    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [],
      removed: ['notes/deleted.md'],
      unchanged: [],
      listEtag: 'W/"etag-7"',
    });
    // Local file exists
    mockedFs.existsSync.mockReturnValue(true);

    const onLog = vi.fn();
    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [],
      intervalMs: 60000,
      onLog,
    });
    await new Promise(r => setTimeout(r, 30));
    await poller.stop();

    expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
      path.join(config.localPath, 'notes/deleted.md'),
    );
    const logMessages = onLog.mock.calls.map((c: any[]) => c[0] as string);
    expect(logMessages.some((m: string) => m.includes('Deleted local: notes/deleted.md'))).toBe(true);
    expect(mockSaveSyncState).toHaveBeenCalled();
    const savedState = mockSaveSyncState.mock.calls[0][0] as SyncState;
    expect(savedState.remote['notes/deleted.md']).toBeUndefined();
    expect(savedState.local['notes/deleted.md']).toBeUndefined();
  });

  it('remote delete concurrent with a local edit preserves the edit under local policy', async () => {
    const config = makeConfig({ onConflict: 'local' });
    const state = makeState({
      remote: {
        ...trackedPaths(20),
        'notes/edited.md': makeRemoteFileState('notes/edited.md', 'hash-old'),
      },
      local: {
        'notes/edited.md': makeRemoteFileState('notes/edited.md', 'hash-old'),
      },
    });
    mockLoadSyncState.mockReturnValue(state);
    mockHashFileContent.mockImplementation(content => content === '# local edit' ? 'hash-new' : `sha256-${content.slice(0, 16)}`);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('# local edit' as any);
    mockedFs.statSync.mockReturnValue({ mtime: new Date('2026-06-02T00:00:00.000Z') } as any);
    const client = makeClient();
    client._syncList.mockResolvedValue({
      vaultUnchanged: false,
      changes: [],
      removed: ['notes/edited.md'],
      unchanged: [],
      listEtag: 'W/"deleted"',
    });
    client._put.mockResolvedValue({});

    const poller = createRemotePoller(client as any, config, {
      ignorePatterns: [], intervalMs: 60_000,
    });
    await poller.stop();

    expect(client._put).toHaveBeenCalledWith(config.vaultId, 'notes/edited.md', '# local edit');
    expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    const savedState = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
    expect(savedState.local['notes/edited.md'].hash).toBe('hash-new');
    expect(savedState.remote['notes/edited.md']).toBeDefined();
    expect(savedState.remoteListEtag).toBeUndefined();
  });

  describe('per-document error isolation', () => {
    it('keeps the progress of documents that succeeded when one fails', async () => {
      const config = makeConfig();
      mockLoadSyncState.mockReturnValue(makeState({}));
      mockedFs.existsSync.mockReturnValue(false);
      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [
          { path: 'notes/good.md', fileModifiedAt: '2026-06-01T00:00:00.000Z' },
          { path: 'notes/bad.md', fileModifiedAt: '2026-06-01T00:00:00.000Z' },
        ],
        removed: [],
        unchanged: [],
        listEtag: 'W/"batch"',
      });
      client._get.mockImplementation(async (_vaultId: string, docPath: string) => {
        if (docPath === 'notes/bad.md') throw new Error('500 Internal Server Error');
        return { content: '# good', document: { path: docPath, updatedAt: '2026-06-01T00:00:00.000Z' } };
      });

      const poller = createRemotePoller(client as any, config, {
        ignorePatterns: [], intervalMs: 60_000,
      });
      await poller.stop();

      const savedState = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
      // The good document's progress is committed rather than discarded...
      expect(savedState.remote['notes/good.md']).toBeDefined();
      // ...and the list ETag is held back so the next poll re-offers the failed one
      // instead of being told nothing changed.
      expect(savedState.remoteListEtag).toBeUndefined();
    });

    it('commits the list ETag once every document in the batch applied', async () => {
      const config = makeConfig();
      mockLoadSyncState.mockReturnValue(makeState({}));
      mockedFs.existsSync.mockReturnValue(false);
      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [{ path: 'notes/good.md', fileModifiedAt: '2026-06-01T00:00:00.000Z' }],
        removed: [],
        unchanged: [],
        listEtag: 'W/"batch"',
      });
      client._get.mockResolvedValue({
        content: '# good',
        document: { path: 'notes/good.md', updatedAt: '2026-06-01T00:00:00.000Z' },
      });

      const poller = createRemotePoller(client as any, config, {
        ignorePatterns: [], intervalMs: 60_000,
      });
      await poller.stop();

      const savedState = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
      expect(savedState.remoteListEtag).toBe('W/"batch"');
    });

    it('still aborts the whole poll on a path-containment failure', async () => {
      const config = makeConfig();
      mockLoadSyncState.mockReturnValue(makeState({}));
      const onError = vi.fn();
      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [{ path: '../outside.md', fileModifiedAt: '2026-06-01T00:00:00.000Z' }],
        removed: [],
        unchanged: [],
        listEtag: 'W/"evil"',
      });

      const poller = createRemotePoller(client as any, config, {
        ignorePatterns: [], intervalMs: 60_000, onError,
      });
      await poller.stop();

      // Isolation must not downgrade a traversal rejection into a skipped path.
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'SyncPathError' }));
      expect(client._get).not.toHaveBeenCalled();
    });
  });

  describe('pull-only mode never writes to the remote', () => {
    it('keeps the local edit and backs up the remote on a changed-doc conflict, without PUT', async () => {
      const config = makeConfig({ mode: 'pull', onConflict: 'local' });
      mockLoadSyncState.mockReturnValue(makeState({
        local: { 'notes/doc.md': makeRemoteFileState('notes/doc.md', 'hash-old') },
        remote: { 'notes/doc.md': makeRemoteFileState('notes/doc.md', 'hash-old') },
      }));
      const { detectConflict, resolveConflict, createConflictFile } = await import('./conflict.js');
      vi.mocked(detectConflict).mockReturnValueOnce(true);
      vi.mocked(resolveConflict).mockReturnValueOnce('local');
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('# local edit' as any);
      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [{ path: 'notes/doc.md', contentHash: 'hash-remote', fileModifiedAt: '2026-06-01T00:00:00.000Z', kind: 'changed' }],
        removed: [], unchanged: [], listEtag: 'W/"x"',
      });
      client._get.mockResolvedValue({ notModified: false, content: '# remote edit', document: { updatedAt: '2026-06-01T00:00:00.000Z' } });

      const poller = createRemotePoller(client as any, config, { ignorePatterns: [], intervalMs: 60_000 });
      await poller.stop();

      expect(client._put).not.toHaveBeenCalled();
      expect(createConflictFile).toHaveBeenCalledWith(config.localPath, 'notes/doc.md', '# remote edit', 'remote');
      // The local file was not overwritten by the remote version.
      expect(mockedFs.renameSync).not.toHaveBeenCalled();
      const savedState = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
      // Last-known remote is the server's real content, so the next poll does not re-raise the conflict.
      expect(savedState.remote['notes/doc.md'].hash).toBe('sha256-# remote edit');
    });

    it('keeps a locally edited file when the remote deleted it, without re-uploading', async () => {
      const config = makeConfig({ mode: 'pull', onConflict: 'local' });
      mockLoadSyncState.mockReturnValue(makeState({
        local: { 'notes/edited.md': makeRemoteFileState('notes/edited.md', 'hash-old') },
        remote: { ...trackedPaths(20), 'notes/edited.md': makeRemoteFileState('notes/edited.md', 'hash-old') },
      }));
      mockHashFileContent.mockImplementation(content => content === '# local edit' ? 'hash-new' : `sha256-${content.slice(0, 16)}`);
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('# local edit' as any);
      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false, changes: [], removed: ['notes/edited.md'], unchanged: [], listEtag: 'W/"deleted"',
      });

      const poller = createRemotePoller(client as any, config, { ignorePatterns: [], intervalMs: 60_000 });
      await poller.stop();

      expect(client._put).not.toHaveBeenCalled();
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
      const savedState = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
      expect(savedState.local['notes/edited.md']).toBeUndefined();
      expect(savedState.remote['notes/edited.md']).toBeUndefined();
    });
  });

  describe('poll interval clamping', () => {
    it('clamps out-of-range and non-finite intervals', () => {
      expect(clampPollIntervalMs(undefined)).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(clampPollIntervalMs(Number.NaN)).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(clampPollIntervalMs(5)).toBe(MIN_POLL_INTERVAL_MS);
      expect(clampPollIntervalMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(clampPollIntervalMs(MAX_POLL_INTERVAL_MS * 10)).toBe(MAX_POLL_INTERVAL_MS);
      expect(clampPollIntervalMs(45_000)).toBe(45_000);
    });

    it('logs when a supplied interval was clamped', async () => {
      const client = makeClient();
      client._syncList.mockResolvedValue({ vaultUnchanged: true, changes: [], removed: [], unchanged: [], listEtag: 'e' });
      const onLog = vi.fn();
      const poller = createRemotePoller(client as any, makeConfig(), { ignorePatterns: [], intervalMs: 5, onLog });
      await poller.stop();
      const logs = onLog.mock.calls.map((c: any[]) => c[0] as string);
      expect(logs.some(m => m.includes('out of range') && m.includes(`${MIN_POLL_INTERVAL_MS}ms`))).toBe(true);
    });
  });

  it('stop() waits for the in-flight poll even after an interval tick was skipped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const client = makeClient();
      let releaseList!: (value: unknown) => void;
      client._syncList.mockImplementation(() => new Promise(resolve => { releaseList = resolve; }));
      const poller = createRemotePoller(client as any, makeConfig(), { ignorePatterns: [], intervalMs: 60_000, shutdownTimeoutMs: 1_000 });
      await vi.waitFor(() => expect(client._syncList).toHaveBeenCalledOnce());

      // A tick fires while the first poll is still running: it must be skipped
      // without replacing the tracked in-flight promise.
      vi.advanceTimersByTime(60_000);
      expect(client._syncList).toHaveBeenCalledOnce();

      let stopped = false;
      const stopping = poller.stop().then(() => { stopped = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(stopped).toBe(false);

      releaseList({ vaultUnchanged: true, changes: [], removed: [], unchanged: [], listEtag: 'e' });
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  // Gating tests for the highest-severity data-loss path: a truncated listing
  // is subtracted from the known state and every local file is unlinked, with
  // no conflict copy, for a cleanly synced vault.
  describe('mass-delete guard', () => {
    it('refuses the batch, unlinks nothing, and persists the anomaly', async () => {
      const config = makeConfig();
      const tracked = trackedPaths(50);
      const state = makeState({ remote: tracked, local: { ...tracked } });
      mockLoadSyncState.mockReturnValue(state);
      mockedFs.existsSync.mockReturnValue(true);

      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [],
        removed: Object.keys(tracked),
        unchanged: [],
        listEtag: 'W/"truncated"',
      });

      const onLog = vi.fn();
      const poller = createRemotePoller(client as any, config, {
        ignorePatterns: [], intervalMs: 60_000, onLog,
      });
      await poller.stop();

      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
      const saved = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
      // Keyed by the side that would have lost files: this is a pull, so it is
      // the local copy that was spared.
      expect(saved.deletionAnomalies?.local).toBeDefined();
      expect(saved.deletionAnomalies?.local?.target).toBe('local');
      expect(saved.deletionAnomalies?.local?.removedCount).toBe(50);
      expect(saved.deletionAnomalies?.local?.knownCount).toBe(50);
      expect(saved.deletionAnomalies?.remote).toBeUndefined();
      // Every tracked path is still tracked — the state was not pruned either.
      expect(Object.keys(saved.remote)).toHaveLength(50);
      const logs = onLog.mock.calls.map((c: any[]) => c[0] as string);
      expect(logs.some((m: string) => m.includes('Refusing 50 local deletion(s)'))).toBe(true);
      expect(logs.some((m: string) => m.includes('lsvault sync pull --allow-mass-delete'))).toBe(true);
    });

    it('holds the list ETag so the next poll re-evaluates instead of 304ing past it', async () => {
      const config = makeConfig();
      const tracked = trackedPaths(50);
      mockLoadSyncState.mockReturnValue(makeState({ remote: tracked, local: { ...tracked } }));
      mockedFs.existsSync.mockReturnValue(true);

      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [],
        removed: Object.keys(tracked),
        unchanged: [],
        listEtag: 'W/"truncated"',
      });

      const poller = createRemotePoller(client as any, config, { ignorePatterns: [], intervalMs: 60_000 });
      await poller.stop();

      const saved = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
      expect(saved.remoteListEtag).toBeUndefined();
    });

    it('still applies the changed documents in the same poll', async () => {
      // The creates and updates are unaffected; only the destructive half is held.
      const config = makeConfig();
      const tracked = trackedPaths(50);
      mockLoadSyncState.mockReturnValue(makeState({ remote: tracked, local: { ...tracked } }));
      mockedFs.existsSync.mockReturnValue(false);

      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [{ path: 'notes/new.md', contentHash: 'h', fileModifiedAt: '2026-06-01T00:00:00.000Z', kind: 'added' }],
        removed: Object.keys(tracked),
        unchanged: [],
        listEtag: 'W/"truncated"',
      });
      client._get.mockResolvedValue({ notModified: false, content: '# new', document: { updatedAt: '2026-06-01T00:00:00.000Z' } });

      const poller = createRemotePoller(client as any, config, { ignorePatterns: [], intervalMs: 60_000 });
      await poller.stop();

      expect(mockedFs.renameSync).toHaveBeenCalled();
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    });

    it('clears a recorded anomaly once the listing is consistent again', async () => {
      const config = makeConfig();
      const tracked = trackedPaths(50);
      mockLoadSyncState.mockReturnValue(makeState({
        remote: tracked,
        local: { ...tracked },
        deletionAnomalies: {
          local: {
            target: 'local', detectedAt: '2026-09-01T00:00:00.000Z',
            removedCount: 50, knownCount: 50, reason: 'stale',
          },
        },
      }));

      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false,
        changes: [],
        removed: [],
        unchanged: Object.keys(tracked),
        listEtag: 'W/"healthy"',
      });

      const poller = createRemotePoller(client as any, config, { ignorePatterns: [], intervalMs: 60_000 });
      await poller.stop();

      const saved = mockSaveSyncState.mock.calls.at(-1)?.[0] as SyncState;
      expect(saved.deletionAnomalies).toBeUndefined();
    });
  });

  describe('local-write marking', () => {
    it('marks a deletion with a null hash so the watcher can tell it from a user delete', async () => {
      const config = makeConfig();
      const tracked = trackedPaths(20);
      mockLoadSyncState.mockReturnValue(makeState({
        remote: { ...tracked, 'notes/gone.md': makeRemoteFileState('notes/gone.md', 'hash-old') },
        local: { 'notes/gone.md': makeRemoteFileState('notes/gone.md', 'hash-old') },
      }));
      mockHashFileContent.mockReturnValue('hash-old');
      mockedFs.existsSync.mockReturnValue(true);

      const client = makeClient();
      client._syncList.mockResolvedValue({
        vaultUnchanged: false, changes: [], removed: ['notes/gone.md'], unchanged: [], listEtag: 'W/"e"',
      });

      const onLocalWrite = vi.fn();
      const poller = createRemotePoller(client as any, config, {
        ignorePatterns: [], intervalMs: 60_000, onLocalWrite,
      });
      await poller.stop();

      expect(onLocalWrite).toHaveBeenCalledWith('notes/gone.md', null);
    });
  });
});
