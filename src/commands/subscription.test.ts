import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSubscriptionCommands } from './subscription.js';
import { createSDKMock, type SDKMock } from '../__tests__/mocks/sdk.js';
import { spyOutput } from '../__tests__/setup.js';

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

let sdkMock: SDKMock;
vi.mock('../client.js', () => ({
  getClientAsync: vi.fn(async () => sdkMock),
}));

describe('subscription commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerSubscriptionCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('subscription status', () => {
    it('should display subscription details and usage', async () => {
      sdkMock.subscription.get.mockResolvedValue({
        subscription: { tier: 'pro', expiresAt: '2025-12-31T00:00:00Z', isActive: true },
        usage: {
          vaultCount: 5,
          totalStorageBytes: 10485760,
          apiCallsThisMonth: 42,
          aiTokens: 1000,
          hookExecutions: 25,
          webhookDeliveries: 10,
        },
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'status']);

      expect(sdkMock.subscription.get).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('pro');
      expect(stdout).toContain('yes');
      expect(stdout).toContain('42');
    });

    it('should show free tier with no expiry', async () => {
      sdkMock.subscription.get.mockResolvedValue({
        subscription: { tier: 'free', expiresAt: null, isActive: true },
        usage: {
          vaultCount: 0,
          totalStorageBytes: 0,
          apiCallsThisMonth: 0,
          aiTokens: 0,
          hookExecutions: 0,
          webhookDeliveries: 0,
        },
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'status']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('free');
      expect(stdout).toContain('never');
    });

    it('should handle errors', async () => {
      sdkMock.subscription.get.mockRejectedValue(new Error('Auth failed'));

      await program.parseAsync(['node', 'cli', 'subscription', 'status']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Auth failed');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('subscription plans', () => {
    it('should list available plans', async () => {
      sdkMock.subscription.listPlans.mockResolvedValue([
        { tier: 'free', name: 'Free', limits: { maxVaults: 3 }, features: { ai: false } },
        { tier: 'pro', name: 'Pro', limits: { maxVaults: 20 }, features: { ai: true } },
      ]);

      await program.parseAsync(['node', 'cli', 'subscription', 'plans']);

      expect(sdkMock.subscription.listPlans).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Free');
      expect(stdout).toContain('Pro');
      expect(stdout).toContain('maxVaults');
    });

    it('should handle empty plans', async () => {
      sdkMock.subscription.listPlans.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'subscription', 'plans']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No plans available');
    });

    it('should handle errors', async () => {
      sdkMock.subscription.listPlans.mockRejectedValue(new Error('Network error'));

      await program.parseAsync(['node', 'cli', 'subscription', 'plans']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Network error');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('subscription upgrade', () => {
    it('should create a checkout session', async () => {
      sdkMock.subscription.createCheckoutSession.mockResolvedValue({
        url: 'https://checkout.example.com/ses_123',
        sessionId: 'ses_123',
      });

      await program.parseAsync([
        'node', 'cli', 'subscription', 'upgrade', 'pro',
        '--return-url', 'https://app.example.com/success',
      ]);

      expect(sdkMock.subscription.createCheckoutSession).toHaveBeenCalledWith(
        'pro',
        'https://app.example.com/success',
      );
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('https://checkout.example.com/ses_123');
    });

    it('should handle errors', async () => {
      sdkMock.subscription.createCheckoutSession.mockRejectedValue(
        new Error('Requested tier must be an upgrade'),
      );

      await program.parseAsync([
        'node', 'cli', 'subscription', 'upgrade', 'free',
        '--return-url', 'https://app.example.com/success',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('upgrade');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('subscription status — billing state', () => {
    it('shows a failed payment and when the plan ends', async () => {
      sdkMock.subscription.get.mockResolvedValue({
        subscription: { tier: 'pro', expiresAt: '2026-09-22T00:00:00Z', isActive: true, status: 'past_due' },
        usage: {
          vaultCount: 1, totalStorageBytes: 0, apiCallsThisMonth: 0,
          aiTokens: 0, hookExecutions: 0, webhookDeliveries: 0,
        },
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'status']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('payment failed');
      expect(stdout).toContain('2026-09-22T00:00:00Z');
    });

    it('shows a failed payment with no expiry date without printing "null"', async () => {
      sdkMock.subscription.get.mockResolvedValue({
        subscription: { tier: 'pro', expiresAt: null, isActive: true, status: 'past_due' },
        usage: {
          vaultCount: 1, totalStorageBytes: 0, apiCallsThisMonth: 0,
          aiTokens: 0, hookExecutions: 0, webhookDeliveries: 0,
        },
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'status']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('payment failed');
      expect(stdout).not.toContain('null');
    });

    it('shows a cancelled subscription and when it stops being active', async () => {
      sdkMock.subscription.get.mockResolvedValue({
        subscription: { tier: 'pro', expiresAt: '2026-10-01T00:00:00Z', isActive: true, status: 'cancelled' },
        usage: {
          vaultCount: 1, totalStorageBytes: 0, apiCallsThisMonth: 0,
          aiTokens: 0, hookExecutions: 0, webhookDeliveries: 0,
        },
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'status']);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('cancelled');
      expect(stdout).toContain('2026-10-01T00:00:00Z');
    });

    it('defaults JSON status to "active" when the server omits it', async () => {
      sdkMock.subscription.get.mockResolvedValue({
        subscription: { tier: 'pro', expiresAt: null, isActive: true },
        usage: {
          vaultCount: 1, totalStorageBytes: 0, apiCallsThisMonth: 0,
          aiTokens: 0, hookExecutions: 0, webhookDeliveries: 0,
        },
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'status', '--output', 'json']);

      const stdout = outputSpy.stdout.join('');
      expect(JSON.parse(stdout)).toMatchObject({ status: 'active' });
    });
  });

  describe('subscription cancel', () => {
    it('should cancel with reason when --yes is provided', async () => {
      sdkMock.subscription.cancel.mockResolvedValue({ message: 'Subscription cancelled', accessUntil: null });

      await program.parseAsync([
        'node', 'cli', 'subscription', 'cancel',
        '--reason', 'Too expensive', '--yes',
      ]);

      expect(sdkMock.subscription.cancel).toHaveBeenCalledWith('Too expensive');
    });

    it('reports when a cancelled plan stops being active, on stderr (a status message, not piped data)', async () => {
      sdkMock.subscription.cancel.mockResolvedValue({
        message: 'Subscription cancelled',
        accessUntil: '2026-10-01T00:00:00.000Z',
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'cancel', '--yes']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('2026-10-01T00:00:00.000Z');
      // Text mode must not also print the date via a key-value dump of the result.
      const stdout = outputSpy.stdout.join('');
      expect(stdout).not.toContain('2026-10-01T00:00:00.000Z');
    });

    it('reports plain cancellation text, with no date, when accessUntil is null', async () => {
      sdkMock.subscription.cancel.mockResolvedValue({ message: 'Subscription cancelled', accessUntil: null });

      await program.parseAsync(['node', 'cli', 'subscription', 'cancel', '--yes']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Subscription cancelled');
      expect(stderr).not.toContain('null');
      expect(stderr).not.toMatch(/stays active until/);
    });

    it('emits { cancelled: true, accessUntil } as JSON', async () => {
      sdkMock.subscription.cancel.mockResolvedValue({
        message: 'Subscription cancelled',
        accessUntil: '2026-10-01T00:00:00.000Z',
      });

      await program.parseAsync(['node', 'cli', 'subscription', 'cancel', '--yes', '--output', 'json']);

      const stdout = outputSpy.stdout.join('');
      expect(JSON.parse(stdout)).toEqual({ cancelled: true, accessUntil: '2026-10-01T00:00:00.000Z' });
    });

    it('should cancel without reason when --yes is provided', async () => {
      sdkMock.subscription.cancel.mockResolvedValue({ message: 'Subscription cancelled', accessUntil: null });

      await program.parseAsync(['node', 'cli', 'subscription', 'cancel', '--yes']);

      expect(sdkMock.subscription.cancel).toHaveBeenCalledWith(undefined);
    });

    it('should abort when non-interactive and --yes not provided', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      await program.parseAsync(['node', 'cli', 'subscription', 'cancel']);

      // SDK should NOT have been called because the action threw before reaching it
      expect(sdkMock.subscription.cancel).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('non-interactive');
      expect(process.exitCode).toBe(1);
    });

    it('should handle errors', async () => {
      sdkMock.subscription.cancel.mockRejectedValue(new Error('No active subscription'));

      await program.parseAsync(['node', 'cli', 'subscription', 'cancel', '--yes']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No active subscription');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('subscription portal', () => {
    it('should create a portal session', async () => {
      sdkMock.subscription.createPortalSession.mockResolvedValue({
        url: 'https://billing.example.com/portal-1',
      });

      await program.parseAsync([
        'node', 'cli', 'subscription', 'portal',
        '--return-url', 'https://app.example.com/billing',
      ]);

      expect(sdkMock.subscription.createPortalSession).toHaveBeenCalledWith(
        'https://app.example.com/billing',
      );
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('https://billing.example.com/portal-1');
    });

    it('should handle errors', async () => {
      sdkMock.subscription.createPortalSession.mockRejectedValue(new Error('Billing unavailable'));

      await program.parseAsync([
        'node', 'cli', 'subscription', 'portal',
        '--return-url', 'https://app.example.com/billing',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Billing unavailable');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('subscription invoices', () => {
    it('should list invoices', async () => {
      sdkMock.subscription.listInvoices.mockResolvedValue([
        {
          id: 'inv_1',
          amount: 999,
          currency: 'usd',
          status: 'paid',
          createdAt: '2024-06-01',
          paidAt: '2024-06-01',
          invoiceUrl: 'https://invoice.example.com/1',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'subscription', 'invoices']);

      expect(sdkMock.subscription.listInvoices).toHaveBeenCalled();
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('9.99');
      expect(stdout).toContain('USD');
      expect(stdout).toContain('paid');
    });

    it('should show message when no invoices', async () => {
      sdkMock.subscription.listInvoices.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'subscription', 'invoices']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No invoices found');
    });

    it('should handle errors', async () => {
      sdkMock.subscription.listInvoices.mockRejectedValue(new Error('Failed'));

      await program.parseAsync(['node', 'cli', 'subscription', 'invoices']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Failed');
      expect(process.exitCode).toBe(1);
    });
  });
});
