import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Output, createOutput, handleError } from './output.js';
import type { GlobalFlags } from './flags.js';
import { resolveFlags } from './flags.js';

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

describe('resolveFlags', () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('should default to text format in TTY mode', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const flags = resolveFlags({});
    expect(flags.output).toBe('text');
  });

  it('should default to json format in non-TTY mode', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const flags = resolveFlags({});
    expect(flags.output).toBe('json');
  });

  it('should respect explicit output format', () => {
    const flags = resolveFlags({ output: 'table' });
    expect(flags.output).toBe('table');
  });

  it('should parse boolean flags', () => {
    const flags = resolveFlags({ verbose: true, quiet: true, dryRun: true });
    expect(flags.verbose).toBe(true);
    expect(flags.quiet).toBe(true);
    expect(flags.dryRun).toBe(true);
  });

  it('should handle --no-color (color=false)', () => {
    const flags = resolveFlags({ color: false });
    expect(flags.noColor).toBe(true);
  });
});

describe('Output', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutWrite: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrWrite: any;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  function makeFlags(overrides: Partial<GlobalFlags> = {}): GlobalFlags {
    return {
      output: 'text',
      verbose: false,
      quiet: false,
      noColor: true,
      dryRun: false,
      ...overrides,
    };
  }

  describe('record', () => {
    it('should output key-value pairs in text mode', () => {
      const out = createOutput(makeFlags());
      out.record({ name: 'Test', id: '123' });
      const output = stdoutChunks.join('');
      expect(output).toContain('Name:');
      expect(output).toContain('Test');
      expect(output).toContain('Id:');
      expect(output).toContain('123');
    });

    it('should output JSON in json mode', () => {
      const out = createOutput(makeFlags({ output: 'json' }));
      out.record({ name: 'Test', id: '123' });
      const output = stdoutChunks.join('');
      const parsed = JSON.parse(output.trim());
      expect(parsed.name).toBe('Test');
      expect(parsed.id).toBe('123');
    });

    it('should output table in table mode', () => {
      const out = createOutput(makeFlags({ output: 'table' }));
      out.record({ name: 'Test', id: '123' });
      const output = stdoutChunks.join('');
      expect(output).toContain('Name');
      expect(output).toContain('Test');
      expect(output).toContain('Id');
      expect(output).toContain('123');
      // Table should have borders
      expect(output).toContain('┌');
      expect(output).toContain('└');
    });
  });

  describe('list', () => {
    const data = [
      { name: 'Alpha', id: '1' },
      { name: 'Beta', id: '2' },
    ];

    it('should output one JSON line per item in json mode', () => {
      const out = createOutput(makeFlags({ output: 'json' }));
      out.list(data);
      const lines = stdoutChunks.join('').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ name: 'Alpha', id: '1' });
      expect(JSON.parse(lines[1])).toEqual({ name: 'Beta', id: '2' });
    });

    it('should use textFn in text mode', () => {
      const out = createOutput(makeFlags());
      out.list(data, {
        textFn: (item) => `${String(item.name)} (${String(item.id)})`,
      });
      const output = stdoutChunks.join('');
      expect(output).toContain('Alpha (1)');
      expect(output).toContain('Beta (2)');
    });

    it('should render table with columns', () => {
      const out = createOutput(makeFlags({ output: 'table' }));
      out.list(data, {
        columns: [
          { key: 'name', header: 'Name' },
          { key: 'id', header: 'ID' },
        ],
      });
      const output = stdoutChunks.join('');
      expect(output).toContain('Name');
      expect(output).toContain('ID');
      expect(output).toContain('Alpha');
      expect(output).toContain('Beta');
    });

    it('should show empty message when data is empty (text mode)', () => {
      const out = createOutput(makeFlags());
      out.list([], { emptyMessage: 'Nothing here.' });
      const output = stderrChunks.join('');
      expect(output).toContain('Nothing here.');
    });

    it('should produce no output for empty data in json mode', () => {
      const out = createOutput(makeFlags({ output: 'json' }));
      out.list([], { emptyMessage: 'Nothing here.' });
      expect(stdoutChunks.join('')).toBe('');
    });
  });

  describe('status and debug', () => {
    it('should write status to stderr', () => {
      const out = createOutput(makeFlags());
      out.status('Processing...');
      expect(stderrChunks.join('')).toContain('Processing...');
    });

    it('should suppress status in quiet mode', () => {
      const out = createOutput(makeFlags({ quiet: true }));
      out.status('Processing...');
      expect(stderrChunks.join('')).toBe('');
    });

    it('should write debug to stderr only in verbose mode', () => {
      const out = createOutput(makeFlags({ verbose: false }));
      out.debug('debug info');
      expect(stderrChunks.join('')).toBe('');

      const outVerbose = createOutput(makeFlags({ verbose: true }));
      outVerbose.debug('debug info');
      expect(stderrChunks.join('')).toContain('debug info');
    });
  });

  describe('raw', () => {
    it('should write directly to stdout', () => {
      const out = createOutput(makeFlags());
      out.raw('raw content here');
      expect(stdoutChunks.join('')).toBe('raw content here');
    });
  });

  describe('error', () => {
    it('should always write to stderr', () => {
      const out = createOutput(makeFlags({ quiet: true }));
      out.error('Something went wrong');
      expect(stderrChunks.join('')).toContain('Something went wrong');
    });
  });

  describe('success', () => {
    it('should output JSON data in json mode', () => {
      const out = createOutput(makeFlags({ output: 'json' }));
      out.success('Created!', { id: '123', name: 'New' });
      const output = stdoutChunks.join('');
      const parsed = JSON.parse(output.trim());
      expect(parsed.id).toBe('123');
      expect(parsed.name).toBe('New');
    });
  });
});

describe('handleError', () => {
  let stderrChunks: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrWrite: any;

  beforeEach(() => {
    stderrChunks = [];
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    stderrWrite.mockRestore();
    process.exitCode = undefined;
  });

  it('should extract message from Error objects', () => {
    const out = createOutput({
      output: 'text', verbose: false, quiet: false, noColor: true, dryRun: false,
    });
    handleError(out, new Error('Test error'), 'Operation failed');
    const output = stderrChunks.join('');
    expect(output).toContain('Test error');
    expect(process.exitCode).toBe(1);
  });

  it('should handle non-Error objects', () => {
    const out = createOutput({
      output: 'text', verbose: false, quiet: false, noColor: true, dryRun: false,
    });
    handleError(out, 'string error');
    const output = stderrChunks.join('');
    expect(output).toContain('string error');
    expect(process.exitCode).toBe(1);
  });
});
