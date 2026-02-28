import readline from 'node:readline';

/**
 * Prompt the user to confirm a destructive action.
 *
 * @param message - The confirmation message to display (without " [y/N] " suffix)
 * @param options.yes - If true, skip the prompt and return true immediately (e.g. --yes flag)
 * @returns Promise resolving to true if confirmed, false if declined
 * @throws Error if stdin is not a TTY and --yes was not provided
 */
export async function confirmAction(message: string, options?: { yes?: boolean }): Promise<boolean> {
  if (options?.yes) return true;

  if (!process.stdin.isTTY) {
    throw new Error(
      'Cannot prompt for confirmation in non-interactive mode. Use --yes to skip confirmation.',
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
