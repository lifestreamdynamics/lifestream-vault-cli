import { vi } from 'vitest';
import { Writable } from 'stream';

/**
 * Creates a writable stream that captures output chunks.
 */
export const captureStream = () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, getOutput: () => chunks.join('') };
};

/**
 * Spy helpers for console.log/error that capture output and auto-restore.
 */
export function spyConsole() {
  const logs: string[] = [];
  const errors: string[] = [];

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });

  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });

  return {
    logs,
    errors,
    restore() {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

/**
 * Spy helpers for process.stdout.write/process.stderr.write that capture output.
 * Use this for commands that use the Output utility (write to process streams).
 */
export function spyOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  // Force TTY mode so resolveFlags() defaults to 'text' output (not 'json')
  const prevIsTTY = process.stdout.isTTY;
  process.stdout.isTTY = true;

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });

  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });

  return {
    stdout,
    stderr,
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      process.stdout.isTTY = prevIsTTY;
    },
  };
}
