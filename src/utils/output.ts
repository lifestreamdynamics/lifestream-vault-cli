import chalk from 'chalk';
import ora from 'ora';
import type { GlobalFlags, OutputFormat } from './flags.js';

/**
 * Column definition for table output.
 */
export interface TableColumn {
  key: string;
  header: string;
  width?: number;
}

/**
 * Output helper that centralizes formatting for text, json, and table modes.
 * Status messages go to stderr so stdout stays clean for piping.
 */
export class Output {
  private flags: GlobalFlags;
  private spinner: ReturnType<typeof ora> | null = null;

  constructor(flags: GlobalFlags) {
    this.flags = flags;
  }

  /**
   * Start a spinner (only shown in text mode, non-quiet, TTY).
   */
  startSpinner(message: string): void {
    if (this.flags.output === 'text' && !this.flags.quiet && process.stderr.isTTY) {
      this.spinner = ora({ text: message, stream: process.stderr }).start();
    }
  }

  /**
   * Stop the spinner without a status symbol.
   */
  stopSpinner(): void {
    this.spinner?.stop();
    this.spinner = null;
  }

  /**
   * Stop the spinner with a success message.
   */
  succeedSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.succeed(message);
      this.spinner = null;
    } else if (this.flags.output === 'text' && !this.flags.quiet) {
      process.stderr.write(chalk.green('✓') + ' ' + message + '\n');
    }
  }

  /**
   * Stop the spinner with a failure message.
   */
  failSpinner(message: string): void {
    if (this.spinner) {
      this.spinner.fail(message);
      this.spinner = null;
    } else {
      process.stderr.write(chalk.red('✖') + ' ' + message + '\n');
    }
  }

  /**
   * Print a status/info message to stderr (never captured by piping).
   */
  status(message: string): void {
    if (!this.flags.quiet) {
      process.stderr.write(message + '\n');
    }
  }

  /**
   * Print a verbose/debug message to stderr.
   */
  debug(message: string): void {
    if (this.flags.verbose) {
      process.stderr.write(chalk.dim('[debug] ' + message) + '\n');
    }
  }

  /**
   * Print an error message to stderr.
   */
  error(message: string): void {
    process.stderr.write(chalk.red(message) + '\n');
  }

  /**
   * Print a warning message to stderr.
   */
  warn(message: string): void {
    if (!this.flags.quiet) {
      process.stderr.write(chalk.yellow(message) + '\n');
    }
  }

  /**
   * Output a single record based on the format.
   * - text: prints key-value lines
   * - json: prints a single JSON object
   * - table: prints a single-row table
   */
  record(data: Record<string, unknown>, columns?: TableColumn[]): void {
    switch (this.flags.output) {
      case 'json':
        process.stdout.write(JSON.stringify(data) + '\n');
        break;
      case 'table':
        this.table([data], columns);
        break;
      case 'text':
      default:
        this.printKeyValue(data);
        break;
    }
  }

  /**
   * Output a list of records based on the format.
   * - text: prints each item using textFn, or key-value pairs
   * - json: prints one JSON object per line (JSON Lines)
   * - table: prints an ASCII table
   */
  list(
    data: Record<string, unknown>[],
    options?: {
      columns?: TableColumn[];
      textFn?: (item: Record<string, unknown>) => string;
      emptyMessage?: string;
    },
  ): void {
    if (data.length === 0) {
      if (this.flags.output === 'json') {
        // empty json array: no output
        return;
      }
      if (options?.emptyMessage && !this.flags.quiet) {
        this.status(options.emptyMessage);
      }
      return;
    }

    switch (this.flags.output) {
      case 'json':
        for (const item of data) {
          process.stdout.write(JSON.stringify(item) + '\n');
        }
        break;
      case 'table':
        this.table(data, options?.columns);
        break;
      case 'text':
      default:
        if (options?.textFn) {
          for (const item of data) {
            process.stdout.write(options.textFn(item) + '\n');
          }
        } else {
          for (const item of data) {
            this.printKeyValue(item);
            process.stdout.write('\n');
          }
        }
        break;
    }
  }

  /**
   * Output raw content to stdout (for piping document content, etc.).
   */
  raw(content: string): void {
    process.stdout.write(content);
  }

  /**
   * Print a success result (used for create/update/delete confirmations).
   */
  success(message: string, data?: Record<string, unknown>): void {
    if (this.flags.output === 'json' && data) {
      process.stdout.write(JSON.stringify(data) + '\n');
    } else if (!this.flags.quiet) {
      this.succeedSpinner(message);
      if (data && this.flags.output === 'text') {
        this.printKeyValue(data);
      }
    }
  }

  private printKeyValue(data: Record<string, unknown>): void {
    const maxKeyLen = Math.max(...Object.keys(data).map(k => k.length));
    for (const [key, value] of Object.entries(data)) {
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      const padding = ' '.repeat(Math.max(0, maxKeyLen - key.length + 1));
      const displayValue = value === null || value === undefined
        ? chalk.dim('none')
        : String(value);
      process.stdout.write(`${label}:${padding}${displayValue}\n`);
    }
  }

  private table(data: Record<string, unknown>[], columns?: TableColumn[]): void {
    if (data.length === 0) return;

    const cols: TableColumn[] = columns ?? Object.keys(data[0]).map(key => ({
      key,
      header: key.charAt(0).toUpperCase() + key.slice(1),
    }));

    // Calculate column widths
    const widths = cols.map(col => {
      const headerLen = col.header.length;
      const maxDataLen = Math.max(
        ...data.map(row => String(row[col.key] ?? '').length),
        0,
      );
      return col.width ?? Math.max(headerLen, maxDataLen);
    });

    const separator = '─';
    const corner = {
      tl: '┌', tr: '┐', bl: '└', br: '┘',
      ml: '├', mr: '┤', t: '┬', b: '┴', m: '┼',
    };

    // Top border
    const topBorder = corner.tl + widths.map(w => separator.repeat(w + 2)).join(corner.t) + corner.tr;
    process.stdout.write(topBorder + '\n');

    // Header row
    const headerRow = '│' + cols.map((col, i) =>
      ' ' + col.header.padEnd(widths[i]) + ' '
    ).join('│') + '│';
    process.stdout.write(headerRow + '\n');

    // Header separator
    const headerSep = corner.ml + widths.map(w => separator.repeat(w + 2)).join(corner.m) + corner.mr;
    process.stdout.write(headerSep + '\n');

    // Data rows
    for (const row of data) {
      const dataRow = '│' + cols.map((col, i) =>
        ' ' + String(row[col.key] ?? '').padEnd(widths[i]) + ' '
      ).join('│') + '│';
      process.stdout.write(dataRow + '\n');
    }

    // Bottom border
    const bottomBorder = corner.bl + widths.map(w => separator.repeat(w + 2)).join(corner.b) + corner.br;
    process.stdout.write(bottomBorder + '\n');
  }
}

/**
 * Create an Output instance from global flags.
 */
export function createOutput(flags: GlobalFlags): Output {
  return new Output(flags);
}

/**
 * Standard error handler for commands.
 * Prints error to stderr and sets exit code.
 */
export function handleError(out: Output, err: unknown, spinnerMessage?: string): void {
  if (spinnerMessage) {
    out.failSpinner(spinnerMessage);
  }
  const message = err instanceof Error ? err.message : String(err);
  out.error(message);
  process.exitCode = 1;
}
