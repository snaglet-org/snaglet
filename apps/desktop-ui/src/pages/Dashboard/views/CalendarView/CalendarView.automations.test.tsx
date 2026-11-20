import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import type {
  AutomationRecord,
  Calendar,
  CalendarAutomationOccurrence,
} from '@snaglet/shared/types';

const api = vi.hoisted(() => ({
  listCalendars: vi.fn(),
  occurrences: vi.fn(),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}));
vi.mock('@desktop/features/calendar/calendarApi', () => ({
  calendarApi: api,
  occurrencesSearch: (q: { from: string; to: string }) => `from=${q.from}&to=${q.to}`,
}));
const automations = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: automations }));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn(), dismissToast: vi.fn() }));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import {
  DashboardNavigationProvider,
  type DashboardNavigationValue,
} from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const AUTOMATION_ID = 'automation-1111111111111-aaaaaaaaa';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

const calendar: Calendar = {
  id: 'cal-default',
  title: 'Default calendar',
  description: '',
  timeZone: ZONE,
  color: 'blue',
  isDefault: true,
  sortOrder: 0,
  revision: 1,
  createdAt: '',
  updatedAt: '',
  boundFields: [],
};

const wake: CalendarAutomationOccurrence = {
  key: `automation:${AUTOMATION_ID}:2026-10-14T16:00:00.000Z`,
  source: 'automation',
  calendarId: 'cal-default',
  title: 'Check backlog',
  time: { kind: 'timed', start: '2026-10-14T16:00:00.000Z', end: '2026-10-14T16:15:00.000Z' },
  status: 'upcoming',
  canMove: false,
  canResize: false,
  automationId: AUTOMATION_ID,
  agentId: 'test-agent-a',
  agentName: 'Test Agent A',
  threadId: THREAD_ID,
  automationStatus: 'active',
};

const record = {
  id: AUTOMATION_ID,
  name: 'Check backlog',
  prompt: 'Check the backlog.',
  status: 'active',
  when: { kind: 'once', at: '2026-10-14T16:00:00.000Z', tz: ZONE },
  whenText: 'once on Wed, Oct 14, 9:00 AM',
  calendarId: 'cal-default',
  threadId: THREAD_ID,
  agentId: 'test-agent-a',
  scheduleId: 'schedule-1111',
  createdByAgentId: 'test-agent-a',
  createdByMemberId: null,
  consecutiveFailures: 0,
  pausedReason: null,
  createdAt: '',
  updatedAt: '',
  nextRunAt: '2026-10-14T16:00:00.000Z',
  lastRun: null,
  agentName: 'Test Agent A',
  threadTitle: 'Test thread',
  calendarTitle: 'Default calendar',
  running: false,
  runningSince: null,
  unattendedPolicy: 'skip',
} satisfies AutomationRecord;

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('CalendarView automation wakes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.values(api).forEach((fn) => fn.mockReset());
    api.listCalendars.mockResolvedValue({ calendars: [calendar] });
    api.occurrences.mockResolvedValue({ from: '', to: '', occurrences: [wake], unavailable: [] });
    automations.get.mockReset().mockResolvedValue({ automation: record });
    __resetCalendarStoreForTests({ calendars: [calendar] });
    __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'week' });
  });

  it('opens the thread from the popover with its title, so the pane is named', async () => {
    const openInPane = vi.fn();
    const nav: DashboardNavigationValue = {
      openInPane,
      openThreadAgent: vi.fn(),
      requestReveal: vi.fn(),
    };
    const { container } = render(
      <DashboardNavigationProvider value={nav}>
        <CalendarView />
      </DashboardNavigationProvider>
    );
    await waitFor(() => expect(container.querySelector('[data-automation]')).not.toBeNull());
    fireEvent.click(container.querySelector<HTMLElement>('[data-automation]')!);

    fireEvent.click(await screen.findByRole('button', { name: /In Test thread/ }));
    expect(openInPane).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'thread', id: THREAD_ID, title: 'Test thread' })
    );
  });
});
