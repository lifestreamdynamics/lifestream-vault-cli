/**
 * Shared interactive prompt utilities.
 *
 * These helpers write prompts to stderr so they do not corrupt stdout piping,
 * and they disable terminal echo so passwords are never visible on screen or
 * in scroll-back buffers.
 */

/**
 * Prompt for a password from stdin (non-echoing).
 *
 * @param prompt - Label written to stderr before the user types (default: "Password: ")
 * @returns The entered password, or null if stdin is not a TTY (non-interactive).
 */
export async function promptPassword(prompt = 'Password: '): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }

  const readline = await import('node:readline');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    process.stderr.write(prompt);
    (process.stdin as NodeJS.ReadStream).setRawMode?.(true);

    let password = '';
    const onData = (chunk: Buffer) => {
      const char = chunk.toString('utf-8');
      if (char === '\n' || char === '\r' || char === '\u0004') {
        process.stderr.write('\n');
        (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(password);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.stderr.write('\n');
        (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(null);
      } else if (char === '\u007F' || char === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
        }
      } else {
        password += char;
      }
    };

    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

/**
 * Read a password from stdin in non-TTY / CI mode (i.e. piped input).
 *
 * Reads the first line of stdin and trims whitespace. Callers should
 * gate this behind a `--password-stdin` flag so the intent is explicit.
 *
 * @returns The password string, or null if stdin is empty / already ended.
 */
export async function readPasswordFromStdin(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let data = '';
    const onData = (chunk: Buffer | string) => {
      data += chunk.toString('utf-8');
      // Stop after the first newline — we only want one line.
      if (data.includes('\n')) {
        cleanup();
        resolve(data.split('\n')[0].trim() || null);
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(data.trim() || null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
    };

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

/**
 * Prompt for an MFA code from stdin (6 digits, non-echoing).
 *
 * @returns The entered code, or null if stdin is not a TTY.
 */
export async function promptMfaCode(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }

  const readline = await import('node:readline');

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    process.stderr.write('MFA code: ');
    (process.stdin as NodeJS.ReadStream).setRawMode?.(true);

    let code = '';
    const onData = (chunk: Buffer) => {
      const char = chunk.toString('utf-8');
      if (char === '\n' || char === '\r' || char === '\u0004') {
        process.stderr.write('\n');
        (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(code);
      } else if (char === '\u0003') {
        // Ctrl+C
        process.stderr.write('\n');
        (process.stdin as NodeJS.ReadStream).setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        rl.close();
        resolve(null);
      } else if (char === '\u007F' || char === '\b') {
        // Backspace
        if (code.length > 0) {
          code = code.slice(0, -1);
        }
      } else {
        code += char;
      }
    };

    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}
