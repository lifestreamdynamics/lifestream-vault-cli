import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external dependencies before importing
const mockLoadSyncConfigs = vi.fn();
const mockResolveIgnorePatterns = vi.fn(() => []);
const mockCreateWatcher = vi.fn(() => ({
  watcher: { close: vi.fn() },
  ready: Promise.resolve(),
  stop: vi.fn(),
  markLocalWrite: vi.fn(),
  serialize: async <T>(operation: () => Promise<T>) => operation(),
}));
const mockCreateRemotePoller = vi.fn(() => ({ stop: vi.fn() }));
const mockRemovePid = vi.fn();
const mockWriteDaemonState = vi.fn();
const mockAssertSyncRoot = vi.fn();
const mockLoadConfig = vi.fn(async () => ({ apiUrl: 'http://localhost', apiKey: 'test-key' }));
const mockScanLocalFiles = vi.fn(() => ({}));
const mockScanRemoteFiles = vi.fn(async () => ({ files: {}, listEtag: '', vaultUnchanged: false }));
const mockComputePushDiff = vi.fn((): Record<string, unknown> => ({ uploads: [], deletes: [], downloads: [], totalBytes: 0 }));
const mockComputePullDiff = vi.fn((): Record<string, unknown> => ({ uploads: [], deletes: [], downloads: [], totalBytes: 0 }));
const mockExecutePush = vi.fn(async (): Promise<Record<string, unknown>> => ({ filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, bytesTransferred: 0, errors: [] }));
const mockExecutePull = vi.fn(async (): Promise<Record<string, unknown>> => ({ filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, bytesTransferred: 0, errors: [] }));
const mockLoadSyncState = vi.fn(() => ({ syncId: 'test', local: {}, remote: {}, updatedAt: new Date().toISOString() }));
const mockSweepOrphanedTempFiles = vi.fn(() => 0);

vi.mock('./config.js', () => ({ loadSyncConfigs: mockLoadSyncConfigs }));
vi.mock('./ignore.js', () => ({ resolveIgnorePatterns: mockResolveIgnorePatterns }));
vi.mock('./watcher.js', () => ({ createWatcher: mockCreateWatcher }));
vi.mock('./remote-poller.js', () => ({ createRemotePoller: mockCreateRemotePoller }));
vi.mock('./daemon.js', () => ({ removePid: mockRemovePid, removeDaemonState: vi.fn(), writeDaemonState: mockWriteDaemonState }));
vi.mock('../client.js', () => ({ getClientAsync: mockLoadConfig }));
vi.mock('./root-marker.js', () => ({ assertSyncRoot: mockAssertSyncRoot }));
vi.mock('./engine.js', () => ({
  scanLocalFiles: mockScanLocalFiles,
  scanRemoteFiles: mockScanRemoteFiles,
  computePushDiff: mockComputePushDiff,
  computePullDiff: mockComputePullDiff,
  executePush: mockExecutePush,
  executePull: mockExecutePull,
  sweepOrphanedTempFiles: mockSweepOrphanedTempFiles,
}));
vi.mock('./state.js', () => ({ loadSyncState: mockLoadSyncState, saveSyncState: vi.fn() }));
vi.mock('@lifestreamdynamics/vault-sdk', () => ({
  LifestreamVaultClient: vi.fn(function() { return {}; }),
}));

// Prevent process.exit from actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc12345-test-config-id',
    vaultId: 'vault-1',
    localPath: '/tmp/test',
    mode: 'sync',
    onConflict: 'newer',
    ignore: [],
    lastSyncAt: '1970-01-01T00:00:00.000Z',
    autoSync: true,
    ...overrides,
  };
}

describe('daemon-worker reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockAssertSyncRoot.mockImplementation(() => undefined);
    mockComputePushDiff.mockReturnValue({ uploads: [], deletes: [], downloads: [], totalBytes: 0 });
    mockComputePullDiff.mockReturnValue({ uploads: [], deletes: [], downloads: [], totalBytes: 0 });
    mockScanRemoteFiles.mockResolvedValue({ files: {}, listEtag: '', vaultUnchanged: false });
  });

  afterEach(() => {
    mockExit.mockClear();
    mockStdoutWrite.mockClear();
  });

  it('should run push reconciliation for push-mode configs', async () => {
    const config = makeConfig({ mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    mockComputePushDiff.mockReturnValue({
      uploads: [{ path: 'new.md', action: 'create' as const, direction: 'upload' as const, sizeBytes: 100, reason: 'new file' }],
      deletes: [],
      downloads: [],
      totalBytes: 100,
    });
    mockExecutePush.mockResolvedValue({
      filesUploaded: 1, filesDownloaded: 0, filesDeleted: 0, bytesTransferred: 100, errors: [],
    });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockScanLocalFiles).toHaveBeenCalled();
    expect(mockScanRemoteFiles).toHaveBeenCalled();
    expect(mockComputePushDiff).toHaveBeenCalled();
    expect(mockExecutePush).toHaveBeenCalled();
    expect(mockComputePullDiff).not.toHaveBeenCalled();
    expect(mockExecutePull).not.toHaveBeenCalled();
  });

  it('should run both push and pull reconciliation for sync-mode configs', async () => {
    const config = makeConfig({ mode: 'sync' });
    mockLoadSyncConfigs.mockReturnValue([config]);

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockComputePushDiff).toHaveBeenCalled();
    expect(mockComputePullDiff).toHaveBeenCalled();
  });

  it('skips the stale pull plan when a push fails, preserving local-only content', async () => {
    const config = makeConfig({ mode: 'sync' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    mockComputePushDiff.mockReturnValue({
      uploads: [{ path: 'only-local.md', action: 'update', direction: 'upload', sizeBytes: 10, reason: 'Local changed' }],
      deletes: [], downloads: [], totalBytes: 10,
    });
    mockComputePullDiff.mockReturnValue({
      uploads: [], downloads: [],
      deletes: [{ path: 'only-local.md', action: 'delete', direction: 'download', sizeBytes: 0, reason: 'Remote deleted' }],
      totalBytes: 0,
    });
    mockExecutePush.mockResolvedValue({
      filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, bytesTransferred: 0,
      errors: [{ path: 'only-local.md', error: 'network unavailable', retryable: true }], failed: true,
    });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockExecutePull).not.toHaveBeenCalled();
    expect(mockComputePullDiff).not.toHaveBeenCalled();
  });

  it('still pulls after a permanent (non-retryable) push rejection, from a fresh remote scan', async () => {
    const config = makeConfig({ mode: 'sync' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    mockComputePushDiff.mockReturnValue({
      uploads: [], downloads: [],
      deletes: [{ path: 'team-doc.md', action: 'delete', direction: 'upload', sizeBytes: 0, reason: 'Local deleted' }],
      totalBytes: 0,
    });
    mockExecutePush.mockResolvedValue({
      filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, filesSkipped: 0, bytesTransferred: 0,
      errors: [{ path: 'team-doc.md', error: 'Remote delete was forbidden (403)', retryable: false }], failed: true,
    });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    // A 403 would recur on every reconciliation; it must not freeze pulls.
    expect(mockComputePullDiff).toHaveBeenCalled();
  });

  it('reports readiness before the initial reconciliation touches the network', async () => {
    const config = makeConfig({ mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([config]);

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockWriteDaemonState).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
    expect(mockScanRemoteFiles).toHaveBeenCalled();
    const readyOrder = mockWriteDaemonState.mock.invocationCallOrder[0];
    const reconcileOrder = mockScanRemoteFiles.mock.invocationCallOrder[0];
    expect(readyOrder).toBeLessThan(reconcileOrder);
  });

  it('logs a failed temp-file sweep instead of swallowing it', async () => {
    mockLoadSyncConfigs.mockReturnValue([makeConfig({ mode: 'push' })]);
    mockSweepOrphanedTempFiles.mockImplementationOnce(() => { throw new Error('EACCES sweep'); });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    const lines = mockStdoutWrite.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('Temp-file sweep skipped') && line.includes('EACCES sweep'))).toBe(true);
    expect(mockCreateWatcher).toHaveBeenCalled();
  });

  it('stops a started watcher when the rest of its sync fails to start', async () => {
    mockLoadSyncConfigs.mockReturnValue([makeConfig({ mode: 'sync' })]);
    const stopWatcher = vi.fn().mockResolvedValue(undefined);
    mockCreateWatcher.mockReturnValueOnce({
      watcher: { close: vi.fn() }, ready: Promise.resolve(), stop: stopWatcher,
      markLocalWrite: vi.fn(), serialize: async <T>(operation: () => Promise<T>) => operation(),
    });
    mockCreateRemotePoller.mockImplementationOnce(() => { throw new Error('poller exploded'); });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await expect(runDaemonWorker({ installSignalHandlers: false })).rejects.toThrow('No syncs could be started');

    expect(stopWatcher).toHaveBeenCalledOnce();
    expect(mockWriteDaemonState).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('re-scans remote state after a successful push before planning pull work', async () => {
    const config = makeConfig({ mode: 'sync' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    mockComputePushDiff.mockReturnValue({
      uploads: [{ path: 'restored.md', action: 'update', direction: 'upload', sizeBytes: 10, reason: 'Local changed' }],
      deletes: [], downloads: [], totalBytes: 10,
    });
    mockExecutePush.mockResolvedValue({
      filesUploaded: 1, filesDownloaded: 0, filesDeleted: 0, bytesTransferred: 10,
      errors: [], failed: false,
    });
    const staleRemote = {};
    const refreshedRemote = { 'restored.md': { path: 'restored.md', hash: 'new' } };
    mockScanRemoteFiles
      .mockResolvedValueOnce({ files: staleRemote, listEtag: 'before', vaultUnchanged: false })
      .mockResolvedValueOnce({ files: refreshedRemote, listEtag: 'after', vaultUnchanged: false });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockScanRemoteFiles).toHaveBeenCalledTimes(2);
    expect(mockComputePullDiff).toHaveBeenCalledWith(expect.anything(), refreshedRemote, expect.anything());
  });

  it('should run only pull reconciliation for pull-mode configs', async () => {
    const config = makeConfig({ mode: 'pull' });
    mockLoadSyncConfigs.mockReturnValue([config]);

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockComputePushDiff).not.toHaveBeenCalled();
    expect(mockComputePullDiff).toHaveBeenCalled();
  });

  it('should still start watchers when reconciliation fails', async () => {
    const config = makeConfig({ mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    mockScanRemoteFiles.mockRejectedValue(new Error('Network error'));

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    // Watcher should still be created despite reconciliation failure
    expect(mockCreateWatcher).toHaveBeenCalled();
  });

  it('should skip execution when diffs are empty', async () => {
    const config = makeConfig({ mode: 'sync' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    // Default mocks return empty diffs

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockExecutePush).not.toHaveBeenCalled();
    expect(mockExecutePull).not.toHaveBeenCalled();
  });

  it('skips an invalid root while starting a valid configuration', async () => {
    const invalid = makeConfig({ id: 'invalid-root', mode: 'push' });
    const valid = makeConfig({ id: 'valid-root', mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([invalid, valid]);
    mockAssertSyncRoot.mockImplementation(config => {
      if ((config as { id: string }).id === 'invalid-root') throw new Error('marker missing');
    });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    expect(mockCreateWatcher).toHaveBeenCalledTimes(1);
    expect(mockCreateWatcher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'valid-root' }), expect.anything());
    expect(mockWriteDaemonState).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', startedSyncs: 1, skippedSyncs: 1 }));
  });

  it('does not publish daemon readiness until its watcher is ready', async () => {
    const config = makeConfig({ mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    let releaseWatcher!: () => void;
    mockCreateWatcher.mockReturnValueOnce({
      watcher: { close: vi.fn() },
      ready: new Promise<void>(resolve => { releaseWatcher = resolve; }),
      stop: vi.fn(),
      markLocalWrite: vi.fn(),
      serialize: async <T>(operation: () => Promise<T>) => operation(),
    });

    const { runDaemonWorker } = await import('./daemon-worker.js');
    const starting = runDaemonWorker({ installSignalHandlers: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockWriteDaemonState).not.toHaveBeenCalled();

    releaseWatcher();
    await starting;
    expect(mockWriteDaemonState).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('waits for watcher and poller drains before removing daemon state', async () => {
    const config = makeConfig({ mode: 'sync' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    let releaseWatcher!: () => void;
    let releasePoller!: () => void;
    const stopWatcher = vi.fn(() => new Promise<void>(resolve => { releaseWatcher = resolve; }));
    const stopPoller = vi.fn(() => new Promise<void>(resolve => { releasePoller = resolve; }));
    mockCreateWatcher.mockReturnValueOnce({
      watcher: { close: vi.fn() },
      ready: Promise.resolve(),
      stop: stopWatcher,
      markLocalWrite: vi.fn(),
      serialize: async <T>(operation: () => Promise<T>) => operation(),
    });
    mockCreateRemotePoller.mockReturnValueOnce({ stop: stopPoller });

    const { runDaemonWorker, shutdownDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false, identityNonce: 'nonce-test' });
    const shuttingDown = shutdownDaemonWorker();
    await vi.waitFor(() => {
      expect(stopWatcher).toHaveBeenCalledOnce();
      expect(stopPoller).toHaveBeenCalledOnce();
    });
    expect(mockRemovePid).not.toHaveBeenCalled();

    releaseWatcher();
    releasePoller();
    await shuttingDown;
    expect(mockRemovePid).toHaveBeenCalledExactlyOnceWith('nonce-test');
  });

  it('never removes ownership files without its identity nonce', async () => {
    const config = makeConfig({ mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    const previousIdentity = process.env.LSVAULT_DAEMON_IDENTITY;
    delete process.env.LSVAULT_DAEMON_IDENTITY;
    try {
      const { runDaemonWorker, shutdownDaemonWorker } = await import('./daemon-worker.js');
      await runDaemonWorker({ installSignalHandlers: false });
      await shutdownDaemonWorker();
    } finally {
      if (previousIdentity !== undefined) process.env.LSVAULT_DAEMON_IDENTITY = previousIdentity;
    }
    expect(mockRemovePid).not.toHaveBeenCalled();
  });

  it('rejects an unclean drain and retains daemon ownership files', async () => {
    const config = makeConfig({ mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    mockCreateWatcher.mockReturnValueOnce({
      watcher: { close: vi.fn() },
      ready: Promise.resolve(),
      stop: vi.fn().mockRejectedValue(new Error('Watcher shutdown drain timed out after 35000ms')),
      markLocalWrite: vi.fn(),
      serialize: async <T>(operation: () => Promise<T>) => operation(),
    });

    const { runDaemonWorker, shutdownDaemonWorker } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    await expect(shutdownDaemonWorker()).rejects.toThrow('did not drain cleanly');
    expect(mockRemovePid).not.toHaveBeenCalled();
  });

  it('drains in-flight work before an uncaught exception exits nonzero', async () => {
    mockLoadSyncConfigs.mockReturnValue([makeConfig({ mode: 'push' })]);
    let releaseWatcher!: () => void;
    const stopWatcher = vi.fn(() => new Promise<void>(resolve => { releaseWatcher = resolve; }));
    mockCreateWatcher.mockReturnValueOnce({
      watcher: { close: vi.fn() }, ready: Promise.resolve(), stop: stopWatcher,
      markLocalWrite: vi.fn(), serialize: async <T>(operation: () => Promise<T>) => operation(),
    });
    const { runDaemonWorker, handleFatalRuntimeError } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false, identityNonce: 'nonce-test' });

    handleFatalRuntimeError('UNCAUGHT ERROR', new Error('fatal crash'));
    await vi.waitFor(() => expect(stopWatcher).toHaveBeenCalledOnce());
    expect(mockExit).not.toHaveBeenCalled();

    releaseWatcher();
    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(1));
    expect(mockRemovePid).toHaveBeenCalledOnce();
  });

  it('coalesces fatal rejections and retains ownership when the bounded drain fails', async () => {
    mockLoadSyncConfigs.mockReturnValue([makeConfig({ mode: 'push' })]);
    const stopWatcher = vi.fn().mockRejectedValue(new Error('drain timeout'));
    mockCreateWatcher.mockReturnValueOnce({
      watcher: { close: vi.fn() }, ready: Promise.resolve(), stop: stopWatcher,
      markLocalWrite: vi.fn(), serialize: async <T>(operation: () => Promise<T>) => operation(),
    });
    const { runDaemonWorker, handleFatalRuntimeError } = await import('./daemon-worker.js');
    await runDaemonWorker({ installSignalHandlers: false });

    handleFatalRuntimeError('UNHANDLED REJECTION', new Error('first fatal'));
    handleFatalRuntimeError('UNCAUGHT ERROR', new Error('second fatal'));

    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(1));
    expect(stopWatcher).toHaveBeenCalledOnce();
    expect(mockRemovePid).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledOnce();
  });
});
