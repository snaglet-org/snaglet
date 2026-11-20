/**
 * Range rows (End date on) on the calendar, end to end through the real
 * `commitMove`: dragging a date range's right edge (Week all-day lane and
 * Month), a datetime range's end across days, Alt+Shift+→, and a repeating
 * range row's resize, which is one plain entry update with no "Only this
 * one / All upcoming" choice. The table API is mocked at the wire.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const tables = vi.hoisted(() => ({ updateEntry: vi.fn(), history: vi.fn() }));
vi.mock('@desktop/utils/api', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api')>();
  return { ...actual, tablesApi: { ...actual.tablesApi, ...tables } };
});
const repeats = vi.hoisted(() => ({ move: vi.fn(), shift: vi.fn() }));
vi.mock('@desktop/utils/api/tableRepeats', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api/tableRepeats')>();
  return { ...actual, tableRepeatsApi: { ...actual.tableRepeatsApi, ...repeats } };
});
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({ usePaneIsActive: () => true }));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOUR = 40; // test column: 960 px tall
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
    boundFields: [],
  } as Calendar;
}

/** A row of a range field, its own end included. */
function rangeRow(extra: Record<string, unknown> = {}): CalendarOccurrence {
  return {
    source: 'row',
    key: 'row:f1:e1:value',
    calendarId: 'cal-default',
    title: 'Trip',
    time: { kind: 'all_day', startDate: '2026-10-13', endDate: '2026-10-16' },
    status: 'upcoming',
    canMove: true,
    canResize: true,
    tableId: 't1',
    tableName: 'Plans',
    projectId: null,
    entryId: 'e1',
    fieldId: 'f1',
    range: true,
    hasEnd: true,
    entryRevision: 'r1',
    schemaVersion: 's1',
    ...extra,
  } as CalendarOccurrence;
}

/** Elements matching `selector` get a 100 × 100 px cell each (7 per row); the pointer finds them. */
function layout(selector: string, perRow = 7, height = 100) {
  const cells = Array.from(document.querySelectorAll<HTMLElement>(selector));
  cells.forEach((cell, i) => {
    const x = (i % perRow) * 100;
    const y = Math.floor(i / perRow) * height;
    cell.getBoundingClientRect = () =>
      ({ top: y, bottom: y + height, height, left: x, right: x + 100, width: 100 }) as DOMRect;
  });
  document.elementsFromPoint = ((x: number, y: number) => {
    const cell = cells[Math.floor(y / height) * perRow + Math.floor(x / 100)];
    return cell ? [cell] : [];
  }) as typeof document.elementsFromPoint;
}

async function renderWith(occurrences: CalendarOccurrence[], zoom: 'week' | 'month' = 'week') {
  api.occurrences.mockResolvedValue({ from: '', to: '', occurrences, unavailable: [] });
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({ anchor: '2026-10-14', zoom });
  render(<CalendarView />);
  await screen.findAllByRole('button', { name: new RegExp(`^${occurrences[0]!.title}`) });
}

function item(title: string) {
  return document.querySelector<HTMLElement>(`[data-calendar-item][aria-label^="${title}"]`)!;
}

function endHandle(title: string) {
  return item(title).querySelector<HTMLElement>('[data-cal-resize="end"]')!;
}

function drag(el: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, { button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(window, { clientX: from[0] + 6, clientY: from[1] + 6 });
  fireEvent.pointerMove(window, { clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(window, { clientX: to[0], clientY: to[1] });
}

const step = { id: 'h1', label: 'Edit Trip', state: 'done', tableIds: ['t1'] };

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('CalendarView range rows', () => {
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    window.localStorage.clear();
    Object.values(api).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    tables.updateEntry.mockReset().mockResolvedValue({});
    tables.history.mockReset().mockResolvedValue({ undo: step, redo: null });
    repeats.move.mockReset();
    repeats.shift.mockReset();
    api.listCalendars.mockResolvedValue({ calendars: [cal()] });
    __resetCalendarUndoForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('drags a date range’s right edge in the all-day lane: one entry update, end day included', async () => {
    await renderWith([rangeRow()]);
    layout('[data-cal-drop="allday"]');
    expect(item('Trip').querySelector('[data-cal-resize="start"]')).toBeNull();
    // Week of Mon Oct 12: the trip ends Thu (column 3); drop on Sat (column 5).
    drag(endHandle('Trip'), [390, 10], [550, 10]);
    await waitFor(() => expect(tables.updateEntry).toHaveBeenCalledTimes(1));
    expect(tables.updateEntry).toHaveBeenCalledWith('t1', 'e1', {
      values: { f1: '2026-10-13/2026-10-17' },
      schemaVersion: 's1',
      expectedRevision: 'r1',
    });
    expect(toast.showToast).toHaveBeenCalledWith(
      'Resized Trip to Tue Oct 13 – Sat Oct 17',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );
  });

  it('drags a date range’s right edge in Month back onto its first day: a single day', async () => {
    await renderWith([rangeRow()], 'month');
    // Month of Oct 2026, weeks from Mon Sep 28: Oct 13 is row 2, column 1.
    layout('[data-cal-drop="month"]');
    drag(endHandle('Trip'), [390, 250], [150, 250]);
    await waitFor(() => expect(tables.updateEntry).toHaveBeenCalledTimes(1));
    expect(tables.updateEntry.mock.calls[0]![2].values).toEqual({ f1: '2026-10-13' });
  });

  it('a plain date row and an event keep no right-edge handle', async () => {
    await renderWith([
      rangeRow({ range: false, hasEnd: false, canResize: false, title: 'Due' }),
      {
        source: 'event',
        key: 'event:o',
        eventId: 'o',
        revision: 1,
        calendarId: 'cal-default',
        title: 'Offsite',
        time: { kind: 'all_day', startDate: '2026-10-14', endDate: '2026-10-15' },
        status: 'upcoming',
        canMove: true,
        canResize: false,
      },
    ]);
    expect(item('Due').querySelector('[data-cal-resize]')).toBeNull();
    expect(item('Offsite').querySelector('[data-cal-resize]')).toBeNull();
  });

  it('drags a datetime range’s end onto a later day', async () => {
    await renderWith([
      rangeRow({ title: 'Shift', time: { kind: 'timed', start: at(13, 9), end: at(13, 10) } }),
    ]);
    layout('[data-cal-drop="timed"]', 7, 960);
    // Tue 9–10 → drag the end to Thu 17:00 (column 3).
    drag(endHandle('Shift'), [150, 10 * HOUR], [350, 17 * HOUR]);
    await waitFor(() => expect(tables.updateEntry).toHaveBeenCalledTimes(1));
    expect(tables.updateEntry.mock.calls[0]![2].values).toEqual({
      f1: `${at(13, 9)}/${at(15, 17)}`,
    });
  });

  it('Alt+Shift+→ stretches a date range by a day', async () => {
    await renderWith([rangeRow()]);
    fireEvent.keyDown(item('Trip'), { key: 'ArrowRight', altKey: true, shiftKey: true });
    await waitFor(() => expect(tables.updateEntry).toHaveBeenCalledTimes(1));
    expect(tables.updateEntry.mock.calls[0]![2].values).toEqual({ f1: '2026-10-13/2026-10-16' });
  });

  it('a repeating range row’s resize writes the end in one entry update and asks nothing', async () => {
    await renderWith([
      rangeRow({
        key: 'row:f1:e1:2026-10-13T09:00:00',
        title: 'Standup',
        time: { kind: 'timed', start: at(13, 9), end: at(13, 10) },
        repeat: { occurrence: '2026-10-13T09:00:00', isCurrent: true, summary: 'Weekly on Tue' },
      }),
    ]);
    layout('[data-cal-drop="timed"]', 7, 960);
    drag(endHandle('Standup'), [150, 10 * HOUR], [150, 11.5 * HOUR]);
    await waitFor(() => expect(tables.updateEntry).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tables.updateEntry.mock.calls[0]![2]).toEqual({
      values: { f1: `${at(13, 9)}/${at(13, 11, 30)}` },
      schemaVersion: 's1',
      expectedRevision: 'r1',
    });
    expect(repeats.move).not.toHaveBeenCalled();
    expect(repeats.shift).not.toHaveBeenCalled();
  });

  it('moving a datetime range keeps its length in one update; a single instant stays single', async () => {
    await renderWith([
      rangeRow({ title: 'Call', time: { kind: 'timed', start: at(13, 9), end: at(13, 11) } }),
      rangeRow({
        key: 'row:f1:e2:value',
        entryId: 'e2',
        title: 'Ping',
        hasEnd: false,
        time: { kind: 'timed', start: at(14, 15), end: at(14, 15, 30) },
      }),
    ]);
    layout('[data-cal-drop="timed"]', 7, 960);
    drag(item('Call'), [150, 9.25 * HOUR], [250, 14.25 * HOUR]);
    await waitFor(() => expect(tables.updateEntry).toHaveBeenCalledTimes(1));
    expect(tables.updateEntry.mock.calls[0]![2].values).toEqual({
      f1: `${at(14, 14)}/${at(14, 16)}`,
    });
    drag(item('Ping'), [250, 15.1 * HOUR], [250, 17.1 * HOUR]);
    await waitFor(() => expect(tables.updateEntry).toHaveBeenCalledTimes(2));
    expect(tables.updateEntry.mock.calls[1]![2].values).toEqual({ f1: at(14, 17) });
  });
});
