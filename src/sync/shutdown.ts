/**
 * Shared shutdown-drain helpers for the watcher, remote poller, and daemon.
 */
import { getHttpTimeoutMs } from '../client.js';

/**
 * Extra time granted on top of the HTTP timeout so an in-flight request can
 * settle (and its state be persisted) before a drain is declared stuck.
 */
export const SHUTDOWN_DRAIN_GRACE_MS = 5_000;

/** Default bound for a watcher/poller drain: one HTTP timeout plus grace. */
export function defaultShutdownTimeoutMs(): number {
  return getHttpTimeoutMs() + SHUTDOWN_DRAIN_GRACE_MS;
}

/**
 * Await `pending` for at most `timeoutMs`. Rejects with `<label> timed out
 * after <ms>ms` when the deadline passes first; the timer never keeps the
 * process alive and is always cleared.
 */
export async function awaitWithTimeout<T>(pending: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timeout');
  const deadline = new Promise<typeof timedOut>(resolve => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([pending, deadline]);
    if (outcome === timedOut) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    return outcome as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
