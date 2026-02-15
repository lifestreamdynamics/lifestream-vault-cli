import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external dependencies before importing
const mockLoadSyncConfigs = vi.fn();
const mockResolveIgnorePatterns = vi.fn(() => []);
const mockCreateWatcher = vi.fn(() => ({
  watcher: { close: vi.fn() },
  stop: vi.fn(),
}));
const mockCreateRemotePoller = vi.fn(() => ({ stop: vi.fn() }));
const mockRemovePid = vi.fn();
const mockLoadConfig = vi.fn(() => ({ apiUrl: 'http://localhost', apiKey: 'test-key' }));
const mockScanLocalFiles = vi.fn(() => ({}));
const mockScanRemoteFiles = vi.fn(async () => ({}));
const mockComputePushDiff = vi.fn((): Record<string, unknown> => ({ uploads: [], deletes: [], downloads: [], totalBytes: 0 }));
const mockComputePullDiff = vi.fn((): Record<string, unknown> => ({ uploads: [], deletes: [], downloads: [], totalBytes: 0 }));
const mockExecutePush = vi.fn(async (): Promise<Record<string, unknown>> => ({ filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, bytesTransferred: 0, errors: [] }));
const mockExecutePull = vi.fn(async (): Promise<Record<string, unknown>> => ({ filesUploaded: 0, filesDownloaded: 0, filesDeleted: 0, bytesTransferred: 0, errors: [] }));
const mockLoadSyncState = vi.fn(() => ({ syncId: 'test', local: {}, remote: {}, updatedAt: new Date().toISOString() }));

vi.mock('./config.js', () => ({ loadSyncConfigs: mockLoadSyncConfigs }));
vi.mock('./ignore.js', () => ({ resolveIgnorePatterns: mockResolveIgnorePatterns }));
vi.mock('./watcher.js', () => ({ createWatcher: mockCreateWatcher }));
vi.mock('./remote-poller.js', () => ({ createRemotePoller: mockCreateRemotePoller }));
vi.mock('./daemon.js', () => ({ removePid: mockRemovePid }));
vi.mock('../config.js', () => ({ loadConfig: mockLoadConfig }));
vi.mock('./engine.js', () => ({
  scanLocalFiles: mockScanLocalFiles,
  scanRemoteFiles: mockScanRemoteFiles,
  computePushDiff: mockComputePushDiff,
  computePullDiff: mockComputePullDiff,
  executePush: mockExecutePush,
  executePull: mockExecutePull,
}));
vi.mock('./state.js', () => ({ loadSyncState: mockLoadSyncState }));
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

    await import('./daemon-worker.js');
    // Give the async start() time to complete
    await new Promise(r => setTimeout(r, 50));

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

    await import('./daemon-worker.js');
    await new Promise(r => setTimeout(r, 50));

    expect(mockComputePushDiff).toHaveBeenCalled();
    expect(mockComputePullDiff).toHaveBeenCalled();
  });

  it('should run only pull reconciliation for pull-mode configs', async () => {
    const config = makeConfig({ mode: 'pull' });
    mockLoadSyncConfigs.mockReturnValue([config]);

    await import('./daemon-worker.js');
    await new Promise(r => setTimeout(r, 50));

    expect(mockComputePushDiff).not.toHaveBeenCalled();
    expect(mockComputePullDiff).toHaveBeenCalled();
  });

  it('should still start watchers when reconciliation fails', async () => {
    const config = makeConfig({ mode: 'push' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    mockScanRemoteFiles.mockRejectedValue(new Error('Network error'));

    await import('./daemon-worker.js');
    await new Promise(r => setTimeout(r, 50));

    // Watcher should still be created despite reconciliation failure
    expect(mockCreateWatcher).toHaveBeenCalled();
  });

  it('should skip execution when diffs are empty', async () => {
    const config = makeConfig({ mode: 'sync' });
    mockLoadSyncConfigs.mockReturnValue([config]);
    // Default mocks return empty diffs

    await import('./daemon-worker.js');
    await new Promise(r => setTimeout(r, 50));

    expect(mockExecutePush).not.toHaveBeenCalled();
    expect(mockExecutePull).not.toHaveBeenCalled();
  });
});
