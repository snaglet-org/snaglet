/**
 * The grids' look and layout: one chip
 * style for events and rows (tint + left bar; the table and repeat in the
 * hover title, a small ↻ only on a full-size block), point rows packed beside
 * blocks with only the dot and title pressable, the all-day band capped at
 * three lanes with a "+N more" per day, a repeating event's popover on the
 * clicked occurrence, items dimmed while the range shown isn't the one asked
 * for, and the enclosing month prefetched from Week.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import type {
  Calendar,
  CalendarEvent,
  CalendarOccurrence,
  CalendarOccurrencesResponse,
  CalendarRowOccurrence,
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
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({ usePaneIsActive: () => true }));
// The real editor mounts TipTap; the description field needs only a text box here.
vi.mock('@desktop/features/rich-markdown/editor', async () => ({
  ChipEditableInput: (
    await import('@desktop/features/rich-markdown/editor/chipEditableInput.testMock')
  ).MockChipEditableInput,
}));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

function cal(): Calendar {
  return {
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
    boundFields: [
      {
        tableId: 'table-1',
        tableName: 'Test table',
        projectId: null,
        fieldId: 'field-due',
        fieldName: 'Due',
        fieldType: 'datetime',
        repeats: true,
        unscheduledCount: 0,
      },
    ],
  };
}

function response(occurrences: CalendarOccurrence[]): CalendarOccurrencesResponse {
  return { from: '', to: '', tz: ZONE, occurrences, intervals: [], unavailable: [] };
}

function event(
  key: string,
  title: string,
  time: CalendarOccurrence['time'],
  extra: Partial<CalendarOccurrence> = {}
): CalendarOccurrence {
  return {
    source: 'event',
    key: `event:${key}`,
    eventId: key,
    revision: 1,
    calendarId: 'cal-default',
    title,
    time,
    status: 'upcoming',
    canMove: true,
    canResize: true,
    ...extra,
  } as CalendarOccurrence;
}

function row(
  key: string,
  title: string,
  time: CalendarOccurrence['time'],
  extra: Partial<CalendarRowOccurrence> = {}
): CalendarRowOccurrence {
  return {
    source: 'row',
    key: `row:field-due:${key}:value`,
    calendarId: 'cal-default',
    title,
    time,
    status: 'upcoming',
    canMove: true,
    canResize: false,
    tableId: 'table-1',
    tableName: 'Test table',
    projectId: null,
    entryId: key,
    fieldId: 'field-due',
    range: false,
    hasEnd: true,
    entryRevision: 'rev-1',
    schemaVersion: 'schema-1',
    ...extra,
  };
}

const allDay = (key: string, title: string, from: number, to = from) =>
  event(key, title, {
    kind: 'all_day',
    startDate: `2026-10-${String(from).padStart(2, '0')}`,
    endDate: `2026-10-${String(to + 1).padStart(2, '0')}`,
  });

function seed(view: Parameters<typeof __resetCalendarViewForTests>[0] = {}) {
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({
    anchor: '2026-10-14',
    zoom: 'week',
    ...view,
  });
}

const item = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  __setCalendarWeekStartForTests(1);
  window.localStorage.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
  api.listCalendars.mockResolvedValue({ calendars: [cal()] });
  api.occurrences.mockResolvedValue(response([]));
});
afterEach(() => __setCalendarWeekStartForTests(null));

describe('one chip style', () => {
  it('events and rows share the tint + bar look; the table and repeat move to the hover title', async () => {
    api.occurrences.mockResolvedValue(
      response([
        event('e', 'Standup', { kind: 'timed', start: at(13, 9), end: at(13, 10) }, {
          repeatSummary: 'Every day',
        } as Partial<CalendarOccurrence>),
        row(
          'r',
          'Write report',
          { kind: 'timed', start: at(14, 9), end: at(14, 10) },
          {
            repeat: { occurrence: '2026-10-14', isCurrent: true, summary: 'Every week' },
          }
        ),
        row(
          's',
          'Pay rent',
          { kind: 'timed', start: at(15, 9), end: at(15, 9, 20) },
          {
            repeat: { occurrence: '2026-10-15', isCurrent: true, summary: 'Every month' },
          }
        ),
      ])
    );
    seed();
    render(<CalendarView />);
    const standup = await screen.findByRole('button', { name: /^Standup/ });
    const report = item(/^Write report/);
    expect(standup.className).toMatch(/tinted/);
    expect(report.className).toMatch(/tinted/);
    expect(report.className).not.toMatch(/\brow\b/);
    // No table glyph on the item: the hover title says where the row comes from.
    expect(report.textContent).not.toContain('▦');
    expect(report.getAttribute('title')).toContain('▦ Test table · Due');
    expect(report.getAttribute('title')).toContain('↻ Every week');
    expect(standup.getAttribute('title')).toContain('↻ Every day');
    expect(standup.getAttribute('aria-label')).toContain('repeats every day');
    // A full-size block keeps a small ↻; a compact one (20 minutes) has none.
    expect(report.querySelector('[data-repeat-glyph]')).not.toBeNull();
    expect(standup.querySelector('[data-repeat-glyph]')).not.toBeNull();
    expect(item(/^Pay rent/).querySelector('[data-repeat-glyph]')).toBeNull();
  });

  it('Month chips are tinted too, timed events and rows alike, with no glyphs', async () => {
    api.occurrences.mockResolvedValue(
      response([
        event('e', 'Standup', { kind: 'timed', start: at(13, 9), end: at(13, 10) }),
        row(
          'r',
          'Write report',
          { kind: 'timed', start: at(14, 9), end: at(14, 10) },
          {
            repeat: { occurrence: '2026-10-14', isCurrent: true, summary: 'Every week' },
          }
        ),
      ])
    );
    seed({ zoom: 'month' });
    render(<CalendarView />);
    const standup = await screen.findByRole('button', { name: /^Standup/ });
    const report = item(/^Write report/);
    for (const chip of [standup, report]) {
      expect(chip.className).toMatch(/tinted/);
      expect(chip.querySelector('[data-repeat-glyph]')).toBeNull();
      expect(chip.textContent).not.toMatch(/[▦↻]/);
    }
  });
});

describe('point rows (a time, no end)', () => {
  it('pack beside a block at their time; the hairline is apart from the pressable mark', async () => {
    api.occurrences.mockResolvedValue(
      response([
        event('walk', 'Daily walk', { kind: 'timed', start: at(14, 9), end: at(14, 9, 30) }),
        row(
          'p',
          'Test point',
          { kind: 'timed', start: at(14, 9), end: at(14, 9) },
          {
            hasEnd: false,
          }
        ),
      ])
    );
    seed();
    render(<CalendarView />);
    const walk = await screen.findByRole('button', { name: /^Daily walk/ });
    const mark = item(/^Test point/);
    expect(mark).toHaveAttribute('data-point');
    // Side by side: each takes half the column (the mark, centered on 9:00, first).
    expect(mark.style.left).toBe('calc(0% + 1px)');
    expect(mark.style.maxWidth).toBe('calc(50% - 3px)');
    expect(walk.style.left).toBe('calc(50% + 1px)');
    expect(walk.style.width).toBe('calc(50% - 3px)');
    // The mark is just the dot and the title; the line is a separate, hidden element.
    expect(mark.textContent).toBe('Test point');
    const line = mark.previousElementSibling as HTMLElement;
    expect(line.className).toMatch(/pointLine/);
    expect(line).toHaveAttribute('aria-hidden');
    expect(line.tagName).toBe('SPAN');
  });

  it('take the whole column when nothing is at their time', async () => {
    api.occurrences.mockResolvedValue(
      response([
        row(
          'p',
          'Test point',
          { kind: 'timed', start: at(14, 15), end: at(14, 15) },
          {
            hasEnd: false,
          }
        ),
      ])
    );
    seed();
    render(<CalendarView />);
    const mark = await screen.findByRole('button', { name: /^Test point/ });
    expect(mark.style.maxWidth).toBe('calc(100% - 3px)');
  });
});

describe('the all-day band', () => {
  it('shows at most three lanes: two, then a "+N more" for each day with more', async () => {
    api.occurrences.mockResolvedValue(
      response([
        allDay('a', 'Trip', 12, 14),
        allDay('b', 'Course', 13, 15),
        allDay('c', 'Review', 14),
        allDay('d', 'Party', 14),
        allDay('e', 'Lunch', 16),
      ])
    );
    seed();
    render(<CalendarView />);
    await screen.findByRole('button', { name: /^Trip/ });
    // No week-wide toggle in the gutter.
    const band = document.querySelector<HTMLElement>('[data-cal-drop="allday"]')!.parentElement!;
    expect(band.style.gridTemplateRows).toBe('repeat(3, var(--cal-chip-h))');
    expect(screen.queryByRole('button', { name: /^\+\d+$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Less' })).toBeNull();
    // Wednesday has four: Trip and Course show, Review and Party are behind "+2 more".
    const more = screen.getByRole('button', { name: '2 more all-day on Wednesday, October 14' });
    expect(more).toHaveTextContent('+2 more');
    expect(screen.queryByRole('button', { name: /more all-day on Monday/ })).toBeNull();
    fireEvent.click(more);
    const list = await screen.findByRole('dialog', { name: 'Wednesday, October 14, 4 all-day' });
    for (const title of ['Trip', 'Course', 'Review', 'Party'])
      expect(within(list).getByRole('button', { name: new RegExp(`^${title}`) })).toBeTruthy();
    expect(more).toHaveAttribute('aria-expanded', 'true');
  });

  it('with three lanes or fewer shows every item and no "+N"', async () => {
    api.occurrences.mockResolvedValue(
      response([allDay('a', 'Trip', 14), allDay('b', 'Course', 14), allDay('c', 'Review', 14)])
    );
    seed();
    render(<CalendarView />);
    expect(await screen.findByRole('button', { name: /^Review/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more all-day/ })).toBeNull();
  });
});

describe('a repeating event’s popover', () => {
  it('shows the clicked occurrence’s day, not the series start; editing names the series', async () => {
    const series: CalendarEvent = {
      id: 'walk',
      calendarId: 'cal-default',
      title: 'Daily walk',
      description: '',
      location: '',
      time: { kind: 'timed', startAt: at(1, 9), endAt: at(1, 9, 30), timeZone: ZONE },
      repeat: { rrule: 'FREQ=DAILY' },
      revision: 1,
      createdAt: '',
      updatedAt: '',
    };
    api.getEvent.mockResolvedValue({ event: series });
    api.occurrences.mockResolvedValue(
      response([
        event('walk', 'Daily walk', { kind: 'timed', start: at(14, 9), end: at(14, 9, 30) }, {
          key: 'event:walk:2026-10-14',
          repeatSummary: 'Every day',
        } as Partial<CalendarOccurrence>),
      ])
    );
    seed();
    render(<CalendarView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Daily walk/ }));
    const popover = await screen.findByRole('dialog', { name: 'Event' });
    const time = await within(popover).findByRole('button', { name: /^Time: / });
    expect(time).toHaveTextContent('Wed Oct 14, 9:00 – 9:30 AM');
    expect(time).not.toHaveTextContent('Oct 1,');
    fireEvent.click(time);
    expect(within(popover).getByText('Series start')).toBeInTheDocument();
    expect(within(popover).getByLabelText('Start time')).toBeInTheDocument();
  });
});

describe('loading another range', () => {
  it('dims the items shown until the asked-for range arrives', async () => {
    let resolveMonth: (r: CalendarOccurrencesResponse) => void = () => {};
    api.occurrences.mockImplementation((q: { from: string }) =>
      q.from === '2026-09-28'
        ? new Promise<CalendarOccurrencesResponse>((resolve) => {
            resolveMonth = resolve;
          })
        : Promise.resolve(
            response([event('s', 'Standup', { kind: 'timed', start: at(13, 9), end: at(13, 10) })])
          )
    );
    seed();
    render(<CalendarView />);
    await screen.findByRole('button', { name: /^Standup/ });
    const scroller = () => document.querySelector<HTMLElement>('[data-calendar-scroll]')!;
    expect(scroller()).not.toHaveAttribute('data-stale');
    fireEvent.click(screen.getByRole('radio', { name: 'Month' }));
    // Last week's items, drawn dimmed while the month loads.
    expect(scroller()).toHaveAttribute('data-stale');
    expect(scroller()).toHaveAttribute('aria-busy', 'true');
    await act(async () =>
      resolveMonth(
        response([event('s', 'Standup', { kind: 'timed', start: at(13, 9), end: at(13, 10) })])
      )
    );
    await waitFor(() => expect(scroller()).not.toHaveAttribute('data-stale'));
  });

  it('Week prefetches its month, so switching to Month draws at once', async () => {
    seed();
    render(<CalendarView />);
    await waitFor(() =>
      expect(api.occurrences).toHaveBeenCalledWith(
        expect.objectContaining({ from: '2026-09-28', to: '2026-11-02' })
      )
    );
  });
});
