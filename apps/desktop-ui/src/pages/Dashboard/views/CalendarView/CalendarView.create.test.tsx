/**
 * Click or drag to create, and opening days: sweeping empty grid opens quick
 * add with the swept range (zoom-corrected), Enter saves one undo step,
 * Escape discards; in Week / Day a plain click on an empty slot opens a
 * 30-minute quick add there (an all-day one in the all-day band), a click
 * that closes a popover adds nothing, a sweep's release adds once, and a
 * click on an item still opens it; Month's day click still adds; items still
 * drag; the all-day band sweeps one-day and multi-day events. The sidebar
 * mini month opens the clicked day in the pane in every view.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import type { Calendar, CalendarOccurrence, TableCatalogEntry } from '@snaglet/shared/types';

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
const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);
const writes = vi.hoisted(() => ({ commitMove: vi.fn() }));
vi.mock('@desktop/features/calendar/occurrenceWrites', async (orig) => ({
  ...(await orig<typeof import('@desktop/features/calendar/occurrenceWrites')>()),
  commitMove: writes.commitMove,
}));
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({ usePaneIsActive: () => true }));
const scroll = vi.hoisted(() => ({ created: [] as HTMLElement[], updates: 0 }));
vi.mock('@desktop/utils/edgeAutoScroll', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/edgeAutoScroll')>();
  return {
    createEdgeAutoScroller: (
      el: HTMLElement,
      opts: Parameters<typeof actual.createEdgeAutoScroller>[1]
    ) => {
      scroll.created.push(el);
      const real = actual.createEdgeAutoScroller(el, opts);
      return {
        update: (x: number, y: number) => {
          scroll.updates++;
          real.update(x, y);
        },
        stop: () => real.stop(),
      };
    },
  };
});
// The sidebar's field picker lists tables and projects.
vi.mock('@desktop/features/database/useTableCatalog', () => ({
  useTableCatalog: () => ({ tables: [] as TableCatalogEntry[], error: null, reload: vi.fn() }),
}));
vi.mock('@desktop/features/database/projectList', () => ({
  useProjectList: () => ({ projects: [], error: null, reload: vi.fn() }),
  projectNameOf: () => null,
}));

import { CalendarView } from './CalendarView';
import { CalendarSidebar } from './CalendarSidebar';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import {
  __resetCalendarViewForTests,
  type CalendarViewState,
} from '@desktop/features/calendar/calendarViewStore';
import {
  __resetCalendarUndoForTests,
  calendarUndoState,
} from '@desktop/features/calendar/calendarUndo';

// The real editor mounts TipTap; the description field needs only a text box here.
vi.mock('@desktop/features/rich-markdown/editor', async () => ({
  ChipEditableInput: (
    await import('@desktop/features/rich-markdown/editor/chipEditableInput.testMock')
  ).MockChipEditableInput,
}));

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOUR = 40; // test column: 960 px tall at zoom 1

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
    boundFields: [],
  } as Calendar;
}

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

function standup(): CalendarOccurrence {
  return {
    source: 'event',
    key: 'event:s',
    eventId: 's',
    revision: 2,
    calendarId: 'cal-default',
    title: 'Standup',
    time: { kind: 'timed', start: at(13, 9), end: at(13, 10) },
    status: 'upcoming',
    canMove: true,
    canResize: true,
  } as CalendarOccurrence;
}

function seed(view: Partial<CalendarViewState> = {}) {
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({
    anchor: '2026-10-14',
    zoom: 'week',
    ...view,
  });
}

/**
 * Lay the Week out as a pane at CSS zoom `zoom` reports it: each day column is
 * 100 px wide and 960 px tall in its own px, so `zoom` × that in viewport px
 * (what rects and pointer coordinates use); the engine reports the zoom too.
 */
function layout(zoom = 1) {
  const cols = Array.from(document.querySelectorAll<HTMLElement>('[data-cal-drop="timed"]'));
  const cells = Array.from(document.querySelectorAll<HTMLElement>('[data-cal-drop="allday"]'));
  const rect = (i: number, top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      height,
      left: i * 100 * zoom,
      right: (i + 1) * 100 * zoom,
      width: 100 * zoom,
    }) as DOMRect;
  cols.forEach((col, i) => (col.getBoundingClientRect = () => rect(i, 0, 24 * HOUR * zoom)));
  cells.forEach((cell, i) => (cell.getBoundingClientRect = () => rect(i, 0, 20 * zoom)));
  document.elementsFromPoint = ((x: number) => {
    const col = cols[Math.floor(x / (100 * zoom))];
    return col ? [col] : [];
  }) as typeof document.elementsFromPoint;
  if (zoom !== 1) {
    for (const el of document.querySelectorAll('[data-cal-drop], [role="gridcell"]')) {
      Object.defineProperty(el, 'currentCSSZoom', { value: zoom, configurable: true });
    }
  }
}

const slot = (name: string) => screen.getByRole('gridcell', { name });
const sweepGhost = () =>
  document.querySelector<HTMLElement>('[data-calendar-ghost][data-sweeping]');

/** Press on `el` at (x, y), travel past the threshold to (x2, y2), optionally release. */
function sweep(el: HTMLElement, from: [number, number], to: [number, number], release = true) {
  fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(window, { clientX: from[0], clientY: from[1] + 8 });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] });
  if (release) fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
}

function echoCreate() {
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
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  window.localStorage.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
  toast.showToast.mockReset();
  writes.commitMove.mockReset().mockResolvedValue(undefined);
  api.listCalendars.mockResolvedValue({ calendars: [cal()] });
  api.occurrences.mockResolvedValue({ from: '', to: '', occurrences: [], unavailable: [] });
  scroll.created = [];
  scroll.updates = 0;
  __resetCalendarUndoForTests();
});
afterEach(() => vi.unstubAllGlobals());

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('drag to create (Week / Day)', () => {
  it('a sweep draws a live ghost, opens quick add prefilled, and Enter saves one undo step', async () => {
    echoCreate();
    seed();
    render(<CalendarView />);
    layout();
    // Wed Oct 14 is column 2 (x 200–300); 9 AM down to 10:20.
    sweep(slot('Wednesday, October 14, 9 AM'), [250, 9 * HOUR], [250, 10.33 * HOUR], false);
    expect(sweepGhost()).toHaveTextContent('9:00 – 10:30 AM');
    expect(sweepGhost()).toHaveAttribute('data-cal-color', 'blue');
    expect(sweepGhost()!.closest('[data-cal-day]')).toHaveAttribute('data-cal-day', '2026-10-14');
    expect(document.body.style.cursor).toBe('crosshair');
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument();
    // While creating, only the ghost marks the range (no hovered-slot tint).
    const grid = screen.getByRole('grid', { name: 'Calendar' });
    expect(grid).toHaveAttribute('data-creating');

    fireEvent.pointerUp(window, { clientX: 250, clientY: 10.33 * HOUR });
    // The click that follows the release doesn't start a second quick add.
    fireEvent.click(slot('Wednesday, October 14, 10 AM'));
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 9:00 – 10:30 AM')).toBeInTheDocument();
    const title = within(dialog).getByRole('textbox', { name: 'Event title' });
    await waitFor(() => expect(title).toHaveFocus());
    // The sweep ghost became the draft the popover anchors to.
    expect(sweepGhost()).toBeNull();
    expect(document.querySelector('[data-calendar-ghost]')).toHaveTextContent('9:00 – 10:30 AM');
    expect(grid).toHaveAttribute('data-creating');

    fireEvent.change(title, { target: { value: 'Planning' } });
    fireEvent.submit(title.closest('form')!);
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
    expect(api.createEvent.mock.calls[0]![0]).toMatchObject({
      title: 'Planning',
      time: { kind: 'timed', startAt: at(14, 9), endAt: at(14, 10, 30), timeZone: ZONE },
    });
    // The ghost becomes the event, and the create is one calendar undo step.
    const event = await screen.findByRole('button', { name: /^Planning/ });
    expect(event.closest('[data-cal-day]')).toHaveAttribute('data-cal-day', '2026-10-14');
    expect(document.querySelector('[data-calendar-ghost]')).toBeNull();
    expect(grid).not.toHaveAttribute('data-creating');
    expect(calendarUndoState().undo).toBe('Add event');
    expect(toast.showToast).toHaveBeenCalledWith(
      'Added Planning',
      expect.objectContaining({ action: expect.any(Object) })
    );
  });

  it('corrects for the pane’s CSS zoom (0.8): the range comes from the zoomed column', async () => {
    seed();
    render(<CalendarView />);
    layout(0.8);
    const z = 0.8 * HOUR; // viewport px per hour
    // 10:20 at zoom 0.8 is y 330.7; read as unzoomed px it would be ~8:16.
    sweep(slot('Wednesday, October 14, 9 AM'), [250 * 0.8, 9 * z], [250 * 0.8, (10 + 20 / 60) * z]);
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 9:00 – 10:30 AM')).toBeInTheDocument();
  });

  it('sweeping up keeps the pressed slot inside the range', async () => {
    seed();
    render(<CalendarView />);
    layout();
    sweep(slot('Wednesday, October 14, 10 AM'), [250, 10 * HOUR], [250, (8 + 20 / 60) * HOUR]);
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 8:15 – 10:15 AM')).toBeInTheDocument();
  });

  it('runs into another day’s column like Google: the end is that day’s time', async () => {
    echoCreate();
    seed();
    render(<CalendarView />);
    layout();
    // Wed 9 PM across into Thursday (column 3) at 0:50.
    sweep(slot('Wednesday, October 14, 9 PM'), [250, 21 * HOUR], [350, (50 / 60) * HOUR], false);
    const pieces = document.querySelectorAll('[data-calendar-ghost][data-sweeping]');
    expect(
      Array.from(pieces, (p) => p.closest('[data-cal-day]')!.getAttribute('data-cal-day'))
    ).toEqual(['2026-10-14', '2026-10-15']);
    expect(pieces[0]).toHaveTextContent('Wed 9 PM – Thu 1 AM');
    fireEvent.pointerUp(window, { clientX: 350, clientY: (50 / 60) * HOUR });
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 9 PM – Thu Oct 15, 1 AM')).toBeInTheDocument();
    const title = within(dialog).getByRole('textbox', { name: 'Event title' });
    fireEvent.change(title, { target: { value: 'Night shift' } });
    fireEvent.submit(title.closest('form')!);
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
    expect(api.createEvent.mock.calls[0]![0].time).toMatchObject({
      startAt: at(14, 21),
      endAt: at(15, 1),
    });
  });

  it('Escape in quick add discards the swept draft: nothing is saved', async () => {
    seed();
    render(<CalendarView />);
    layout();
    sweep(slot('Wednesday, October 14, 9 AM'), [250, 9 * HOUR], [250, 11 * HOUR]);
    const title = await screen.findByRole('textbox', { name: 'Event title' });
    fireEvent.change(title, { target: { value: 'Never mind' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-calendar-ghost]')).toBeNull();
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('Escape during the sweep cancels it; the release after is not a click either', async () => {
    seed();
    render(<CalendarView />);
    layout();
    sweep(slot('Wednesday, October 14, 9 AM'), [250, 9 * HOUR], [250, 11 * HOUR], false);
    expect(sweepGhost()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sweepGhost()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 250, clientY: 11 * HOUR });
    fireEvent.click(slot('Wednesday, October 14, 11 AM'));
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument();
    expect(document.body.style.cursor).toBe('');
  });

  it('pressing an item drags the item, never starts a create', async () => {
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [standup()],
      unavailable: [],
    });
    seed();
    render(<CalendarView />);
    const item = await screen.findByRole('button', { name: /^Standup/ });
    layout();
    sweep(item, [150, 9.25 * HOUR], [150, 11.25 * HOUR], false);
    expect(sweepGhost()).toBeNull();
    expect(document.querySelector('[data-calendar-drag-ghost]')).not.toBeNull();
    fireEvent.pointerUp(window, { clientX: 150, clientY: 11.25 * HOUR });
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument();
  });

  it('edge auto-scroll runs on the calendar scroller while sweeping', () => {
    seed();
    render(<CalendarView />);
    layout();
    sweep(slot('Wednesday, October 14, 9 AM'), [250, 9 * HOUR], [250, 12 * HOUR], false);
    expect(scroll.created).toEqual([document.querySelector('[data-calendar-scroll]')]);
    expect(scroll.updates).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('the all-day band sweeps across days into one multi-day all-day event', async () => {
    echoCreate();
    seed();
    render(<CalendarView />);
    layout();
    // Tue (column 1) across to Thu (column 3).
    sweep(slot('Tuesday, October 13, all day'), [150, 10], [350, 10], false);
    const ghost = sweepGhost()!;
    expect(ghost.style.gridColumn).toBe('2 / 5');
    expect(scroll.created).toEqual([]); // the band is sticky: no auto-scroll
    fireEvent.pointerUp(window, { clientX: 350, clientY: 10 });
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Tue Oct 13 – Thu Oct 15 · All day')).toBeInTheDocument();
    const title = within(dialog).getByRole('textbox', { name: 'Event title' });
    fireEvent.change(title, { target: { value: 'Offsite' } });
    fireEvent.submit(title.closest('form')!);
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
    expect(api.createEvent.mock.calls[0]![0].time).toMatchObject({
      kind: 'all_day',
      startDate: '2026-10-13',
      endDate: '2026-10-16',
    });
  });

  it('Day view sweeps its one column', async () => {
    seed({ zoom: 'day' });
    render(<CalendarView />);
    layout();
    sweep(slot('Wednesday, October 14, 2 PM'), [50, 14 * HOUR], [60, 15.6 * HOUR]);
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 2:00 – 3:45 PM')).toBeInTheDocument();
  });

  it('a sweep that stays in one all-day cell makes a one-day all-day event', async () => {
    seed();
    render(<CalendarView />);
    layout();
    sweep(slot('Tuesday, October 13, all day'), [150, 10], [165, 10]);
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Tuesday, October 13 · All day')).toBeInTheDocument();
  });
});

describe('a click on empty grid (Week / Day) opens a 30-minute quick add', () => {
  /** Press, wobble under the drag threshold, release and click: what a mouse click does. */
  function click(el: HTMLElement, x: number, y: number) {
    fireEvent.pointerDown(el, { button: 0, clientX: x, clientY: y });
    fireEvent.pointerMove(window, { clientX: x + 1, clientY: y + 2 }); // under the threshold
    fireEvent.pointerUp(window, { clientX: x + 1, clientY: y + 2 });
    fireEvent.click(el, { clientX: x + 1, clientY: y + 2 });
  }
  const nothingOpened = () => {
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-calendar-ghost]')).toBeNull();
  };

  it('a single click on an empty Week slot opens quick add for that slot’s 30 minutes', async () => {
    seed();
    render(<CalendarView />);
    layout();
    // Lower half of the 9:00 slot: still the slot, 9:00 – 9:30.
    click(slot('Wednesday, October 14, 9 AM'), 250, 9.4 * HOUR);
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 9:00 – 9:30 AM')).toBeInTheDocument();
    expect(document.querySelector('[data-calendar-ghost]')).not.toBeNull();
    expect(document.body.style.cursor).toBe('');
    // Opening it saves nothing.
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('in Day view too, and in the all-day band an all-day one for that day', async () => {
    seed({ zoom: 'day' });
    render(<CalendarView />);
    layout();
    click(slot('Wednesday, October 14, 2 PM'), 50, 14 * HOUR);
    let dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 2:00 – 2:30 PM')).toBeInTheDocument();
    fireEvent.keyDown(within(dialog).getByRole('textbox', { name: /title/i }), { key: 'Escape' });
    await waitFor(() => nothingOpened());

    click(slot('Wednesday, October 14, all day'), 50, 10);
    dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wednesday, October 14 · All day')).toBeInTheDocument();
  });

  it('a click while quick add is open only closes it (one click, one layer)', async () => {
    seed();
    render(<CalendarView />);
    layout();
    click(slot('Wednesday, October 14, 9 AM'), 250, 9 * HOUR);
    await screen.findByRole('dialog', { name: 'New event' });
    click(slot('Wednesday, October 14, 11 AM'), 250, 11 * HOUR);
    await waitFor(() => nothingOpened());
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('a sweep opens one quick add with its range, not a second for the click after it', async () => {
    seed();
    render(<CalendarView />);
    layout();
    sweep(slot('Wednesday, October 14, 9 AM'), [250, 9 * HOUR], [250, 9.9 * HOUR]);
    fireEvent.click(slot('Wednesday, October 14, 9 AM'));
    const dialogs = await screen.findAllByRole('dialog', { name: 'New event' });
    expect(dialogs).toHaveLength(1);
    expect(within(dialogs[0]!).getByText('Wed Oct 14, 9:00 – 10:00 AM')).toBeInTheDocument();
  });

  it('the same press dragged past the threshold opens quick add with the swept range', async () => {
    seed();
    render(<CalendarView />);
    layout();
    sweep(slot('Wednesday, October 14, 9 AM'), [250, 9 * HOUR], [250, 9.9 * HOUR]);
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 9:00 – 10:00 AM')).toBeInTheDocument();
  });

  it('a click on an event still opens it', async () => {
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [standup()],
      unavailable: [],
    });
    api.getEvent.mockResolvedValue({
      event: {
        id: 's',
        calendarId: 'cal-default',
        title: 'Standup',
        description: '',
        location: '',
        time: { kind: 'timed', startAt: at(13, 9), endAt: at(13, 10), timeZone: ZONE },
        revision: 2,
        createdAt: '',
        updatedAt: '',
      },
    });
    seed();
    render(<CalendarView />);
    const item = await screen.findByRole('button', { name: /^Standup/ });
    layout();
    click(item, 150, 9.25 * HOUR);
    const popover = await screen.findByRole('dialog', { name: 'Event' });
    expect(await within(popover).findByDisplayValue('Standup')).toBeInTheDocument();
    expect(writes.commitMove).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument();

    // One click, one layer: a click on empty grid with the popover open
    // closes the popover and makes nothing.
    click(slot('Wednesday, October 14, 11 AM'), 250, 11 * HOUR);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Event' })).toBeNull());
    nothingOpened();
    expect(api.updateEvent).not.toHaveBeenCalled();
  });

  it('Enter on a focused slot still opens its 30-minute quick add', async () => {
    seed();
    render(<CalendarView />);
    const cell = slot('Wednesday, October 14, 9 AM');
    cell.focus();
    fireEvent.keyDown(cell, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Wed Oct 14, 9:00 – 9:30 AM')).toBeInTheDocument();
  });

  it('Month is unchanged: a click on an empty day opens all-day quick add', async () => {
    seed({ zoom: 'month' });
    render(<CalendarView />);
    fireEvent.click(slot('Thursday, October 15'));
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    expect(within(dialog).getByText('Thursday, October 15 · All day')).toBeInTheDocument();
  });
});

describe('opening a day', () => {
  function renderPane(view: Partial<CalendarViewState>) {
    seed(view);
    render(
      <>
        <CalendarSidebar />
        <CalendarView />
      </>
    );
  }
  const pick = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  const marked = () =>
    screen
      .getAllByRole('columnheader')
      .filter((h) => /dayHeadMarked/.test(h.className))
      .map((h) => h.textContent);

  it('mini month in Month view opens the day in Day view', () => {
    renderPane({ zoom: 'month' });
    pick('Tuesday, October 20');
    expect(screen.getByRole('heading', { name: 'Tuesday, October 20' })).toBeInTheDocument();
  });

  it('mini month in Week view goes to its week and marks the day; moving on clears it', () => {
    renderPane({ zoom: 'week' });
    pick('Tuesday, October 20');
    expect(screen.getByRole('heading', { name: 'Oct 19 – 25, 2026' })).toBeInTheDocument();
    expect(marked()).toEqual([expect.stringMatching(/^Tue20/)]);
    // The grid's tab stop moved onto the marked day.
    expect(
      screen.getAllByRole('gridcell').find((c) => c.getAttribute('tabindex') === '0')
    ).toHaveAccessibleName(/^Tuesday, October 20, /);
    pick('Thursday, October 22'); // same week: the mark follows
    expect(marked()).toEqual([expect.stringMatching(/^Thu22/)]);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(marked()).toEqual([]);
  });

  it('mini month in a narrow 3-day pane starts the range on the day and marks it', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(480);
    renderPane({ zoom: 'week' });
    pick('Tuesday, October 20');
    expect(screen.getByRole('heading', { name: 'Oct 20 – 22, 2026' })).toBeInTheDocument();
    expect(marked()).toEqual([expect.stringMatching(/^Tue20/)]);
    width.mockRestore();
  });

  it('mini month in Day view goes to that day', () => {
    renderPane({ zoom: 'day' });
    pick('Tuesday, October 20');
    expect(screen.getByRole('heading', { name: 'Tuesday, October 20' })).toBeInTheDocument();
    expect(marked()).toEqual([]);
  });

  it('Week column headers and Month date numbers open Day view too', () => {
    renderPane({ zoom: 'week' });
    pick('Open Thursday October 15');
    expect(screen.getByRole('heading', { name: 'Thursday, October 15' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Month' }));
    pick('Open Friday October 30');
    expect(screen.getByRole('heading', { name: 'Friday, October 30' })).toBeInTheDocument();
  });

  it('the Month “+N more” title opens its day', async () => {
    const chip = (n: number): CalendarOccurrence =>
      ({
        ...standup(),
        key: `event:${n}`,
        eventId: String(n),
        title: `Item ${n}`,
        time: { kind: 'timed', start: at(15, 8 + n), end: at(15, 9 + n) },
      }) as CalendarOccurrence;
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [1, 2, 3, 4, 5, 6].map(chip),
      unavailable: [],
    });
    renderPane({ zoom: 'month' });
    fireEvent.click(await screen.findByRole('button', { name: /more$/ }));
    const more = await screen.findByRole('dialog', { name: 'Thursday, October 15 items' });
    fireEvent.click(within(more).getByRole('button', { name: 'Open Thursday October 15' }));
    expect(screen.getByRole('heading', { name: 'Thursday, October 15' })).toBeInTheDocument();
  });

  it('an event or automation picked in “+N more” opens its popover, placed on the grid', async () => {
    const chip = (n: number): CalendarOccurrence =>
      ({
        ...standup(),
        key: `event:${n}`,
        eventId: String(n),
        title: `Item ${n}`,
        time: { kind: 'timed', start: at(15, 8 + n), end: at(15, 9 + n) },
      }) as CalendarOccurrence;
    const wake = {
      source: 'automation',
      key: 'automation:a1:wake',
      automationId: 'a1',
      agentName: 'Test Agent',
      calendarId: 'cal-default',
      title: 'Check inbox',
      time: { kind: 'timed', start: at(15, 20), end: at(15, 20, 30) },
      status: 'upcoming',
      canMove: false,
      canResize: false,
    } as CalendarOccurrence;
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [...[1, 2, 3, 4, 5, 6].map(chip), wake],
      unavailable: [],
    });
    api.getEvent.mockImplementation(async (id: string) => ({
      event: {
        id,
        calendarId: 'cal-default',
        title: `Item ${id}`,
        description: '',
        location: '',
        time: { kind: 'timed', startAt: at(15, 13), endAt: at(15, 14), timeZone: ZONE },
        revision: 2,
        createdAt: '',
        updatedAt: '',
      },
    }));
    renderPane({ zoom: 'month' });
    fireEvent.click(await screen.findByRole('button', { name: /more$/ }));
    let more = await screen.findByRole('dialog', { name: 'Thursday, October 15 items' });
    fireEvent.click(within(more).getByRole('button', { name: /^Item 5, event/ }));
    const popover = await screen.findByRole('dialog', { name: 'Event' });
    expect(await within(popover).findByDisplayValue('Item 5')).toBeInTheDocument();
    // Placed (its list closed under it), not left hidden with no anchor.
    expect(popover.style.visibility).not.toBe('hidden');
    fireEvent.keyDown(within(popover).getByDisplayValue('Item 5'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Event' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /more$/ }));
    more = await screen.findByRole('dialog', { name: 'Thursday, October 15 items' });
    fireEvent.click(within(more).getByRole('button', { name: /^Check inbox, automation/ }));
    expect(
      await screen.findByRole('dialog', { name: 'Check inbox automation' })
    ).toBeInTheDocument();
  });

  it('Week / Day “+N” lists the hidden items: focusable, each opens its popover', async () => {
    // Three events starting together: two share the column, the third hides
    // behind "+1" on the last shown block (packTimed's 40 % floor).
    const same = (n: number): CalendarOccurrence =>
      ({
        ...standup(),
        key: `event:${n}`,
        eventId: String(n),
        title: `Item ${n}`,
        time: { kind: 'timed', start: at(15, 9), end: at(15, 10) },
      }) as CalendarOccurrence;
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [1, 2, 3].map(same),
      unavailable: [],
    });
    api.getEvent.mockImplementation(async (id: string) => ({
      event: {
        id,
        calendarId: 'cal-default',
        title: `Item ${id}`,
        description: '',
        location: '',
        time: { kind: 'timed', startAt: at(15, 9), endAt: at(15, 10), timeZone: ZONE },
        revision: 2,
        createdAt: '',
        updatedAt: '',
      },
    }));
    for (const zoom of ['week', 'day'] as const) {
      seed({ zoom, anchor: '2026-10-15' });
      const view = render(<CalendarView />);
      await screen.findByRole('button', { name: /^Item 1, event/ });
      // Only two blocks on the grid; the third is reachable only via "+1".
      expect(screen.queryByRole('button', { name: /^Item 3, event/ })).toBeNull();
      const marker = screen.getByRole('button', { name: /^1 more at / });
      expect(marker.tagName).toBe('BUTTON'); // in the tab order, Enter / Space press it
      expect(marker).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(marker);
      const list = await screen.findByRole('dialog', { name: 'Thursday, October 15, 1 more' });
      expect(marker).toHaveAttribute('aria-expanded', 'true');
      const hidden = within(list).getByRole('button', { name: /^Item 3, event/ });
      // Keyboard: the list's first item takes focus once it is placed.
      await waitFor(() => expect(hidden).toHaveFocus());
      // Escape closes the list and gives focus back to "+1".
      fireEvent.keyDown(hidden, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /1 more$/ })).toBeNull());
      await waitFor(() => expect(marker).toHaveFocus());
      // Picking the item opens its own popover.
      fireEvent.click(marker);
      const again = await screen.findByRole('dialog', { name: 'Thursday, October 15, 1 more' });
      fireEvent.click(within(again).getByRole('button', { name: /^Item 3, event/ }));
      const popover = await screen.findByRole('dialog', { name: 'Event' });
      expect(await within(popover).findByDisplayValue('Item 3')).toBeInTheDocument();
      expect(popover.style.visibility).not.toBe('hidden');
      view.unmount();
    }
  });

  it('Week “+N” list a refetch empties closes and resets aria-expanded; it stays closed when items return', async () => {
    const same = (n: number): CalendarOccurrence =>
      ({
        ...standup(),
        key: `event:${n}`,
        eventId: String(n),
        title: `Item ${n}`,
        time: { kind: 'timed', start: at(15, 9), end: at(15, 10) },
      }) as CalendarOccurrence;
    const window = (n: number) => ({
      from: '',
      to: '',
      occurrences: Array.from({ length: n }, (_, i) => same(i + 1)),
      unavailable: [],
    });
    api.occurrences.mockResolvedValue(window(3));
    seed({ zoom: 'week', anchor: '2026-10-15' });
    render(<CalendarView />);
    fireEvent.click(await screen.findByRole('button', { name: /^1 more at / }));
    await screen.findByRole('dialog', { name: /1 more$/ });

    // Item 3 deleted elsewhere: nothing is hidden, so the list closes.
    api.occurrences.mockResolvedValue(window(2));
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^1 more at / })).toBeNull());
    expect(screen.queryByRole('dialog', { name: /1 more$/ })).toBeNull();

    // It comes back: "+1" returns collapsed, and the list doesn't reopen itself.
    api.occurrences.mockResolvedValue(window(3));
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    const marker = await screen.findByRole('button', { name: /^1 more at / });
    expect(marker).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog', { name: /1 more$/ })).toBeNull();
  });
});
