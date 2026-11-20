/**
 * Every automations in Week / Day (dots at each run, or a line behind the
 * blocks when zoomed out too far for dots) and in Month (a dot by the date).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import { zonedToInstant } from '@desktop/features/calendar/calendarDates';
import type {
  AutomationRecord,
  Calendar,
  CalendarAutomationOccurrence,
  CalendarIntervalSpan,
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
const automations = vi.hoisted(() => ({ get: vi.fn(), pause: vi.fn(), resume: vi.fn() }));
vi.mock('@desktop/utils/api/automations', () => ({ automationsApi: automations }));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn(), dismissToast: vi.fn() }));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const INBOX_ID = 'automation-1111111111111-aaaaaaaaa';
const BUILD_ID = 'automation-2222222222222-bbbbbbbbb';
const POLL_ID = 'automation-4444444444444-ddddddddd';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
// The week of Mon Oct 12 – Sun Oct 18, 2026 (weeks start on Monday here).
const WEEK = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];

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

/** One day of an Every automation's line, as the server sends it. */
function span(
  id: string,
  name: string,
  day: string,
  startsAt: string,
  extra: Partial<CalendarIntervalSpan> = {}
): CalendarIntervalSpan {
  return {
    key: `automation:${id}:span:${day}`,
    source: 'automation',
    kind: 'interval',
    automationId: id,
    calendarId: 'cal-default',
    name,
    day,
    everyMs: 15 * 60_000,
    startsAt,
    nextRunAt: zonedToInstant(day, 10 * 60, ZONE),
    agentId: 'test-agent-a',
    agentName: 'Test Agent A',
    threadId: THREAD_ID,
    ...extra,
  };
}

// "Check inbox" (every 15 minutes: 12 px apart at the default zoom, room for
// dots) starts Wed 9:00 AM; "Watch the build" (every 2 hours) started Tue
// 8:00 AM. Monday has neither. "Poll the queue" (every 5 minutes: 4 px
// apart, a line) runs Thu–Fri from Thu 9:00 AM.
const INBOX_START = zonedToInstant('2026-10-14', 9 * 60, ZONE);
const BUILD_START = zonedToInstant('2026-10-13', 8 * 60, ZONE);
const POLL_START = zonedToInstant('2026-10-15', 9 * 60, ZONE);
const intervals = (): CalendarIntervalSpan[] => [
  ...WEEK.slice(1).map((day) =>
    span(BUILD_ID, 'Watch the build', day, BUILD_START, { everyMs: 2 * 3_600_000 })
  ),
  ...WEEK.slice(2).map((day) => span(INBOX_ID, 'Check inbox', day, INBOX_START)),
  ...WEEK.slice(3).map((day) =>
    span(POLL_ID, 'Poll the queue', day, POLL_START, { everyMs: 5 * 60_000 })
  ),
];

/** A once wake on `day` at 2 PM, to see how blocks share the column with the lines. */
function wake(day: string): CalendarAutomationOccurrence {
  const start = zonedToInstant(day, 14 * 60, ZONE);
  return {
    key: `automation:automation-3333333333333-ccccccccc:${start}`,
    source: 'automation',
    calendarId: 'cal-default',
    title: `Wake ${day}`,
    time: { kind: 'timed', start, end: zonedToInstant(day, 14 * 60 + 15, ZONE) },
    status: 'upcoming',
    canMove: false,
    canResize: false,
    automationId: 'automation-3333333333333-ccccccccc',
    agentId: 'test-agent-a',
    agentName: 'Test Agent A',
    threadId: THREAD_ID,
    automationStatus: 'active',
  };
}

const inboxRecord = {
  id: INBOX_ID,
  name: 'Check inbox',
  prompt: 'Check the inbox.',
  status: 'active',
  when: { kind: 'interval', everyMs: 15 * 60_000, tz: ZONE },
  whenText: 'every 15 minutes',
  calendarId: 'cal-default',
  threadId: THREAD_ID,
  agentId: 'test-agent-a',
  scheduleId: 'schedule-1111',
  createdByAgentId: null,
  createdByMemberId: null,
  consecutiveFailures: 0,
  pausedReason: null,
  createdAt: '',
  updatedAt: '',
  nextRunAt: zonedToInstant('2026-10-14', 10 * 60, ZONE),
  lastRun: null,
  agentName: 'Test Agent A',
  threadTitle: 'Test thread',
  calendarTitle: 'Default calendar',
  running: false,
  runningSince: null,
  unattendedPolicy: 'skip',
} satisfies AutomationRecord;

const line = (container: HTMLElement, id: string, day: string) =>
  container.querySelector<HTMLElement>(
    `[data-interval]:not([data-interval-run])[data-key="automation:${id}:span:${day}"]`
  );
const dots = (container: HTMLElement, id: string, day: string) =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-interval-run][data-key="automation:${id}:span:${day}"]`
    )
  );
const dotAt = (container: HTMLElement, id: string, day: string, minutes: number) =>
  dots(container, id, day).find((d) => d.dataset.run === zonedToInstant(day, minutes, ZONE));

// The grid's scroller shows `viewportPx` of times (the headers are 0 px in jsdom).
let viewportPx = 0;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-calendar-scroll') ? viewportPx : 0;
    },
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

function setup(zoom: 'week' | 'day' | 'month', list = intervals()) {
  api.listCalendars.mockResolvedValue({ calendars: [calendar] });
  api.occurrences.mockResolvedValue({
    from: '',
    to: '',
    occurrences: [wake('2026-10-12'), wake('2026-10-14'), wake('2026-10-15')],
    intervals: list,
    unavailable: [],
  });
  __resetCalendarStoreForTests({ calendars: [calendar] });
  __resetCalendarViewForTests({ anchor: '2026-10-14', zoom });
  return render(<CalendarView />);
}

const block = (container: HTMLElement, day: string) =>
  Array.from(container.querySelectorAll<HTMLElement>('[data-calendar-item]')).find((el) =>
    el.getAttribute('aria-label')?.startsWith(`Wake ${day}`)
  )!;

describe('CalendarView Every automations', () => {
  beforeEach(() => {
    // Not this week: no now line moving the opening scroll.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    window.localStorage.clear();
    // The whole day fits at the default 48 px an hour.
    viewportPx = 24 * 48;
    Object.values(api).forEach((fn) => fn.mockReset());
    automations.get.mockReset().mockResolvedValue({ automation: inboxRecord });
    automations.pause.mockReset();
    automations.resume.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('draws a dot at each run in Week, from the start time on its first day', async () => {
    const { container } = setup('week');
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-14')).not.toHaveLength(0));
    expect(dots(container, INBOX_ID, '2026-10-13')).toHaveLength(0); // not started yet
    // Wed: 9:00 AM to 11:45 PM every 15 minutes; Thu: the whole day.
    expect(dots(container, INBOX_ID, '2026-10-14')).toHaveLength(60);
    expect(dots(container, INBOX_ID, '2026-10-15')).toHaveLength(96);
    // Every 2 hours from Tue 8 AM: 8 AM … 10 PM, then every even hour.
    expect(dots(container, BUILD_ID, '2026-10-13')).toHaveLength(8);
    expect(dots(container, BUILD_ID, '2026-10-14')).toHaveLength(12);

    const first = dotAt(container, INBOX_ID, '2026-10-14', 9 * 60)!;
    // Centered on 9 AM at 48 px an hour.
    expect(first.style.top).toBe(`${9 * 48 - 6}px`);
    expect(first.style.height).toBe('12px');
    expect(first).toHaveAttribute('data-cal-color', 'blue');
    expect(first.querySelector('[class*="intervalDot"]')).not.toBeNull();
    expect(first).toHaveAccessibleName('Every 15 minutes automation: Check inbox, 9 AM');
    expect(first).toHaveAttribute('title', 'Every 15 minutes · Check inbox\n9 AM');
    expect(dotAt(container, BUILD_ID, '2026-10-13', 10 * 60)).toHaveAccessibleName(
      'Every 2 hours automation: Watch the build, 10 AM'
    );
    // No line for them at this zoom.
    expect(line(container, INBOX_ID, '2026-10-14')).toBeNull();
  });

  it('sets the dots side by side in a lane at the left, and narrows that day’s blocks', async () => {
    const { container } = setup('week');
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-14')).not.toHaveLength(0));
    // Oldest start first: the build's dots, then the inbox's.
    expect(dotAt(container, BUILD_ID, '2026-10-14', 10 * 60)!.style.left).toBe('2px');
    expect(dotAt(container, INBOX_ID, '2026-10-14', 10 * 60)!.style.left).toBe('10px');
    expect(dotAt(container, INBOX_ID, '2026-10-14', 10 * 60)!.style.width).toBe('8px');
    // Two dotted automations (18 px of lane) on Wednesday: its block starts
    // after them and shares what is left; Monday has none.
    expect(block(container, '2026-10-14').style.left).toMatch(
      /^calc\(19px \+ .*\(100% - 18px\)\)$/
    );
    expect(block(container, '2026-10-14').style.width).toMatch(/\(100% - 18px\)/);
    expect(block(container, '2026-10-12').style.left).not.toMatch(/18px/);
    expect(block(container, '2026-10-12').style.width).not.toMatch(/18px/);
  });

  it('draws runs too close for dots as a thin line behind the blocks, which keep their width', async () => {
    const { container } = setup('week');
    await waitFor(() => expect(line(container, POLL_ID, '2026-10-15')).not.toBeNull());
    expect(dots(container, POLL_ID, '2026-10-15')).toHaveLength(0);
    const first = line(container, POLL_ID, '2026-10-15')!;
    // 9 AM at 48 px an hour; it runs to the end of the day.
    expect(first.style.top).toBe(`${9 * 48}px`);
    expect(first.style.height).toBe(`${15 * 48}px`);
    expect(first).toHaveAttribute('data-starts');
    expect(first).toHaveAccessibleName('Every 5 minutes automation: Poll the queue');
    const later = line(container, POLL_ID, '2026-10-16')!;
    expect(later.style.top).toBe('0px');
    expect(later.style.height).toBe(`${24 * 48}px`);
    expect(later).not.toHaveAttribute('data-starts');
  });

  it('keeps the blocks full width on a day with only lines', async () => {
    const pollOnly = intervals().filter((s) => s.automationId === POLL_ID);
    const { container } = setup('week', pollOnly);
    await waitFor(() => expect(line(container, POLL_ID, '2026-10-15')).not.toBeNull());
    expect(block(container, '2026-10-15').style.left).toBe('calc(0% + 1px)');
    expect(block(container, '2026-10-15').style.width).toBe('calc(100% - 3px)');
  });

  it('turns dots into a line when zoomed out, and back when zoomed in', async () => {
    viewportPx = 480; // fit is 1/3 px a minute: room to zoom out
    const { container } = setup('week');
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-14')).not.toHaveLength(0));
    const scroller = container.querySelector<HTMLElement>('[data-calendar-scroll]')!;
    // Zoom out (Ctrl+wheel down): 15 minutes is then under 12 px.
    fireEvent.wheel(scroller, { deltaY: 25, ctrlKey: true, clientY: 300 });
    await waitFor(() => expect(line(container, INBOX_ID, '2026-10-14')).not.toBeNull());
    expect(dots(container, INBOX_ID, '2026-10-14')).toHaveLength(0);
    // Every 2 hours still has room.
    expect(dots(container, BUILD_ID, '2026-10-14')).not.toHaveLength(0);
    // Wednesday still narrows: the build's dots keep the lane.
    expect(block(container, '2026-10-14').style.width).toMatch(/\(100% - 18px\)/);
    fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
    fireEvent.wheel(scroller, { deltaY: -25, ctrlKey: true, clientY: 300 });
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-14')).not.toHaveLength(0));
    expect(line(container, INBOX_ID, '2026-10-14')).toBeNull();
  });

  it('only draws the runs around the visible range', async () => {
    // Zoomed in to 4 px a minute with 480 px of times: two hours show.
    window.localStorage.setItem('snaglet.calendar.timeZoom', '4');
    viewportPx = 480;
    const { container } = setup('week');
    // The opening scroll puts 1 PM (an hour before the 2 PM wakes) at the top.
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-14')).not.toHaveLength(0));
    const scroller = container.querySelector<HTMLElement>('[data-calendar-scroll]')!;
    expect(scroller.scrollTop).toBe(13 * 60 * 4);
    // 1–3 PM plus an hour either side, never the whole day.
    const times = () => dots(container, INBOX_ID, '2026-10-14').map((d) => d.dataset.run);
    expect(times()).toHaveLength(16);
    expect(times()[0]).toBe(zonedToInstant('2026-10-14', 12 * 60, ZONE));
    expect(times()[times().length - 1]).toBe(zonedToInstant('2026-10-14', 15 * 60 + 45, ZONE));
    expect(dotAt(container, INBOX_ID, '2026-10-14', 13 * 60)!.style.top).toBe(
      `${13 * 60 * 4 - 6}px`
    );

    // Scroll to 6 PM: the dots follow.
    scroller.scrollTop = 18 * 60 * 4;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(times()[0]).toBe(zonedToInstant('2026-10-14', 17 * 60, ZONE)));
    expect(times()).toHaveLength(16);
  });

  it('opens the automation popover from a dot, with that run’s time', async () => {
    const { container } = setup('week');
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-15')).not.toHaveLength(0));
    fireEvent.click(dotAt(container, INBOX_ID, '2026-10-15', 10 * 60 + 30)!);
    const dialog = await screen.findByRole('dialog', { name: 'Check inbox automation' });
    expect(automations.get).toHaveBeenCalledWith(INBOX_ID);
    expect(within(dialog).getByText(/^This run: .*10:30/)).toBeInTheDocument();
    expect(await within(dialog).findByText('every 15 minutes')).toBeInTheDocument();
    expect(within(dialog).getByText(/Wakes Test Agent A/)).toBeInTheDocument();
    expect(within(dialog).getByText('Next run')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    // No quick add opened under it.
    expect(container.querySelector('[data-calendar-ghost]')).toBeNull();
  });

  it('puts one dot per automation and day in the tab order; ↑ / ↓ move, Enter opens, Escape returns', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const { container } = setup('day');
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-14')).not.toHaveLength(0));
    const inbox = dots(container, INBOX_ID, '2026-10-14');
    expect(inbox.filter((d) => d.tabIndex === 0)).toHaveLength(1);
    const stop = inbox.find((d) => d.tabIndex === 0)!;
    stop.focus();
    await user.keyboard('{ArrowDown}');
    const next = inbox[inbox.indexOf(stop) + 1]!;
    expect(document.activeElement).toBe(next);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(stop);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Check inbox automation' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Check inbox automation' })).toBeNull()
    );
    expect(document.activeElement).toBe(next);
  });

  it('opens a tall line’s popover at the pressed slot, and Escape gives focus back to the line', async () => {
    const { container } = setup('week');
    await waitFor(() => expect(line(container, POLL_ID, '2026-10-16')).not.toBeNull());
    const target = line(container, POLL_ID, '2026-10-16')!;
    // The line runs the whole day: a press halfway down is at 12:00 PM.
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 8, 1000));
    const noon = target.parentElement!.querySelectorAll<HTMLElement>(
      ':scope > [role="gridcell"]'
    )[24]!;
    expect(noon).toHaveAccessibleName(/, 12 PM$/);
    const noonRect = vi.spyOn(noon, 'getBoundingClientRect');
    target.focus();
    automations.get.mockResolvedValue({ automation: { ...inboxRecord, name: 'Poll the queue' } });
    fireEvent.click(target, { clientY: 500, detail: 1 });
    await screen.findByRole('dialog', { name: 'Poll the queue automation' });
    expect(noonRect).toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Poll the queue automation' })).toBeNull()
    );
    expect(document.activeElement).toBe(target);
  });

  it('a line is focusable, and Enter opens the popover', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const { container } = setup('day');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Next day' }));
    });
    await waitFor(() => expect(line(container, POLL_ID, '2026-10-15')).not.toBeNull());
    const target = line(container, POLL_ID, '2026-10-15')!;
    target.focus();
    expect(document.activeElement).toBe(target);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Poll the queue automation' })).toBeTruthy();
  });

  it('shows a dot per active day in Month, side by side', async () => {
    const { container } = setup('month', intervals());
    const cell = () => container.querySelector<HTMLElement>('[data-cal-day="2026-10-14"]')!;
    await waitFor(() => expect(cell().querySelector('[data-interval-dots]')).not.toBeNull());
    const monthDots = within(cell()).getAllByRole('button', { name: /automation:/ });
    expect(monthDots.map((d) => d.getAttribute('aria-label'))).toEqual([
      'Every 2 hours automation: Watch the build',
      'Every 15 minutes automation: Check inbox',
    ]);
    // Monday the 12th has none.
    expect(container.querySelector('[data-cal-day="2026-10-12"] [data-interval-dots]')).toBeNull();

    fireEvent.click(monthDots[1]!);
    expect(await screen.findByRole('dialog', { name: 'Check inbox automation' })).toBeTruthy();
    expect(container.querySelector('[data-calendar-ghost]')).toBeNull();
  });

  it('follows the search box', async () => {
    const { container } = setup('week');
    await waitFor(() => expect(dots(container, INBOX_ID, '2026-10-14')).not.toHaveLength(0));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this range' }), {
      target: { value: 'build' },
    });
    expect(dots(container, INBOX_ID, '2026-10-14')).toHaveLength(0);
    expect(dots(container, BUILD_ID, '2026-10-14')).not.toHaveLength(0);
    expect(line(container, POLL_ID, '2026-10-15')).toBeNull();
  });
});
