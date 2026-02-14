import type { Command } from 'commander';
import chalk from 'chalk';

export type OutputFormat = 'text' | 'json' | 'table';

export interface GlobalFlags {
  output: OutputFormat;
  verbose: boolean;
  quiet: boolean;
  noColor: boolean;
  dryRun: boolean;
}

/**
 * Add universal flags to a command.
 * Call this on each leaf command (action command) to register the flags.
 */
export function addGlobalFlags(cmd: Command): Command {
  return cmd
    .option('-o, --output <format>', 'Output format: text, json, table (default: auto)')
    .option('-v, --verbose', 'Verbose output (debug info)')
    .option('-q, --quiet', 'Minimal output (errors only)')
    .option('--no-color', 'Disable colored output')
    .option('--dry-run', 'Preview changes (where applicable)');
}

/**
 * Resolve global flags from parsed options, applying TTY detection defaults.
 */
export function resolveFlags(opts: Record<string, unknown>): GlobalFlags {
  const isTTY = process.stdout.isTTY ?? false;
  const noColor = opts.noColor === true || opts.color === false;
  const format = (opts.output as string | undefined) ?? (isTTY ? 'text' : 'json');

  if (noColor) {
    chalk.level = 0;
  }

  return {
    output: format as OutputFormat,
    verbose: opts.verbose === true,
    quiet: opts.quiet === true,
    noColor,
    dryRun: opts.dryRun === true,
  };
}
