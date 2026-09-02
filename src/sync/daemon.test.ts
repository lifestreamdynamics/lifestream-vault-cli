import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const mockLoadSyncConfigs = vi.hoisted(() => vi.fn((): Array<Record<string, unknown>> => []));

vi.mock('node:fs');
vi.mock('node:crypto', () => ({ randomUUID: vi.fn(() => 'nonce-1234567890abcdef') }));
vi.mock('./config.js', () => ({ loadSyncConfigs: mockLoadSyncConfigs }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
  })),
  execFileSync: vi.fn(() => 'Mon Sep  1 00:00:00 2026\n'),
}));

const mockedFs = vi.mocked(fs);

function procStat(startTick = '777'): string {
  return `12345 (node daemon-worker.js) S ${Array(18).fill('0').join(' ')} ${startTick} 0`;
}

function pidIdentity(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    pid: 12345,
    nonce: 'nonce-1234567890abcdef',
    processStartId: 'linux:777',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  });
}

import {
  readPid,
  writePid,
  removePid,
  isProcessRunning,
  getDaemonStatus,
  rotateLogIfNeeded,
  startDaemon,
  stopDaemon,
  checkLingerStatus,
  PID_FILE,
  LOG_FILE,
} from './daemon.js';

describe('sync daemon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSyncConfigs.mockReturnValue([]);
  });

  describe('readPid', () => {
    it('should return null when no PID file exists', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(readPid()).toBeNull();
    });

    it('should return PID from file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('12345\n');
      expect(readPid()).toBe(12345);
    });

    it('returns the PID from a versioned identity record', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(pidIdentity());
      expect(readPid()).toBe(12345);
    });

    it('should return null for corrupt PID file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-a-number');
      expect(readPid()).toBeNull();
    });
  });

  describe('writePid', () => {
    it('should create daemon dir and write PID', () => {
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target) === '/proc/12345/stat') return procStat();
        return '';
      });
      const identity = writePid(12345, 'nonce-1234567890abcdef');
      expect(identity).toEqual(expect.objectContaining({ pid: 12345, processStartId: 'linux:777' }));
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('daemon'),
        { recursive: true },
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        PID_FILE,
        expect.stringContaining('"processStartId": "linux:777"'),
        { mode: 0o600 },
      );
    });

    it('persists a verifiable process start marker on macOS', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockedFs.existsSync.mockReturnValue(true);
      try {
        const identity = writePid(12345, 'nonce-1234567890abcdef');
        expect(execFileSync).toHaveBeenCalledWith(
          'ps',
          ['-o', 'lstart=', '-p', '12345'],
          expect.objectContaining({ encoding: 'utf-8' }),
        );
        expect(identity.processStartId).toBe('darwin:Mon Sep  1 00:00:00 2026');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  describe('removePid', () => {
    it('should remove PID file when it exists', () => {
      mockedFs.existsSync.mockReturnValue(true);
      removePid();
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(PID_FILE);
    });

    it('should do nothing when no PID file', () => {
      mockedFs.existsSync.mockReturnValue(false);
      removePid();
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('isProcessRunning', () => {
    it('should return true for running process', () => {
      // process.kill with signal 0 doesn't throw for current process
      expect(isProcessRunning(process.pid)).toBe(true);
    });

    it('should return false for non-existent process', () => {
      // Very high PID unlikely to exist
      expect(isProcessRunning(999999999)).toBe(false);
    });
  });

  describe('getDaemonStatus', () => {
    it('should return not running when no PID file', () => {
      mockedFs.existsSync.mockReturnValue(false);
      const status = getDaemonStatus();
      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
    });

    it('should clean up stale PID file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('999999999\n');
      const status = getDaemonStatus();
      expect(status.running).toBe(false);
      expect(mockedFs.unlinkSync).toHaveBeenCalled();
    });

    it('does not report a reused live PID as the daemon', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target) === PID_FILE) return pidIdentity({ processStartId: 'linux:old' });
        if (String(target) === '/proc/12345/stat') return procStat('new');
        return '';
      });
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        expect(getDaemonStatus()).toEqual(expect.objectContaining({ running: false, pid: null }));
        expect(mockedFs.unlinkSync).toHaveBeenCalledWith(PID_FILE);
        expect(kill).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      } finally {
        kill.mockRestore();
      }
    });

    it('verifies a live daemon identity on macOS', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target) === PID_FILE) {
          return pidIdentity({ processStartId: 'darwin:Mon Sep  1 00:00:00 2026' });
        }
        return '';
      });
      mockedFs.statSync.mockReturnValue({ birthtime: new Date(), birthtimeMs: Date.now() } as fs.Stats);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        expect(getDaemonStatus()).toEqual(expect.objectContaining({ running: true, pid: 12345 }));
        expect(execFileSync).toHaveBeenCalled();
      } finally {
        kill.mockRestore();
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  describe('rotateLogIfNeeded', () => {
    it('should not rotate when log is small', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 1024 } as fs.Stats);
      mockedFs.readdirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
      rotateLogIfNeeded('/tmp/test.log');
      expect(mockedFs.renameSync).not.toHaveBeenCalled();
    });

    it('should rotate when log exceeds max size', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.statSync.mockReturnValue({ size: 11 * 1024 * 1024 } as fs.Stats);
      mockedFs.readdirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
      rotateLogIfNeeded('/tmp/test.log');
      expect(mockedFs.renameSync).toHaveBeenCalled();
    });

    it('should do nothing when log does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false);
      rotateLogIfNeeded('/tmp/nonexistent.log');
      expect(mockedFs.statSync).not.toHaveBeenCalled();
    });
  });

  describe('stopDaemon', () => {
    it('should return false when no daemon running', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      await expect(stopDaemon()).resolves.toBe(false);
    });

    it('should return false for stale PID', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('999999999\n');
      await expect(stopDaemon()).resolves.toBe(false);
    });

    it('waits for process exit before removing daemon files', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target) === PID_FILE) return pidIdentity();
        if (String(target) === '/proc/12345/stat') return procStat();
        if (String(target).endsWith('daemon-state.json')) {
          return JSON.stringify({ status: 'ready', pid: 12345, identityNonce: 'nonce-1234567890abcdef', timestamp: '', startedSyncs: 1, skippedSyncs: 0 });
        }
        return '';
      });
      let probes = 0;
      const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 0 && ++probes > 2) throw new Error('ESRCH');
        return true;
      });
      try {
        await expect(stopDaemon()).resolves.toBe(true);
        expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM');
        expect(mockedFs.unlinkSync).toHaveBeenCalledWith(PID_FILE);
      } finally {
        kill.mockRestore();
      }
    });

    it('never signals a live process referenced by a legacy PID-only file', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('12345\n');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await expect(stopDaemon()).rejects.toThrow(/Cannot verify ownership of legacy daemon PID/);
        expect(kill).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      } finally {
        kill.mockRestore();
      }
    });

    it('treats a reused PID as stale and never signals the replacement process', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target) === PID_FILE) return pidIdentity({ processStartId: 'linux:old' });
        if (String(target) === '/proc/12345/stat') return procStat('new');
        return '';
      });
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await expect(stopDaemon()).resolves.toBe(false);
        expect(kill).not.toHaveBeenCalledWith(12345, 'SIGTERM');
        expect(mockedFs.unlinkSync).toHaveBeenCalledWith(PID_FILE);
      } finally {
        kill.mockRestore();
      }
    });
  });

  describe('startDaemon', () => {
    it('should throw when daemon is already running', async () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target) === PID_FILE) return pidIdentity({ pid: process.pid });
        if (String(target) === `/proc/${process.pid}/stat`) return procStat();
        return '';
      });
      mockedFs.statSync.mockReturnValue({ birthtime: new Date(), birthtimeMs: Date.now() } as fs.Stats);
      await expect(startDaemon()).rejects.toThrow('already running');
    });

    it('fails before spawning when no auto-sync configuration exists', async () => {
      mockedFs.existsSync.mockReturnValue(false);
      await expect(startDaemon()).rejects.toThrow(/No auto-sync configurations/);
    });

    it('waits for a matching ready state before reporting success', async () => {
      mockLoadSyncConfigs.mockReturnValue([{ autoSync: true }]);
      let pidContent = '';
      mockedFs.existsSync.mockImplementation(target =>
        String(target).endsWith('daemon-state.json') || (String(target) === PID_FILE && pidContent.length > 0),
      );
      mockedFs.writeFileSync.mockImplementation((target, content) => {
        if (String(target) === PID_FILE) pidContent = String(content);
      });
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target).endsWith('daemon-state.json')) {
          return JSON.stringify({ status: 'ready', pid: 12345, identityNonce: 'nonce-1234567890abcdef', timestamp: new Date().toISOString(), startedSyncs: 1, skippedSyncs: 0 });
        }
        if (String(target) === '/proc/12345/stat') return procStat();
        if (String(target) === `/proc/${process.pid}/stat`) return procStat();
        if (String(target) === PID_FILE) return pidContent;
        return '';
      });
      mockedFs.openSync.mockReturnValue(10);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await expect(startDaemon()).resolves.toEqual(expect.objectContaining({ pid: 12345 }));
      } finally {
        kill.mockRestore();
      }
    });

    it('does not spawn when another process wins the atomic startup claim', async () => {
      mockLoadSyncConfigs.mockReturnValue([{ autoSync: true }]);
      mockedFs.existsSync.mockReturnValue(false);
      mockedFs.readFileSync.mockImplementation(target => {
        if (String(target) === `/proc/${process.pid}/stat`) return procStat();
        return '';
      });
      mockedFs.writeFileSync.mockImplementation((_target, _content, options) => {
        if (typeof options === 'object' && options !== null && 'flag' in options && options.flag === 'wx') {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      });

      await expect(startDaemon()).rejects.toThrow('Another daemon start is already in progress');
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('checkLingerStatus', () => {
    it('should return "unknown" on non-Linux platforms', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      try {
        expect(checkLingerStatus()).toBe('unknown');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return "enabled" when linger file exists on Linux', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mockedFs.existsSync.mockReturnValue(true);
      try {
        expect(checkLingerStatus()).toBe('enabled');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return "disabled" when linger file does not exist on Linux', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mockedFs.existsSync.mockReturnValue(false);
      try {
        expect(checkLingerStatus()).toBe('disabled');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });
});
