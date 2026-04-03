import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerBookingCommands } from './booking.js';
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

vi.mock('../utils/resolve-vault.js', () => ({
  resolveVaultId: vi.fn(async (id: string) => id),
}));

describe('booking commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerBookingCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('booking slots list', () => {
    it('should list booking slots for a vault', async () => {
      sdkMock.booking.listSlots.mockResolvedValue([
        {
          id: 'slot-1',
          vaultId: 'v1',
          userId: 'u1',
          title: '30-min consult',
          durationMin: 30,
          bufferMin: 0,
          startTime: '09:00',
          endTime: '17:00',
          daysOfWeek: ['Mon', 'Wed', 'Fri'],
          timezone: 'America/New_York',
          isActive: true,
          maxConcurrent: 1,
          confirmationMode: 'auto',
          createBackingFile: false,
          requirePhone: false,
          priceCents: null,
          currency: 'CAD',
          requirePayment: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'slot-2',
          vaultId: 'v1',
          userId: 'u1',
          title: 'Paid session',
          durationMin: 60,
          bufferMin: 15,
          startTime: '10:00',
          endTime: '18:00',
          daysOfWeek: ['Tue', 'Thu'],
          timezone: 'America/New_York',
          isActive: true,
          maxConcurrent: 1,
          confirmationMode: 'manual',
          createBackingFile: false,
          requirePhone: false,
          priceCents: 5000,
          currency: 'CAD',
          requirePayment: true,
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'booking', 'slots', 'list', 'v1']);

      expect(sdkMock.booking.listSlots).toHaveBeenCalledWith('v1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('30-min consult');
      expect(stdout).toContain('Paid session');
      // Verify price rendering
      expect(stdout).toContain('50.00 CAD');
    });

    it('should show message when no booking slots exist', async () => {
      sdkMock.booking.listSlots.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'booking', 'slots', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No booking slots configured');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.booking.listSlots.mockRejectedValue(new Error('Vault not found'));

      await program.parseAsync(['node', 'cli', 'booking', 'slots', 'list', 'bad-vault']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Vault not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('booking list', () => {
    it('should list bookings for a vault', async () => {
      sdkMock.booking.listBookings.mockResolvedValue({
        bookings: [
          {
            id: 'b1',
            slotId: 'slot-1',
            vaultId: 'v1',
            status: 'confirmed',
            startAt: '2026-03-15T10:00:00Z',
            endAt: '2026-03-15T10:30:00Z',
            guestName: 'Jane Doe',
            guestEmail: 'jane@example.com',
            paymentStatus: 'unpaid',
            createdAt: '2026-03-01T00:00:00Z',
            updatedAt: '2026-03-01T00:00:00Z',
          },
          {
            id: 'b2',
            slotId: 'slot-1',
            vaultId: 'v1',
            status: 'pending',
            startAt: '2026-03-16T14:00:00Z',
            endAt: '2026-03-16T14:30:00Z',
            guestName: 'Bob Smith',
            guestEmail: 'bob@example.com',
            paymentStatus: 'unpaid',
            createdAt: '2026-03-02T00:00:00Z',
            updatedAt: '2026-03-02T00:00:00Z',
          },
        ],
        total: 2,
      });

      await program.parseAsync(['node', 'cli', 'booking', 'list', 'v1']);

      expect(sdkMock.booking.listBookings).toHaveBeenCalledWith('v1', {
        status: undefined,
        slotId: undefined,
        startAfter: undefined,
        startBefore: undefined,
      });
      const stdout = outputSpy.stdout.join('');
      const stderr = outputSpy.stderr.join('');
      expect(stdout).toContain('Jane Doe');
      expect(stdout).toContain('Bob Smith');
      // Total is shown via out.status (goes to stderr)
      expect(stderr).toContain('2 total');
    });

    it('should show empty message when no bookings found', async () => {
      sdkMock.booking.listBookings.mockResolvedValue({ bookings: [], total: 0 });

      await program.parseAsync(['node', 'cli', 'booking', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No bookings found');
    });

    it('should handle errors gracefully', async () => {
      sdkMock.booking.listBookings.mockRejectedValue(new Error('Access denied'));

      await program.parseAsync(['node', 'cli', 'booking', 'list', 'v1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Access denied');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('booking confirm', () => {
    it('should confirm a pending booking', async () => {
      sdkMock.booking.updateBookingStatus.mockResolvedValue({
        id: 'b1',
        slotId: 'slot-1',
        vaultId: 'v1',
        status: 'confirmed',
        startAt: '2026-03-15T10:00:00Z',
        endAt: '2026-03-15T10:30:00Z',
        guestName: 'Jane Doe',
        guestEmail: 'jane@example.com',
        confirmedAt: '2026-03-10T12:00:00Z',
        paymentStatus: 'unpaid',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-10T12:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'booking', 'confirm', 'v1', 'b1']);

      expect(sdkMock.booking.updateBookingStatus).toHaveBeenCalledWith('v1', 'b1', 'confirmed');
      // out.status writes to stderr
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Booking b1 confirmed');
    });

    it('should handle confirmation errors gracefully', async () => {
      sdkMock.booking.updateBookingStatus.mockRejectedValue(new Error('Booking already confirmed'));

      await program.parseAsync(['node', 'cli', 'booking', 'confirm', 'v1', 'b1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Booking already confirmed');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('booking cancel', () => {
    it('should cancel a booking', async () => {
      sdkMock.booking.updateBookingStatus.mockResolvedValue({
        id: 'b1',
        slotId: 'slot-1',
        vaultId: 'v1',
        status: 'cancelled',
        startAt: '2026-03-15T10:00:00Z',
        endAt: '2026-03-15T10:30:00Z',
        guestName: 'Jane Doe',
        guestEmail: 'jane@example.com',
        cancelledAt: '2026-03-10T12:00:00Z',
        paymentStatus: 'unpaid',
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-10T12:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'booking', 'cancel', 'v1', 'b1']);

      expect(sdkMock.booking.updateBookingStatus).toHaveBeenCalledWith('v1', 'b1', 'cancelled');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Booking b1 cancelled');
    });

    it('should handle cancellation errors gracefully', async () => {
      sdkMock.booking.updateBookingStatus.mockRejectedValue(new Error('Booking not found'));

      await program.parseAsync(['node', 'cli', 'booking', 'cancel', 'v1', 'b1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Booking not found');
      expect(process.exitCode).toBe(1);
    });
  });
});
