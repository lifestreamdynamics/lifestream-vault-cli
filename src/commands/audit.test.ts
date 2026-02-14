import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerAuditCommands } from './audit.js';
import { spyOutput } from '../__tests__/setup.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-test-'));
}

function writeAuditLog(logPath: string, entries: Array<Record<string, unknown>>): void {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(logPath, lines, 'utf-8');
}

describe('audit commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;
  let tmpDir: string;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerAuditCommands(program);
    outputSpy = spyOutput();
    tmpDir = makeTempDir();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  describe('audit log', () => {
    it('should display entries from the audit log', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      writeAuditLog(logPath, [
        { timestamp: '2026-02-13T12:00:00.000Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 45 },
        { timestamp: '2026-02-13T12:01:00.000Z', method: 'POST', path: '/api/v1/vaults', status: 201, durationMs: 120 },
      ]);

      await program.parseAsync(['node', 'cli', 'audit', 'log', '--log-path', logPath]);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('GET');
      expect(stdout).toContain('POST');
      expect(stdout).toContain('/api/v1/vaults');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('2 entries shown');
    });

    it('should show message when no entries found', async () => {
      const logPath = path.join(tmpDir, 'nonexistent.log');

      await program.parseAsync(['node', 'cli', 'audit', 'log', '--log-path', logPath]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No audit log entries found');
    });

    it('should filter by --tail', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      const entries = Array.from({ length: 10 }, (_, i) => ({
        timestamp: `2026-02-13T12:0${i}:00.000Z`,
        method: 'GET',
        path: '/api/v1/vaults',
        status: 200,
        durationMs: i * 10,
      }));
      writeAuditLog(logPath, entries);

      await program.parseAsync(['node', 'cli', 'audit', 'log', '--log-path', logPath, '--tail', '3']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('3 entries shown');
    });

    it('should filter by --status', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      writeAuditLog(logPath, [
        { timestamp: '2026-02-13T12:00:00.000Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 45 },
        { timestamp: '2026-02-13T12:01:00.000Z', method: 'GET', path: '/api/v1/vaults', status: 401, durationMs: 10 },
        { timestamp: '2026-02-13T12:02:00.000Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 50 },
      ]);

      await program.parseAsync(['node', 'cli', 'audit', 'log', '--log-path', logPath, '--status', '401']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('1 entries shown');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('401');
    });

    it('should filter by --since and --until', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      writeAuditLog(logPath, [
        { timestamp: '2026-02-01T12:00:00.000Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 45 },
        { timestamp: '2026-02-10T12:00:00.000Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 50 },
        { timestamp: '2026-02-13T12:00:00.000Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 55 },
      ]);

      await program.parseAsync(['node', 'cli', 'audit', 'log', '--log-path', logPath, '--since', '2026-02-05', '--until', '2026-02-11']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('1 entries shown');
    });
  });

  describe('audit export', () => {
    it('should export entries as CSV to stdout when no --file', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      writeAuditLog(logPath, [
        { timestamp: '2026-02-13T12:00:00Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 45 },
      ]);

      await program.parseAsync(['node', 'cli', 'audit', 'export', '--log-path', logPath]);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('timestamp,method,path,status,durationMs');
      expect(stdout).toContain('/api/v1/vaults');
    });

    it('should export entries as CSV to a file with --file', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      const outputPath = path.join(tmpDir, 'export.csv');
      writeAuditLog(logPath, [
        { timestamp: '2026-02-13T12:00:00Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 45 },
        { timestamp: '2026-02-13T12:01:00Z', method: 'POST', path: '/api/v1/vaults', status: 201, durationMs: 120 },
      ]);

      await program.parseAsync(['node', 'cli', 'audit', 'export', '--log-path', logPath, '--file', outputPath]);

      expect(fs.existsSync(outputPath)).toBe(true);
      const csv = fs.readFileSync(outputPath, 'utf-8');
      expect(csv).toContain('timestamp,method,path,status,durationMs');
      expect(csv).toContain('2026-02-13T12:00:00Z');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Exported 2 entries');
    });

    it('should show message when no entries to export', async () => {
      const logPath = path.join(tmpDir, 'nonexistent.log');

      await program.parseAsync(['node', 'cli', 'audit', 'export', '--log-path', logPath]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No audit log entries to export');
    });

    it('should reject unsupported formats', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      writeAuditLog(logPath, [
        { timestamp: '2026-02-13T12:00:00Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 45 },
      ]);

      await program.parseAsync(['node', 'cli', 'audit', 'export', '--log-path', logPath, '--format', 'json']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Unsupported format');
    });

    it('should filter exported entries by --status', async () => {
      const logPath = path.join(tmpDir, 'audit.log');
      const outputPath = path.join(tmpDir, 'export.csv');
      writeAuditLog(logPath, [
        { timestamp: '2026-02-13T12:00:00Z', method: 'GET', path: '/api/v1/vaults', status: 200, durationMs: 45 },
        { timestamp: '2026-02-13T12:01:00Z', method: 'GET', path: '/api/v1/vaults', status: 401, durationMs: 10 },
      ]);

      await program.parseAsync(['node', 'cli', 'audit', 'export', '--log-path', logPath, '--file', outputPath, '--status', '401']);

      const csv = fs.readFileSync(outputPath, 'utf-8');
      const lines = csv.trim().split('\n');
      // Header + 1 data line
      expect(lines).toHaveLength(2);
      expect(csv).toContain('401');
      expect(csv).not.toContain(',200,');
    });
  });
});
