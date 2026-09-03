import { describe, expect, it } from 'vitest';
import { awaitWithTimeout, defaultShutdownTimeoutMs, SHUTDOWN_DRAIN_GRACE_MS } from './shutdown.js';
import { getHttpTimeoutMs } from '../client.js';

describe('shutdown helpers', () => {
  it('resolves with the pending value when it settles before the deadline', async () => {
    await expect(awaitWithTimeout(Promise.resolve('done'), 1_000, 'Drain')).resolves.toBe('done');
  });

  it('rejects with a labelled timeout when the deadline passes first', async () => {
    await expect(awaitWithTimeout(new Promise(() => undefined), 5, 'Poller shutdown drain'))
      .rejects.toThrow('Poller shutdown drain timed out after 5ms');
  });

  it('propagates the pending rejection unchanged', async () => {
    await expect(awaitWithTimeout(Promise.reject(new Error('boom')), 1_000, 'Drain')).rejects.toThrow('boom');
  });

  it('derives the default drain bound from the HTTP timeout plus the grace period', () => {
    expect(defaultShutdownTimeoutMs()).toBe(getHttpTimeoutMs() + SHUTDOWN_DRAIN_GRACE_MS);
  });
});
