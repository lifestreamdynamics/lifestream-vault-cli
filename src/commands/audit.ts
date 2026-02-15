import type { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '@lifestreamdynamics/vault-sdk';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.lsvault', 'audit.log');

export function registerAuditCommands(program: Command): void {
  const audit = program.command('audit').description('View and export local API request audit logs');

  addGlobalFlags(audit.command('log')
    .description('View recent audit log entries with optional filters')
    .option('--tail <n>', 'Show last N entries', parseInt)
    .option('--status <code>', 'Filter by HTTP status code', parseInt)
    .option('--since <date>', 'Show entries since date (ISO 8601)')
    .option('--until <date>', 'Show entries until date (ISO 8601)')
    .option('--log-path <path>', 'Path to audit log file')
    .addHelpText('after', `
EXAMPLES
  lsvault audit log --tail 20
  lsvault audit log --status 401 --since 2025-01-01
  lsvault audit log --since 2025-01-01 --until 2025-01-31`))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        const logger = new AuditLogger({ logPath: String(_opts.logPath || DEFAULT_LOG_PATH) });
        const entries = logger.readEntries({
          tail: _opts.tail as number | undefined,
          status: _opts.status as number | undefined,
          since: _opts.since as string | undefined,
          until: _opts.until as string | undefined,
        });

        out.list(
          entries.map(e => ({
            timestamp: e.timestamp,
            method: e.method,
            path: e.path,
            status: e.status,
            durationMs: e.durationMs,
          })),
          {
            emptyMessage: 'No audit log entries found.',
            columns: [
              { key: 'timestamp', header: 'Timestamp' },
              { key: 'method', header: 'Method' },
              { key: 'path', header: 'Path' },
              { key: 'status', header: 'Status' },
              { key: 'durationMs', header: 'Duration (ms)' },
            ],
            textFn: (e) => {
              const statusColor = getStatusColor(Number(e.status));
              return `${chalk.dim(String(e.timestamp))} ${chalk.bold(String(e.method).padEnd(7))} ${String(e.path)} ${statusColor(String(e.status))} ${chalk.dim(`${String(e.durationMs)}ms`)}`;
            },
          },
        );

        if (flags.output === 'text' && entries.length > 0) {
          out.status(chalk.dim(`\n${entries.length} entries shown`));
        }
      } catch (err) {
        handleError(out, err, 'Failed to read audit log');
      }
    });

  addGlobalFlags(audit.command('export')
    .description('Export audit log entries to a CSV file or stdout')
    .option('--format <format>', 'Export format (csv)', 'csv')
    .option('--file <file>', 'Output file path')
    .option('--status <code>', 'Filter by HTTP status code', parseInt)
    .option('--since <date>', 'Show entries since date (ISO 8601)')
    .option('--until <date>', 'Show entries until date (ISO 8601)')
    .option('--log-path <path>', 'Path to audit log file'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      try {
        if (_opts.format !== 'csv') {
          out.error(`Unsupported format: ${String(_opts.format)}. Only 'csv' is supported.`);
          process.exitCode = 2;
          return;
        }

        const logger = new AuditLogger({ logPath: String(_opts.logPath || DEFAULT_LOG_PATH) });
        const entries = logger.readEntries({
          status: _opts.status as number | undefined,
          since: _opts.since as string | undefined,
          until: _opts.until as string | undefined,
        });

        if (entries.length === 0) {
          out.status('No audit log entries to export.');
          return;
        }

        const csv = logger.exportCsv(entries);

        if (_opts.file) {
          const outputPath = String(_opts.file);
          const outputDir = path.dirname(outputPath);
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }
          fs.writeFileSync(outputPath, csv, 'utf-8');
          out.success(`Exported ${entries.length} entries to ${outputPath}`, {
            entries: entries.length,
            path: outputPath,
          });
        } else {
          out.raw(csv);
        }
      } catch (err) {
        handleError(out, err, 'Failed to export audit log');
      }
    });
}

function getStatusColor(status: number): (text: string) => string {
  if (status >= 500) return chalk.red;
  if (status >= 400) return chalk.yellow;
  if (status >= 300) return chalk.cyan;
  return chalk.green;
}
