import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerCalendarCommands } from './calendar.js';
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

describe('calendar commands', () => {
  let program: Command;
  let outputSpy: ReturnType<typeof spyOutput>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerCalendarCommands(program);
    sdkMock = createSDKMock();
    outputSpy = spyOutput();
    process.exitCode = undefined;
  });

  afterEach(() => {
    outputSpy.restore();
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  describe('calendar view', () => {
    it('should display calendar activity', async () => {
      sdkMock.calendar.getActivity.mockResolvedValue({
        days: [
          { date: '2024-01-01', created: 2, updated: 3, deleted: 1, total: 6 },
          { date: '2024-01-02', created: 1, updated: 0, deleted: 0, total: 1 },
        ],
        start: '2024-01-01',
        end: '2024-01-31',
      });

      await program.parseAsync(['node', 'cli', 'calendar', 'view', 'vault-1', '--start', '2024-01-01', '--end', '2024-01-31']);

      expect(sdkMock.calendar.getActivity).toHaveBeenCalledWith('vault-1', {
        start: '2024-01-01',
        end: '2024-01-31',
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('2024-01-01');
      expect(stdout).toContain('2024-01-02');
    });

    it('should show empty message when no activity', async () => {
      sdkMock.calendar.getActivity.mockResolvedValue({
        days: [],
        start: '2024-01-01',
        end: '2024-01-31',
      });

      await program.parseAsync(['node', 'cli', 'calendar', 'view', 'vault-1', '--start', '2024-01-01', '--end', '2024-01-31']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No activity in this period');
    });
  });

  describe('calendar due', () => {
    it('should list due dates', async () => {
      sdkMock.calendar.getDueDates.mockResolvedValue([
        {
          documentId: 'd1',
          path: 'tasks/todo.md',
          title: 'Important Task',
          dueAt: '2024-01-15',
          priority: 'high',
          completed: false,
          overdue: false,
        },
        {
          documentId: 'd2',
          path: 'tasks/overdue.md',
          title: 'Overdue Task',
          dueAt: '2024-01-01',
          completed: false,
          overdue: true,
        },
      ]);

      await program.parseAsync(['node', 'cli', 'calendar', 'due', 'vault-1']);

      expect(sdkMock.calendar.getDueDates).toHaveBeenCalledWith('vault-1', { status: 'all' });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Important Task');
      expect(stdout).toContain('Overdue Task');
    });

    it('should filter by status', async () => {
      sdkMock.calendar.getDueDates.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'calendar', 'due', 'vault-1', '--status', 'overdue']);

      expect(sdkMock.calendar.getDueDates).toHaveBeenCalledWith('vault-1', { status: 'overdue' });
    });

    it('should show empty message when no due dates', async () => {
      sdkMock.calendar.getDueDates.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'calendar', 'due', 'vault-1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No documents with due dates');
    });
  });

  describe('calendar set-due', () => {
    it('should set due date on a document', async () => {
      sdkMock.calendar.setDocumentDue.mockResolvedValue({ success: true });

      await program.parseAsync(['node', 'cli', 'calendar', 'set-due', 'vault-1', 'tasks/todo.md', '--date', '2024-01-15']);

      expect(sdkMock.calendar.setDocumentDue).toHaveBeenCalledWith('vault-1', 'tasks/todo.md', {
        dueAt: expect.stringContaining('2024-01-15'),
        priority: null,
        recurrence: null,
      });
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Due date set to 2024-01-15');
    });

    it('should set due date with priority and recurrence', async () => {
      sdkMock.calendar.setDocumentDue.mockResolvedValue({ success: true });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'set-due', 'vault-1', 'tasks/todo.md',
        '--date', '2024-01-15', '--priority', 'high', '--recurrence', 'weekly',
      ]);

      expect(sdkMock.calendar.setDocumentDue).toHaveBeenCalledWith('vault-1', 'tasks/todo.md', {
        dueAt: expect.stringContaining('2024-01-15'),
        priority: 'high',
        recurrence: 'weekly',
      });
    });

    it('should clear due date when date is "clear"', async () => {
      sdkMock.calendar.setDocumentDue.mockResolvedValue({ success: true });

      await program.parseAsync(['node', 'cli', 'calendar', 'set-due', 'vault-1', 'tasks/todo.md', '--date', 'clear']);

      expect(sdkMock.calendar.setDocumentDue).toHaveBeenCalledWith('vault-1', 'tasks/todo.md', {
        dueAt: null,
        priority: null,
        recurrence: null,
      });
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Due date cleared');
    });
  });

  describe('calendar events', () => {
    it('should list calendar events', async () => {
      sdkMock.calendar.listEvents.mockResolvedValue([
        {
          id: 'e1',
          vaultId: 'v1',
          userId: 'u1',
          title: 'Team Meeting',
          startDate: '2024-01-15T10:00:00Z',
          allDay: false,
          completed: false,
          priority: 'high',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'calendar', 'events', 'vault-1']);

      expect(sdkMock.calendar.listEvents).toHaveBeenCalledWith('vault-1', {
        start: undefined,
        end: undefined,
      });
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Team Meeting');
    });

    it('should filter events by date range', async () => {
      sdkMock.calendar.listEvents.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'calendar', 'events', 'vault-1', '--start', '2024-01-01', '--end', '2024-01-31']);

      expect(sdkMock.calendar.listEvents).toHaveBeenCalledWith('vault-1', {
        start: '2024-01-01',
        end: '2024-01-31',
      });
    });

    it('should show empty message when no events', async () => {
      sdkMock.calendar.listEvents.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'calendar', 'events', 'vault-1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No calendar events');
    });
  });

  describe('error handling', () => {
    it('should handle calendar errors', async () => {
      sdkMock.calendar.getActivity.mockRejectedValue(new Error('Server error'));

      await program.parseAsync(['node', 'cli', 'calendar', 'view', 'vault-1', '--start', '2024-01-01', '--end', '2024-01-31']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Server error');
      expect(process.exitCode).toBe(1);
    });
  });
});
