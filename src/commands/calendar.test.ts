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

vi.mock('../utils/resolve-vault.js', () => ({
  resolveVaultId: vi.fn(async (id: string) => id),
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

  describe('calendar templates list', () => {
    it('should list event templates', async () => {
      sdkMock.calendar.listTemplates.mockResolvedValue([
        {
          id: 'tmpl-1',
          vaultId: 'vault-1',
          userId: 'user-1',
          name: 'Team Standup',
          description: 'Daily standup meeting',
          duration: 15,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'tmpl-2',
          vaultId: 'vault-1',
          userId: 'user-1',
          name: 'Sprint Review',
          duration: 60,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]);

      await program.parseAsync(['node', 'cli', 'calendar', 'templates', 'list', 'vault-1']);

      expect(sdkMock.calendar.listTemplates).toHaveBeenCalledWith('vault-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Team Standup');
      expect(stdout).toContain('Sprint Review');
    });

    it('should show empty message when no templates', async () => {
      sdkMock.calendar.listTemplates.mockResolvedValue([]);

      await program.parseAsync(['node', 'cli', 'calendar', 'templates', 'list', 'vault-1']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('No event templates');
    });
  });

  describe('calendar templates create', () => {
    it('should create an event template', async () => {
      sdkMock.calendar.createTemplate.mockResolvedValue({
        id: 'tmpl-new',
        vaultId: 'vault-1',
        userId: 'user-1',
        name: 'Weekly 1:1',
        duration: 30,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'templates', 'create', 'vault-1',
        '--name', 'Weekly 1:1', '--duration', '30',
      ]);

      expect(sdkMock.calendar.createTemplate).toHaveBeenCalledWith('vault-1', {
        name: 'Weekly 1:1',
        duration: 30,
        description: undefined,
        location: undefined,
        color: undefined,
      });
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('tmpl-new');
    });

    it('should create a template with optional fields', async () => {
      sdkMock.calendar.createTemplate.mockResolvedValue({
        id: 'tmpl-full',
        vaultId: 'vault-1',
        userId: 'user-1',
        name: 'Planning',
        description: 'Sprint planning session',
        duration: 120,
        location: 'Conference Room A',
        color: 'blue',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'templates', 'create', 'vault-1',
        '--name', 'Planning', '--duration', '120',
        '--description', 'Sprint planning session',
        '--location', 'Conference Room A',
        '--color', 'blue',
      ]);

      expect(sdkMock.calendar.createTemplate).toHaveBeenCalledWith('vault-1', {
        name: 'Planning',
        duration: 120,
        description: 'Sprint planning session',
        location: 'Conference Room A',
        color: '#0000ff',
      });
    });
  });

  describe('calendar templates get', () => {
    it('should get a single event template', async () => {
      sdkMock.calendar.getTemplate.mockResolvedValue({
        id: 'tmpl-1',
        vaultId: 'vault-1',
        userId: 'user-1',
        name: 'Team Standup',
        description: 'Daily standup',
        duration: 15,
        location: 'Zoom',
        color: 'green',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      await program.parseAsync(['node', 'cli', 'calendar', 'templates', 'get', 'vault-1', 'tmpl-1']);

      expect(sdkMock.calendar.getTemplate).toHaveBeenCalledWith('vault-1', 'tmpl-1');
      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('Team Standup');
      expect(stdout).toContain('15');
    });

    it('should handle get template error', async () => {
      sdkMock.calendar.getTemplate.mockRejectedValue(new Error('Template not found'));

      await program.parseAsync(['node', 'cli', 'calendar', 'templates', 'get', 'vault-1', 'tmpl-missing']);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Template not found');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('calendar templates update', () => {
    it('should update an event template', async () => {
      sdkMock.calendar.updateTemplate.mockResolvedValue({
        id: 'tmpl-1',
        vaultId: 'vault-1',
        userId: 'user-1',
        name: 'Updated Standup',
        duration: 20,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'templates', 'update', 'vault-1', 'tmpl-1',
        '--name', 'Updated Standup', '--duration', '20',
      ]);

      expect(sdkMock.calendar.updateTemplate).toHaveBeenCalledWith('vault-1', 'tmpl-1', {
        name: 'Updated Standup',
        duration: 20,
      });
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Updated Standup');
    });

    it('should update only the description', async () => {
      sdkMock.calendar.updateTemplate.mockResolvedValue({
        id: 'tmpl-1',
        vaultId: 'vault-1',
        userId: 'user-1',
        name: 'Standup',
        description: 'New description',
        duration: 15,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'templates', 'update', 'vault-1', 'tmpl-1',
        '--description', 'New description',
      ]);

      expect(sdkMock.calendar.updateTemplate).toHaveBeenCalledWith('vault-1', 'tmpl-1', {
        description: 'New description',
      });
    });
  });

  describe('calendar templates delete', () => {
    it('should require --yes flag before deleting', async () => {
      await program.parseAsync(['node', 'cli', 'calendar', 'templates', 'delete', 'vault-1', 'tmpl-1']);

      expect(sdkMock.calendar.deleteTemplate).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('--yes');
    });

    it('should delete a template when --confirm is provided', async () => {
      sdkMock.calendar.deleteTemplate.mockResolvedValue(undefined);

      await program.parseAsync([
        'node', 'cli', 'calendar', 'templates', 'delete', 'vault-1', 'tmpl-1', '--confirm',
      ]);

      expect(sdkMock.calendar.deleteTemplate).toHaveBeenCalledWith('vault-1', 'tmpl-1');
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('tmpl-1');
    });

    it('should handle delete template error', async () => {
      sdkMock.calendar.deleteTemplate.mockRejectedValue(new Error('Delete failed'));

      await program.parseAsync([
        'node', 'cli', 'calendar', 'templates', 'delete', 'vault-1', 'tmpl-1', '--confirm',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('Delete failed');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('calendar connector connect', () => {
    it('should connect Google Calendar and print authUrl', async () => {
      sdkMock.calendar.connectGoogleCalendar.mockResolvedValue({
        authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
      });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'connector', 'connect', 'vault-1', '--provider', 'google',
      ]);

      expect(sdkMock.calendar.connectGoogleCalendar).toHaveBeenCalledWith('vault-1');
      expect(sdkMock.calendar.connectOutlookCalendar).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('https://accounts.google.com/o/oauth2/auth?client_id=test');
    });

    it('should connect Outlook Calendar and print authUrl', async () => {
      sdkMock.calendar.connectOutlookCalendar.mockResolvedValue({
        authUrl: 'https://login.microsoftonline.com/oauth2/v2.0/authorize?client_id=test',
      });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'connector', 'connect', 'vault-1', '--provider', 'outlook',
      ]);

      expect(sdkMock.calendar.connectOutlookCalendar).toHaveBeenCalledWith('vault-1');
      expect(sdkMock.calendar.connectGoogleCalendar).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('https://login.microsoftonline.com/oauth2/v2.0/authorize?client_id=test');
    });

    it('should reject unknown provider', async () => {
      await program.parseAsync([
        'node', 'cli', 'calendar', 'connector', 'connect', 'vault-1', '--provider', 'yahoo',
      ]);

      expect(sdkMock.calendar.connectGoogleCalendar).not.toHaveBeenCalled();
      expect(sdkMock.calendar.connectOutlookCalendar).not.toHaveBeenCalled();
      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('google');
      expect(process.exitCode).toBe(1);
    });

    it('should output authUrl as JSON record when --output json is set', async () => {
      sdkMock.calendar.connectGoogleCalendar.mockResolvedValue({
        authUrl: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
      });

      await program.parseAsync([
        'node', 'cli', 'calendar', 'connector', 'connect', 'vault-1',
        '--provider', 'google', '--output', 'json',
      ]);

      const stdout = outputSpy.stdout.join('');
      expect(stdout).toContain('authUrl');
      expect(stdout).toContain('https://accounts.google.com/o/oauth2/auth?client_id=test');
    });

    it('should handle connect calendar error', async () => {
      sdkMock.calendar.connectGoogleCalendar.mockRejectedValue(new Error('OAuth init failed'));

      await program.parseAsync([
        'node', 'cli', 'calendar', 'connector', 'connect', 'vault-1', '--provider', 'google',
      ]);

      const stderr = outputSpy.stderr.join('');
      expect(stderr).toContain('OAuth init failed');
      expect(process.exitCode).toBe(1);
    });
  });
});
