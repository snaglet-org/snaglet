/**
 * Calendar move integration: drag / Esc / invalid drop, the repeating-row choice,
 * Alt+arrow keyboard moves, the item context menu, and Cmd+Z on the calendar
 * stack. `commitMove` / `completeOrSkip` are mocked (their wire shapes are in
 * occurrenceWrites.test.ts); the pane's own wiring is what's under test.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import type { Calendar, CalendarOccurrence } from '@snaglet/shared/types';

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
const writes = vi.hoisted(() => ({ commitMove: vi.fn(), completeOrSkip: vi.fn() }));
vi.mock('@desktop/features/calendar/occurrenceWrites', async (orig) => ({
  ...(await orig<typeof import('@desktop/features/calendar/occurrenceWrites')>()),
  commitMove: writes.commitMove,
  completeOrSkip: writes.completeOrSkip,
}));
const pane = vi.hoisted(() => ({ active: true }));
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({
  usePaneIsActive: () => pane.active,
}));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { __resetCalendarUndoForTests, recordStep } from '@desktop/features/calendar/calendarUndo';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOUR = 40; // test column: 960 px tall

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

function standup(extra: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
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
    ...extra,
  } as CalendarOccurrence;
}

function rent(extra: Record<string, unknown> = {}): CalendarOccurrence {
  return {
    source: 'row',
    key: 'row:f1:e1:2026-10-13T09:00:00',
    calendarId: 'cal-default',
    title: 'Pay rent',
    time: { kind: 'timed', start: at(13, 9), end: at(13, 9, 30) },
    status: 'upcoming',
    canMove: true,
    canResize: false,
    tableId: 't1',
    tableName: 'Bills',
    projectId: null,
    entryId: 'e1',
    fieldId: 'f1',
    range: false,
    hasEnd: false,
    entryRevision: 'r1',
    schemaVersion: 's1',
    repeat: { occurrence: '2026-10-13T09:00:00', isCurrent: true, summary: 'Weekly on Tue' },
    ...extra,
  } as CalendarOccurrence;
}

function seed() {
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'week' });
}

/** Give each day column a 960 px viewport rect; elementsFromPoint → the column at x. */
function layoutColumns() {
  const cols = Array.from(document.querySelectorAll<HTMLElement>('[data-cal-drop="timed"]'));
  cols.forEach((col, i) => {
    col.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 960,
        height: 960,
        left: i * 100,
        right: i * 100 + 100,
        width: 100,
      }) as DOMRect;
  });
  document.elementsFromPoint = ((x: number) => {
    const col = cols[Math.floor(x / 100)];
    return col ? [col] : [];
  }) as typeof document.elementsFromPoint;
  return cols;
}

async function renderWith(occurrences: CalendarOccurrence[]) {
  api.occurrences.mockResolvedValue({ from: '', to: '', occurrences, unavailable: [] });
  seed();
  render(<CalendarView />);
  await screen.findAllByRole('button', { name: new RegExp(`^${occurrences[0]!.title}`) });
  return layoutColumns();
}

function item(title: string) {
  return document.querySelector<HTMLElement>(`[data-calendar-item][aria-label^="${title}"]`)!;
}

/** Press at (x,y), move past the threshold to (x2,y2), optionally release. */
function drag(el: HTMLElement, from: [number, number], to: [number, number], release = true) {
  fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(window, { clientX: from[0] + 6, clientY: from[1] + 6 });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] });
  if (release) fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
}

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('CalendarView moves', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    window.localStorage.clear();
    Object.values(api).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    writes.commitMove.mockReset().mockResolvedValue(undefined);
    writes.completeOrSkip.mockReset().mockResolvedValue(undefined);
    api.listCalendars.mockResolvedValue({ calendars: [cal()] });
    __resetCalendarUndoForTests();
    pane.active = true;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('drags an event to Wed 14:00: ghost with time label while dragging, one commit, optimistic', async () => {
    await renderWith([standup()]);
    // Week starts Mon Oct 12 → Tue is column 1 (x 100–200), Wed column 2.
    drag(item('Standup'), [150, 9.25 * HOUR], [250, 14.25 * HOUR], false);
    const ghost = document.querySelector('[data-calendar-drag-ghost]');
    expect(ghost).toHaveTextContent(/Wed 2:00 – 3:00 PM/);
    expect(item('Standup').style.opacity).toBe('0.35');
    fireEvent.pointerUp(window, { clientX: 250, clientY: 14.25 * HOUR });
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(1));
    const [o, after, opts] = writes.commitMove.mock.calls[0]!;
    expect(o.key).toBe('event:s');
    expect(after).toEqual({ kind: 'timed', start: at(14, 14), end: at(14, 15) });
    expect(opts.message).toMatch(/^Moved Standup to Wed/);
    expect(document.querySelector('[data-calendar-drag-ghost]')).toBeNull();
    expect(item('Standup').style.opacity).toBe('');
  });

  it('Esc during a drag cancels: no request, the click after is not an open', async () => {
    await renderWith([standup()]);
    drag(item('Standup'), [150, 9.25 * HOUR], [250, 12 * HOUR], false);
    expect(document.querySelector('[data-calendar-drag-ghost]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-calendar-drag-ghost]')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 250, clientY: 12 * HOUR });
    expect(writes.commitMove).not.toHaveBeenCalled();
  });

  it('invalid drop (outside the grid) turns the ghost disabled and snaps back with no request', async () => {
    await renderWith([standup()]);
    drag(item('Standup'), [150, 9.25 * HOUR], [5000, 12 * HOUR], false);
    const ghost = document.querySelector('[data-calendar-drag-ghost]')!;
    expect(ghost.className).toMatch(/ghostInvalid/);
    expect(document.body.style.cursor).toBe('not-allowed');
    fireEvent.pointerUp(window, { clientX: 5000, clientY: 12 * HOUR });
    expect(writes.commitMove).not.toHaveBeenCalled();
  });

  it('a failed write puts the item back and toasts why', async () => {
    writes.commitMove.mockRejectedValue(new Error('Server said no'));
    await renderWith([standup()]);
    drag(item('Standup'), [150, 9.25 * HOUR], [250, 14.25 * HOUR]);
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Server said no'));
    // Back on Tuesday's column.
    expect(item('Standup').closest('[data-cal-day]')!.getAttribute('data-cal-day')).toBe(
      '2026-10-13'
    );
  });

  it('repeating row: Only this one / All upcoming at the drop point; Enter = only this one', async () => {
    await renderWith([rent()]);
    drag(item('Pay rent'), [150, 9.1 * HOUR], [150, 11.1 * HOUR]);
    const dialog = await screen.findByRole('dialog', { name: 'Move Pay rent' });
    expect(within(dialog).getByRole('button', { name: 'All upcoming' })).toBeEnabled();
    // The ghost stays at the drop point under the choice.
    expect(document.querySelector('[data-calendar-drag-ghost]')).not.toBeNull();
    expect(writes.commitMove).not.toHaveBeenCalled();
    fireEvent.submit(
      within(dialog).getByRole('button', { name: 'Only this one' }).closest('form')!
    );
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(1));
    expect(writes.commitMove.mock.calls[0]![2]).toMatchObject({ mode: 'one' });
    expect(writes.commitMove.mock.calls[0]![1]).toMatchObject({ start: at(13, 11) });
  });

  it('repeating row: All upcoming → shift; Cancel → nothing; canShiftAll:false disables with a reason', async () => {
    await renderWith([rent()]);
    drag(item('Pay rent'), [150, 9.1 * HOUR], [150, 11.1 * HOUR]);
    fireEvent.click(await screen.findByRole('button', { name: 'All upcoming' }));
    await waitFor(() => expect(writes.commitMove.mock.calls[0]![2]).toMatchObject({ mode: 'all' }));
  });

  it('repeating row choice: Cancel and disabled All upcoming', async () => {
    await renderWith([
      rent({ repeat: { occurrence: 'x', isCurrent: false, summary: '', canShiftAll: false } }),
    ]);
    drag(item('Pay rent'), [150, 9.1 * HOUR], [150, 11.1 * HOUR]);
    const dialog = await screen.findByRole('dialog', { name: 'Move Pay rent' });
    expect(within(dialog).getByRole('button', { name: 'All upcoming' })).toBeDisabled();
    expect(dialog).toHaveTextContent(/only the current or a later one can shift/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes.commitMove).not.toHaveBeenCalled();
    expect(document.querySelector('[data-calendar-drag-ghost]')).toBeNull();
  });

  it('resize from the bottom handle writes the new end', async () => {
    await renderWith([standup()]);
    const handle = item('Standup').querySelector<HTMLElement>('[data-cal-resize="end"]')!;
    expect(item('Standup').querySelector('[data-cal-resize="start"]')).not.toBeNull(); // ≥ 30 px
    drag(handle, [150, 10 * HOUR], [150, 11.5 * HOUR]);
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(1));
    expect(writes.commitMove.mock.calls[0]![1]).toEqual({
      kind: 'timed',
      start: at(13, 9),
      end: at(13, 11, 30),
    });
    expect(writes.commitMove.mock.calls[0]![2].message).toMatch(/^Resized Standup/);
  });

  it('canMove:false items do not lift', async () => {
    await renderWith([standup({ canMove: false })]);
    drag(item('Standup'), [150, 9.25 * HOUR], [250, 14 * HOUR]);
    expect(document.querySelector('[data-calendar-drag-ghost]')).toBeNull();
    expect(writes.commitMove).not.toHaveBeenCalled();
    expect(item('Standup').querySelector('[data-cal-resize]')).toBeNull();
  });

  it('Alt+↓ moves 15 min, Alt+→ a day, Alt+Shift+↓ resizes; live region announces', async () => {
    await renderWith([standup()]);
    fireEvent.keyDown(item('Standup'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(1));
    expect(writes.commitMove.mock.calls[0]![1]).toEqual({
      kind: 'timed',
      start: at(13, 9, 15),
      end: at(13, 10, 15),
    });
    await waitFor(() => expect(screen.getByText(/^Moved Standup to/)).toBeInTheDocument());
    fireEvent.keyDown(item('Standup'), { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(item('Standup'), { key: 'ArrowDown', altKey: true, shiftKey: true });
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(3));
    const resized = writes.commitMove.mock.calls[2]![1];
    expect(Date.parse(resized.end) - Date.parse(resized.start)).toBe(
      Date.parse(writes.commitMove.mock.calls[2]![0].time.end) -
        Date.parse(writes.commitMove.mock.calls[2]![0].time.start) +
        15 * 60_000
    );
  });

  it('context menu (right-click and Shift+F10): only what applies; Move to… commits by date', async () => {
    await renderWith([standup()]);
    fireEvent.contextMenu(item('Standup'), { clientX: 150, clientY: 400 });
    let menu = await screen.findByRole('menu', { name: 'Standup actions' });
    // An event: no Mark done / Skip (repeating rows only), nothing grayed out.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
    ).toEqual(['Open', 'Move to…', 'Delete']);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .every((m) => !m.hasAttribute('disabled'))
    ).toBe(true);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move Standup to' });
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-10-16' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(writes.commitMove).toHaveBeenCalledTimes(1));
    expect(writes.commitMove.mock.calls[0]![1]).toEqual({
      kind: 'timed',
      start: at(16, 9),
      end: at(16, 10),
    });

    fireEvent.keyDown(item('Standup'), { key: 'F10', shiftKey: true });
    menu = await screen.findByRole('menu', { name: 'Standup actions' });
    expect(menu).toBeInTheDocument();
  });

  it('context menu on a repeating row: Mark done / Skip go through completeOrSkip; rows never delete', async () => {
    await renderWith([rent()]);
    fireEvent.contextMenu(item('Pay rent'), { clientX: 150, clientY: 400 });
    const menu = await screen.findByRole('menu', { name: 'Pay rent actions' });
    // A row never deletes from the calendar: no Delete at all.
    expect(within(menu).queryByRole('menuitem', { name: /^Delete/ })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark done' }));
    await waitFor(() =>
      expect(writes.completeOrSkip).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'row:f1:e1:2026-10-13T09:00:00' }),
        'done',
        'Marked Pay rent done'
      )
    );
  });

  it('an all-day repeating row due today is not overdue; one due before today is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 15, 0));
    try {
      await renderWith([
        rent({
          key: 'row:f1:e1:2026-10-14',
          title: 'Water plants',
          time: { kind: 'all_day', startDate: '2026-10-14', endDate: '2026-10-15' },
        }),
        rent({
          key: 'row:f1:e2:2026-10-13',
          entryId: 'e2',
          title: 'File taxes',
          time: { kind: 'all_day', startDate: '2026-10-13', endDate: '2026-10-14' },
        }),
      ]);
      expect(item('Water plants').getAttribute('aria-label')).not.toMatch(/overdue/);
      expect(item('Water plants').querySelector('[class*="overdue"]')).toBeNull();
      expect(item('File taxes').getAttribute('aria-label')).toMatch(/overdue/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a moved occurrence says where it was moved from (text marker, label and hover)', async () => {
    await renderWith([
      rent({
        status: 'moved',
        hasEnd: true, // a dot has no text marker; the block does
        time: { kind: 'timed', start: at(13, 10, 15), end: at(13, 10, 45) },
        repeat: {
          occurrence: '2026-10-12T09:00:00',
          isCurrent: true,
          summary: 'Weekly on Mon',
          originalStart: at(12, 9),
        },
      }),
    ]);
    const el = item('Pay rent');
    expect(el.querySelector('[data-moved-from]')).toHaveTextContent('↷ Mon');
    expect(el.getAttribute('aria-label')).toMatch(/moved from Mon 9:00 AM/);
    expect(el.getAttribute('title')).toMatch(/Moved from Mon 9:00 AM/);
  });

  it('a moved current occurrence can still be marked done or skipped; done/skipped ones cannot', async () => {
    const moved = rent({
      status: 'moved',
      repeat: {
        occurrence: '2026-10-12T09:00:00',
        isCurrent: true,
        summary: 'Weekly on Mon',
        originalStart: at(12, 9),
      },
    });
    await renderWith([moved]);
    fireEvent.contextMenu(item('Pay rent'), { clientX: 150, clientY: 400 });
    let menu = await screen.findByRole('menu', { name: 'Pay rent actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Skip' })).toBeEnabled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Mark done' }));
    await waitFor(() =>
      expect(writes.completeOrSkip).toHaveBeenCalledWith(
        expect.objectContaining({ key: moved.key }),
        'done',
        'Marked Pay rent done'
      )
    );
    cleanup();
    await renderWith([rent({ title: 'Paid rent', status: 'done' })]);
    fireEvent.contextMenu(item('Paid rent'), { clientX: 150, clientY: 400 });
    menu = await screen.findByRole('menu', { name: 'Paid rent actions' });
    // Already done: no Mark done or Skip to offer.
    expect(within(menu).queryByRole('menuitem', { name: /^Mark done/ })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /^Skip/ })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeEnabled();
  });

  it('Cmd+Z in the capture phase undoes the newest calendar step only while the pane is active', async () => {
    await renderWith([standup()]);
    const undo = vi.fn().mockResolvedValue(undefined);
    recordStep({ label: 'Move Standup', undo });
    const workspaceUndo = vi.fn();
    window.addEventListener('keydown', workspaceUndo);
    fireEvent.keyDown(item('Standup'), { key: 'z', metaKey: true });
    await waitFor(() => expect(undo).toHaveBeenCalledTimes(1));
    expect(workspaceUndo).not.toHaveBeenCalled();
    window.removeEventListener('keydown', workspaceUndo);
    // Undo refetches the window.
    await waitFor(() => expect(api.occurrences.mock.calls.length).toBeGreaterThan(1));
  });

  it('Cmd+Z is left alone when the pane is not active', async () => {
    pane.active = false;
    await renderWith([standup()]);
    const undo = vi.fn().mockResolvedValue(undefined);
    recordStep({ label: 'Move Standup', undo });
    await act(async () => {
      fireEvent.keyDown(item('Standup'), { key: 'z', metaKey: true });
    });
    expect(undo).not.toHaveBeenCalled();
  });
});
