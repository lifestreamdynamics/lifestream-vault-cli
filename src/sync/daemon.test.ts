import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('node:fs');
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
  })),
}));

const mockedFs = vi.mocked(fs);

import {
  readPid,
  writePid,
  removePid,
  isProcessRunning,
  getDaemonStatus,
  rotateLogIfNeeded,
  startDaemon,
  stopDaemon,
  PID_FILE,
  LOG_FILE,
} from './daemon.js';

describe('sync daemon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it('should return null for corrupt PID file', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('not-a-number');
      expect(readPid()).toBeNull();
    });
  });

  describe('writePid', () => {
    it('should create daemon dir and write PID', () => {
      mockedFs.existsSync.mockReturnValue(false);
      writePid(12345);
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('daemon'),
        { recursive: true },
      );
      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        PID_FILE,
        '12345\n',
      );
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
    it('should return false when no daemon running', () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(stopDaemon()).toBe(false);
    });

    it('should return false for stale PID', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue('999999999\n');
      expect(stopDaemon()).toBe(false);
    });
  });

  describe('startDaemon', () => {
    it('should throw when daemon is already running', () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readFileSync.mockReturnValue(`${process.pid}\n`);
      mockedFs.statSync.mockReturnValue({ birthtime: new Date(), birthtimeMs: Date.now() } as fs.Stats);
      expect(() => startDaemon()).toThrow('already running');
    });
  });
});
