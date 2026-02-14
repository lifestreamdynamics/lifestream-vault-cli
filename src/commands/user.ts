import type { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../client.js';
import { addGlobalFlags, resolveFlags } from '../utils/flags.js';
import { createOutput, handleError } from '../utils/output.js';
import { formatBytes } from '../utils/format.js';

export function registerUserCommands(program: Command): void {
  const user = program.command('user').description('View account details and storage usage');

  addGlobalFlags(user.command('storage')
    .description('Show storage usage breakdown by vault and plan limits'))
    .action(async (_opts: Record<string, unknown>) => {
      const flags = resolveFlags(_opts);
      const out = createOutput(flags);
      out.startSpinner('Fetching storage usage...');
      try {
        const client = getClient();
        const storage = await client.user.getStorage();
        out.stopSpinner();

        if (flags.output === 'json') {
          out.record({
            tier: storage.tier,
            totalBytes: storage.totalBytes,
            limitBytes: storage.limitBytes,
            vaultCount: storage.vaultCount,
            vaultLimit: storage.vaultLimit,
            vaults: storage.vaults,
          });
        } else {
          const pct = storage.limitBytes > 0
            ? ((storage.totalBytes / storage.limitBytes) * 100).toFixed(1)
            : '0.0';
          process.stdout.write(`Plan:     ${chalk.green(storage.tier)}\n`);
          process.stdout.write(`Storage:  ${formatBytes(storage.totalBytes)} / ${formatBytes(storage.limitBytes)} (${pct}%)\n`);
          process.stdout.write(`Vaults:   ${storage.vaultCount} / ${storage.vaultLimit}\n`);

          if (storage.vaults.length > 0) {
            process.stdout.write('\n');
            process.stdout.write(chalk.dim('Per-vault breakdown:') + '\n');
            for (const v of storage.vaults) {
              process.stdout.write(`  ${chalk.cyan(v.name)}: ${formatBytes(v.bytes)} (${v.documentCount} docs)\n`);
            }
          }
        }
      } catch (err) {
        handleError(out, err, 'Failed to fetch storage usage');
      }
    });
}
