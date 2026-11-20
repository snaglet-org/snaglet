import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import { zonedToInstant } from '@desktop/features/calendar/calendarDates';
import type {
  Calendar,
  CalendarOccurrence,
  CalendarOccurrencesResponse,
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
  occurrencesSearch: (q: {
    from: string;
    to: string;
    calendarIds?: string[];
    projectId?: string;
    tz?: string;
  }) =>
    `from=${q.from}&to=${q.to}&ids=${q.calendarIds?.join(',') ?? ''}&p=${q.projectId ?? ''}&tz=${q.tz ?? ''}`,
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { THEME_CHANGED } from '@desktop/utils/workspaceTheme';
import { FetchError } from '@desktop/utils/api/core';

// The real editor mounts TipTap; the description field needs only a text box here.
vi.mock('@desktop/features/rich-markdown/editor', async () => ({
  ChipEditableInput: (
    await import('@desktop/features/rich-markdown/editor/chipEditableInput.testMock')
  ).MockChipEditableInput,
}));

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function cal(extra: Partial<Calendar> = {}): Calendar {
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
    boundFields: [],
    ...extra,
  };
}

function response(
  occurrences: CalendarOccurrence[] = [],
  unavailable: CalendarOccurrencesResponse['unavailable'] = []
) {
  return { from: '', to: '', occurrences, unavailable };
}

const allDayEvent = (key: string, title: string, day: string): CalendarOccurrence => ({
  source: 'event',
  key: `event:${key}`,
  eventId: key,
  revision: 3,
  calendarId: 'cal-default',
  title,
  time: {
    kind: 'all_day',
    startDate: day,
    endDate: day.replace(/\d\d$/, (d) => String(Number(d) + 1).padStart(2, '0')),
  },
  status: 'upcoming',
  canMove: true,
  canResize: false,
});

function seed(calendars: Calendar[], view: Parameters<typeof __resetCalendarViewForTests>[0] = {}) {
  __resetCalendarStoreForTests({ calendars });
  __resetCalendarViewForTests({
    anchor: '2026-10-14',
    zoom: 'week',
    ...view,
  });
}

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('CalendarView', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.values(api).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    api.listCalendars.mockResolvedValue({ calendars: [cal()] });
    api.occurrences.mockResolvedValue(response());
  });
  afterEach(() => vi.useRealTimers());

  it('shows the week toolbar label and loads the visible window in the viewer zone', async () => {
    seed([cal()]);
    render(<CalendarView />);
    expect(screen.getByRole('heading', { name: 'Oct 12 – 18, 2026' })).toBeInTheDocument();
    await waitFor(() => expect(api.occurrences).toHaveBeenCalled());
    expect(api.occurrences.mock.calls[0]![0]).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-19',
      tz: ZONE,
    });
  });

  it('prev / next move by the zoom unit without touching pane history (view store only)', async () => {
    seed([cal()]);
    render(<CalendarView />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(screen.getByRole('heading', { name: 'Oct 19 – 25, 2026' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Month' }));
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('snaglet.calendar.view')!)).toMatchObject({
      zoom: 'month',
    });
  });

  it('opens a fresh calendar with no intro banner above the grid', () => {
    seed([cal()]);
    render(<CalendarView />);
    expect(screen.queryByText(/This is your calendar/)).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show a date field' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('grid')).toHaveLength(1);
  });

  it('error banner with Retry; the grid stays usable', async () => {
    api.occurrences.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(response());
    seed([cal()]);
    render(<CalendarView />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load this week");
    expect(screen.getAllByRole('grid')).toHaveLength(1);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('notes unavailable fields and the all-hidden state', async () => {
    api.occurrences.mockResolvedValue(
      response(
        [],
        [
          { tableId: 't', fieldId: 'f1', reason: 'table_archived' },
          { tableId: 't', fieldId: 'f2', reason: 'table_archived' },
        ]
      )
    );
    seed([cal()]);
    const { unmount } = render(<CalendarView />);
    expect(
      await screen.findByText(/2 fields aren't showing because their tables are archived/)
    ).toBeInTheDocument();
    unmount();

    __resetCalendarStoreForTests({ calendars: [cal()], hidden: new Set(['cal-default']) });
    render(<CalendarView />);
    expect(screen.getByText(/All calendars are hidden/)).toBeInTheDocument();
  });

  it('draws a custom color inline, its tick ink following theme edits', async () => {
    api.occurrences.mockResolvedValue(response([allDayEvent('e1', 'Offsite', '2026-10-14')]));
    seed([cal({ color: '#ffee88' })]);
    render(<CalendarView />);
    const item = await screen.findByRole('button', { name: /Offsite, event/ });
    expect(item).toHaveAttribute('data-cal-color', '#ffee88');
    expect(item.style.getPropertyValue('--cal-accent')).toBe('#ffee88');
    // The default theme is dark, so the pale color reads as a tick as it is.
    expect(item.style.getPropertyValue('--cal-accent-ink')).toBe('#ffee88');

    // On a light theme it is too pale to read: a darker shade of it.
    act(() => {
      document.documentElement.style.setProperty('--background', '#ffffff');
      document.documentElement.style.setProperty('--text', '#30392d');
      window.dispatchEvent(new Event(THEME_CHANGED));
    });
    try {
      await waitFor(() =>
        expect(
          screen
            .getByRole('button', { name: /Offsite, event/ })
            .style.getPropertyValue('--cal-accent-ink')
        ).not.toBe('#ffee88')
      );
    } finally {
      document.documentElement.removeAttribute('style');
    }
  });

  it('draws items with an accessible label and keeps old items while the next range loads', async () => {
    let resolveMonth: (v: unknown) => void = () => undefined;
    api.occurrences.mockImplementation((q: { from: string }) => {
      // The month window (and only the visible fetch of it) is held open.
      if (q.from === '2026-09-28') return new Promise((r) => (resolveMonth = r));
      return Promise.resolve(response([allDayEvent('e1', 'Offsite', '2026-10-14')]));
    });
    seed([cal()]);
    render(<CalendarView />);
    const item = await screen.findByRole('button', {
      name: /Offsite, event, Wednesday October 14, all day/,
    });
    expect(item).toHaveAttribute('data-cal-color', 'blue');
    // Week → Month: the month window contains the item; it stays drawn while
    // the new window loads (no flash), then the new response replaces it.
    fireEvent.click(screen.getByRole('radio', { name: 'Month' }));
    await waitFor(() =>
      expect(api.occurrences.mock.calls.some(([q]) => q.from === '2026-09-28')).toBe(true)
    );
    expect(screen.getByText('Offsite')).toBeInTheDocument();
    await act(async () => resolveMonth(response()));
    await waitFor(() => expect(screen.queryByText('Offsite')).not.toBeInTheDocument());
  });

  it('quick add: Enter on a slot, type, Enter saves an event there', async () => {
    api.createEvent.mockImplementation(async (input) => ({
      event: {
        ...input,
        calendarId: 'cal-default',
        description: '',
        location: '',
        revision: 1,
        createdAt: '',
        updatedAt: '',
      },
    }));
    seed([cal()]);
    render(<CalendarView />);
    const slot = screen.getByRole('gridcell', { name: 'Wednesday, October 14, 9 AM' });
    slot.focus();
    fireEvent.keyDown(slot, { key: 'Enter' });
    const title = await screen.findByRole('textbox', { name: 'Event title' });
    expect(screen.getByText('Wed Oct 14, 9:00 – 9:30 AM')).toBeInTheDocument();
    fireEvent.change(title, { target: { value: 'Standup' } });
    fireEvent.submit(title.closest('form')!);
    await waitFor(() => expect(api.createEvent).toHaveBeenCalled());
    const input = api.createEvent.mock.calls[0]![0];
    expect(input).toMatchObject({
      title: 'Standup',
      calendarId: 'cal-default',
      time: { kind: 'timed', timeZone: ZONE },
    });
    expect(new Date(input.time.endAt).getTime() - new Date(input.time.startAt).getTime()).toBe(
      30 * 60_000
    );
    expect(await screen.findByText('Standup')).toBeInTheDocument();
    expect(toast.showToast).toHaveBeenCalledWith(
      'Added Standup',
      expect.objectContaining({ action: expect.any(Object) })
    );
  });

  it('quick add: the title takes focus once the popover is placed, so typing lands in it', async () => {
    seed([cal()]);
    render(<CalendarView />);
    // A real browser drops React's autoFocus while the surface is still
    // `visibility: hidden` (not placed yet); emulate that by blurring it.
    const blur = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementationOnce(function (this: HTMLElement) {});
    fireEvent.keyDown(screen.getByRole('gridcell', { name: 'Wednesday, October 14, 9 AM' }), {
      key: 'Enter',
    });
    const title = await screen.findByRole('textbox', { name: 'Event title' });
    blur.mockRestore();
    await waitFor(() => expect(title).toHaveFocus());
  });

  it('quick add: Escape cancels and removes the ghost, no request', async () => {
    seed([cal()]);
    render(<CalendarView />);
    fireEvent.keyDown(screen.getByRole('gridcell', { name: 'Wednesday, October 14, 9 AM' }), {
      key: 'Enter',
    });
    const title = await screen.findByRole('textbox', { name: 'Event title' });
    fireEvent.change(title, { target: { value: 'Nope' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-calendar-ghost]')).toBeNull();
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('Month: clicking a day opens all-day quick add; the date number opens Day view', async () => {
    seed([cal()], { zoom: 'month' });
    render(<CalendarView />);
    fireEvent.click(screen.getByRole('gridcell', { name: 'Thursday, October 15' }));
    expect(await screen.findByText('Thursday, October 15 · All day')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Event title' }), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Thursday October 15' }));
    expect(screen.getByRole('heading', { name: 'Thursday, October 15' })).toBeInTheDocument();
  });

  it('Month keeps a tab stop when the next month has fewer weeks', () => {
    // August 2026 spans six Monday weeks, September five.
    seed([cal()], { zoom: 'month', anchor: '2026-08-14' });
    render(<CalendarView />);
    fireEvent.focus(screen.getByRole('gridcell', { name: 'Sunday, September 6' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
    const stops = screen
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('tabindex') === '0');
    expect(stops.map((cell) => cell.getAttribute('aria-label'))).toEqual(['Sunday, October 4']);
  });

  it('the zoom switcher runs Day, Week, Month, Year; the arrows are labeled chevron buttons', () => {
    seed([cal()]);
    render(<CalendarView />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Day',
      'Week',
      'Month',
      'Year',
    ]);
    for (const name of ['Previous week', 'Next week']) {
      const arrow = screen.getByRole('button', { name });
      expect(arrow.querySelector('svg')).not.toBeNull();
      expect(arrow.textContent).toBe('');
    }
  });

  it('a pane under 700 px shows 3 days (D 3D M Y long-labeled, short under 520 px)', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(620);
    seed([cal()]);
    const first = render(<CalendarView />);
    expect(screen.getByRole('heading', { name: 'Oct 14 – 16, 2026' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'Day',
      '3 days',
      'Month',
      'Year',
    ]);
    first.unmount();
    width.mockReturnValue(700);
    seed([cal()]);
    const wide = render(<CalendarView />);
    expect(screen.getByRole('heading', { name: 'Oct 12 – 18, 2026' })).toBeInTheDocument();
    wide.unmount();
    width.mockRestore();
  });

  it('narrow pane: Week becomes an honest 3 days (D 3D M Y); under 380 px only Day, Month and Year', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(480);
    seed([cal()]);
    const { unmount } = render(<CalendarView />);
    expect(screen.getByRole('heading', { name: 'Oct 14 – 16, 2026' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['D', '3D', 'M', 'Y']);
    fireEvent.click(screen.getByRole('button', { name: 'Next range' }));
    expect(screen.getByRole('heading', { name: 'Oct 17 – 19, 2026' })).toBeInTheDocument();
    unmount();

    width.mockReturnValue(360);
    seed([cal()]);
    render(<CalendarView />);
    expect(screen.getByRole('heading', { name: 'Wednesday, October 14' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Day',
      'Month',
      'Year',
    ]);
    // The saved zoom stays Week, so widening restores it.
    expect(
      JSON.parse(window.localStorage.getItem('snaglet.calendar.view') ?? '{}').zoom ?? 'week'
    ).toBe('week');
    width.mockRestore();
  });

  it('widening a pane from Day back to Week refetches the full week and draws its items', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    const observers: Array<() => void> = [];
    const RO = vi.fn(function (this: unknown, cb: () => void) {
      observers.push(cb);
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });
    vi.stubGlobal('ResizeObserver', RO);
    api.occurrences.mockImplementation((q: { from: string; to: string }) =>
      Promise.resolve(
        response(
          [
            allDayEvent('mon', 'Monday thing', '2026-10-12'),
            allDayEvent('wed', 'Wednesday thing', '2026-10-14'),
          ].filter(
            (o) =>
              o.time.kind === 'all_day' && o.time.startDate >= q.from && o.time.startDate < q.to
          )
        )
      )
    );
    try {
      seed([cal()]);
      render(<CalendarView />);
      expect(screen.getByRole('heading', { name: 'Wednesday, October 14' })).toBeInTheDocument();
      await screen.findByRole('button', { name: /^Wednesday thing/ });
      expect(screen.queryByText('Monday thing')).not.toBeInTheDocument();

      // A realtime change while in Day refetches the Day window (coalesced).
      const before = api.occurrences.mock.calls.length;
      act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
      await waitFor(() => expect(api.occurrences.mock.calls.length).toBeGreaterThan(before));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      api.occurrences.mockClear();

      width.mockReturnValue(1024);
      act(() => observers.forEach((cb) => cb()));
      expect(screen.getByRole('heading', { name: 'Oct 12 – 18, 2026' })).toBeInTheDocument();
      await waitFor(() =>
        expect(
          api.occurrences.mock.calls.some(([q]) => q.from === '2026-10-12' && q.to === '2026-10-19')
        ).toBe(true)
      );
      expect(await screen.findByRole('button', { name: /^Monday thing/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Wednesday thing/ })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      width.mockRestore();
    }
  });

  it('bare-letter shortcuts work on the pane root but never while typing', () => {
    seed([cal()]);
    render(<CalendarView />);
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'm' });
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search this range' });
    fireEvent.keyDown(search, { key: 'd' });
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
  });

  it('j moves to the next range and k to the previous (Google Calendar / Vim), in Month, Week and Day', () => {
    const cases = [
      { zoom: 'month', start: 'October 2026', next: 'November 2026' },
      { zoom: 'week', start: 'Oct 12 – 18, 2026', next: 'Oct 19 – 25, 2026' },
      { zoom: 'day', start: 'Wednesday, October 14', next: 'Thursday, October 15' },
    ] as const;
    for (const { zoom, start, next } of cases) {
      for (const [forward, back] of [
        ['j', 'k'],
        ['J', 'K'],
      ]) {
        seed([cal()], { zoom });
        const view = render(<CalendarView />);
        const root = document.querySelector<HTMLElement>('[data-zoom]')!;
        expect(screen.getByRole('heading', { name: start })).toBeInTheDocument();
        fireEvent.keyDown(root, { key: forward });
        expect(screen.getByRole('heading', { name: next })).toBeInTheDocument();
        fireEvent.keyDown(root, { key: back });
        expect(screen.getByRole('heading', { name: start })).toBeInTheDocument();
        // The ‹ › buttons tell you which key does the same.
        expect(screen.getByRole('button', { name: /^Next / })).toHaveAttribute(
          'aria-keyshortcuts',
          'J ArrowRight'
        );
        expect(screen.getByRole('button', { name: /^Previous / })).toHaveAttribute(
          'aria-keyshortcuts',
          'K ArrowLeft'
        );
        view.unmount();
      }
    }
  });

  it('a view switch keeps focus in the pane, so the next bare-letter shortcut still works', () => {
    seed([cal()]);
    render(<CalendarView />);
    const cell = screen.getByRole('gridcell', { name: 'Wednesday, October 14, 9 AM' });
    cell.focus();
    fireEvent.keyDown(cell, { key: 'm' });
    // The Week grid (and the focused cell) is gone; focus must not fall to <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector('[data-zoom]')).toContainElement(
      document.activeElement as HTMLElement
    );
    fireEvent.keyDown(document.activeElement!, { key: 'd' });
    expect(document.querySelector('[data-zoom]')).toHaveAttribute('data-zoom', 'day');
    // Clicking a zoom radio and then a shortcut works too.
    fireEvent.click(screen.getByRole('radio', { name: 'Week' }));
    fireEvent.keyDown(document.activeElement!, { key: 'm' });
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
  });

  it('event popover: debounced title save is one PATCH; Delete has an undo toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const event = {
      id: 'e1',
      calendarId: 'cal-default',
      title: 'Offsite',
      description: '',
      location: '',
      time: { kind: 'all_day', startDate: '2026-10-14', endDate: '2026-10-15', timeZone: ZONE },
      revision: 3,
      createdAt: '',
      updatedAt: '',
    };
    api.occurrences.mockResolvedValue(response([allDayEvent('e1', 'Offsite', '2026-10-14')]));
    api.getEvent.mockResolvedValue({ event });
    api.updateEvent.mockImplementation(async (_id, patch) => ({
      event: { ...event, ...patch, revision: 4 },
    }));
    api.deleteEvent.mockResolvedValue({ id: 'e1' });
    seed([cal()]);
    render(<CalendarView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Offsite, event/ }));
    const title = await screen.findByDisplayValue('Offsite');
    fireEvent.change(title, { target: { value: 'Offsite 2' } });
    fireEvent.change(title, { target: { value: 'Offsite 2026' } });
    expect(api.updateEvent).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(api.updateEvent).toHaveBeenCalledTimes(1);
    expect(api.updateEvent.mock.calls[0]![1]).toEqual({
      title: 'Offsite 2026',
      expectedRevision: 3,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }));
    await waitFor(() => expect(api.deleteEvent).toHaveBeenCalledWith('e1', 4));
    expect(toast.showToast).toHaveBeenCalledWith(
      'Deleted Offsite 2026',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );
  });
  it('event popover: after a conflict it reads the event again, so the next edit saves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const event = {
      id: 'e1',
      calendarId: 'cal-default',
      title: 'Offsite',
      description: '',
      location: '',
      time: { kind: 'all_day', startDate: '2026-10-14', endDate: '2026-10-15', timeZone: ZONE },
      revision: 3,
      createdAt: '',
      updatedAt: '',
    };
    api.occurrences.mockResolvedValue(response([allDayEvent('e1', 'Offsite', '2026-10-14')]));
    api.getEvent
      .mockResolvedValueOnce({ event })
      .mockResolvedValue({ event: { ...event, title: 'Offsite (moved)', revision: 5 } });
    api.updateEvent
      .mockRejectedValueOnce(new FetchError('Conflict', 409))
      .mockImplementation(async (_id, patch) => ({ event: { ...event, ...patch, revision: 6 } }));
    seed([cal()]);
    render(<CalendarView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Offsite, event/ }));
    const title = await screen.findByDisplayValue('Offsite');
    fireEvent.change(title, { target: { value: 'Offsite 2026' } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(toast.showToast).toHaveBeenCalledWith('Changed elsewhere — refreshed')
    );
    expect(await screen.findByDisplayValue('Offsite (moved)')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Bring snacks' },
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(api.updateEvent).toHaveBeenCalledTimes(2);
    expect(api.updateEvent.mock.calls[1]![1]).toEqual({
      description: 'Bring snacks',
      expectedRevision: 5,
    });
  });

  it('event popover: a new end time keeps a multi-day event ending on its own day', async () => {
    const start = zonedToInstant('2026-10-12', 9 * 60, ZONE);
    const end = zonedToInstant('2026-10-14', 10 * 60, ZONE);
    const event = {
      id: 'e1',
      calendarId: 'cal-default',
      title: 'Offsite',
      description: '',
      location: '',
      time: { kind: 'timed', startAt: start, endAt: end, timeZone: ZONE },
      revision: 3,
      createdAt: '',
      updatedAt: '',
    };
    api.occurrences.mockResolvedValue(
      response([
        {
          source: 'event',
          key: 'event:e1',
          eventId: 'e1',
          revision: 3,
          calendarId: 'cal-default',
          title: 'Offsite',
          time: { kind: 'timed', start, end },
          status: 'upcoming',
          canMove: true,
          canResize: true,
        },
      ])
    );
    api.getEvent.mockResolvedValue({ event });
    api.updateEvent.mockImplementation(async (_id, patch) => ({
      event: { ...event, ...patch, revision: 4 },
    }));
    seed([cal()]);
    render(<CalendarView />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Offsite, event/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Event' });
    fireEvent.click(await within(dialog).findByRole('button', { name: /^Time: / }));
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'End time' }), {
      target: { value: '17:00' },
    });
    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1));
    expect(api.updateEvent.mock.calls[0]![1]).toEqual({
      time: {
        kind: 'timed',
        startAt: start,
        endAt: zonedToInstant('2026-10-14', 17 * 60, ZONE),
        timeZone: ZONE,
      },
      expectedRevision: 3,
    });
  });

  it('event popover: turning All day off makes the item resizable at once (and on again, not)', async () => {
    const event = {
      id: 'e1',
      calendarId: 'cal-default',
      title: 'Offsite',
      description: '',
      location: '',
      time: { kind: 'all_day', startDate: '2026-10-14', endDate: '2026-10-15', timeZone: ZONE },
      revision: 3,
      createdAt: '',
      updatedAt: '',
    };
    api.occurrences.mockResolvedValue(response([allDayEvent('e1', 'Offsite', '2026-10-14')]));
    api.getEvent.mockResolvedValue({ event });
    let revision = 3;
    api.updateEvent.mockImplementation(async (_id, patch) => ({
      event: { ...event, ...patch, revision: ++revision },
    }));
    seed([cal()]);
    render(<CalendarView />);
    const item = () => screen.getByRole('button', { name: /^Offsite, event/ });
    fireEvent.click(await screen.findByRole('button', { name: /^Offsite, event/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Event' });
    const allDay = await within(dialog).findByRole('switch', { name: 'All day' });
    expect(item().querySelector('[data-cal-resize="end"]')).toBeNull();

    fireEvent.click(allDay);
    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(item().querySelector('[data-cal-resize="end"]')).not.toBeNull());

    fireEvent.click(allDay);
    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(item().querySelector('[data-cal-resize]')).toBeNull());
  });

  it('deleting an event from its popover leaves focus in the pane (shortcuts keep working)', async () => {
    const event = {
      id: 'e1',
      calendarId: 'cal-default',
      title: 'Offsite',
      description: '',
      location: '',
      time: { kind: 'all_day', startDate: '2026-10-14', endDate: '2026-10-15', timeZone: ZONE },
      revision: 3,
      createdAt: '',
      updatedAt: '',
    };
    api.occurrences.mockResolvedValue(response([allDayEvent('e1', 'Offsite', '2026-10-14')]));
    api.getEvent.mockResolvedValue({ event });
    api.deleteEvent.mockResolvedValue({ id: 'e1' });
    seed([cal()]);
    render(<CalendarView />);
    fireEvent.click(await screen.findByRole('button', { name: /^Offsite, event/ }));
    await screen.findByDisplayValue('Offsite');
    const remove = screen.getByRole('button', { name: 'Delete event' });
    remove.focus(); // as a real click does
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Event' })).toBeNull());
    const root = document.querySelector<HTMLElement>('[data-zoom]')!;
    expect(root).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: 'm' });
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
  });

  it('a popover whose item a refetch takes away closes, and the pane shortcuts work again', async () => {
    api.occurrences.mockResolvedValue(response([allDayEvent('e1', 'Offsite', '2026-10-14')]));
    seed([cal()]);
    render(<CalendarView />);
    fireEvent.contextMenu(await screen.findByRole('button', { name: /^Offsite, event/ }), {
      clientX: 150,
      clientY: 400,
    });
    const menu = await screen.findByRole('menu', { name: 'Offsite actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to…' }));
    await screen.findByRole('dialog', { name: 'Move Offsite to' });

    // Deleted elsewhere: the next window has no Offsite.
    api.occurrences.mockResolvedValue(response());
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Offsite, event/ })).not.toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move Offsite to' })).not.toBeInTheDocument()
    );
    const root = document.querySelector<HTMLElement>('[data-zoom]')!;
    root.focus();
    fireEvent.keyDown(root, { key: 'm' });
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeInTheDocument();
  });

  it('Week opening scroll: 1 h before the first timed item once it loads; refetches keep the scroll', async () => {
    seed([cal()]); // Oct 12-18 2026; "today" is not in it unless the clock says so
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    let resolve!: (r: ReturnType<typeof response>) => void;
    api.occurrences.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { container } = render(<CalendarView />);
    const scroller = container.querySelector<HTMLElement>('[data-calendar-scroll]')!;
    // Nothing loaded yet: 8 AM.
    expect(scroller.scrollTop).toBe(8 * 48);
    const start = new Date(2026, 9, 14, 6, 30).toISOString();
    const end = new Date(2026, 9, 14, 7, 0).toISOString();
    await act(async () =>
      resolve(
        response([
          {
            source: 'event',
            key: 'event:early',
            eventId: 'early',
            revision: 1,
            calendarId: 'cal-default',
            title: 'Early run',
            time: { kind: 'timed', start, end },
            status: 'upcoming',
            canMove: true,
            canResize: true,
          },
        ])
      )
    );
    await waitFor(() => expect(scroller.scrollTop).toBe(5.5 * 48));
    // The user scrolls; a later data change does not move it.
    scroller.scrollTop = 600;
    api.occurrences.mockResolvedValue(response());
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() => expect(scroller.scrollTop).toBe(8 * 48)); // new range: re-applied
  });

  it('Week opening scroll waits for the calendar list too (items arrive after calendars load)', async () => {
    // Calendars not loaded yet: the occurrence query can't start, which is not "ready".
    __resetCalendarStoreForTests();
    __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'week' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    let resolveCalendars!: (r: { calendars: Calendar[] }) => void;
    api.listCalendars.mockReturnValueOnce(new Promise((r) => (resolveCalendars = r)));
    const start = new Date(2026, 9, 14, 6, 30).toISOString();
    const end = new Date(2026, 9, 14, 7, 0).toISOString();
    api.occurrences.mockResolvedValue(
      response([
        {
          source: 'event',
          key: 'event:early',
          eventId: 'early',
          revision: 1,
          calendarId: 'cal-default',
          title: 'Early run',
          time: { kind: 'timed', start, end },
          status: 'upcoming',
          canMove: true,
          canResize: true,
        },
      ])
    );
    const { container } = render(<CalendarView />);
    const scroller = container.querySelector<HTMLElement>('[data-calendar-scroll]');
    if (scroller) expect(scroller.scrollTop).toBe(8 * 48);
    await act(async () => resolveCalendars({ calendars: [cal()] }));
    await screen.findByRole('button', { name: /^Early run/ });
    const grid = container.querySelector<HTMLElement>('[data-calendar-scroll]')!;
    await waitFor(() => expect(grid.scrollTop).toBe(5.5 * 48));
  });
});
