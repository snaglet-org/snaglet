/**
 * Rows shown from Snaglet's own `created_at` (a managed field) are read-only on
 * the calendar: the server sends `canMove: false, canResize: false` and no
 * repeat, and the pane offers no drag, no resize handle, no Alt+arrow move,
 * and a menu of Open alone (no Move to…, Done / Skip or Repeat…).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
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
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({
  usePaneIsActive: () => true,
}));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const HOUR = 40; // test column: 960 px tall
const CREATED = 'field-managed-t1-created_at';

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
        tableId: 't1',
        tableName: 'Tasks',
        projectId: null,
        fieldId: CREATED,
        fieldName: 'created_at',
        fieldType: 'datetime',
        repeats: false,
        unscheduledCount: 0,
      },
    ],
  };
}

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

/** A row placed by the managed `created_at`, as the occurrences feed sends it. */
const madeRow: CalendarOccurrence = {
  source: 'row',
  key: `row:${CREATED}:e1:value`,
  calendarId: 'cal-default',
  title: 'Write report',
  time: { kind: 'timed', start: at(13, 9), end: at(13, 9, 30) },
  status: 'upcoming',
  canMove: false,
  canResize: false,
  tableId: 't1',
  tableName: 'Tasks',
  projectId: null,
  entryId: 'e1',
  fieldId: CREATED,
  range: false,
  hasEnd: false,
  entryRevision: 'r1',
  schemaVersion: 's1',
};

function item(): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    '[data-calendar-item][aria-label^="Write report"]'
  );
  if (!found) throw new Error('row not drawn');
  return found;
}

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('CalendarView: rows of a managed date field are read-only', () => {
  beforeEach(async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    window.localStorage.clear();
    Object.values(api).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    writes.commitMove.mockReset().mockResolvedValue(undefined);
    writes.completeOrSkip.mockReset().mockResolvedValue(undefined);
    api.listCalendars.mockResolvedValue({ calendars: [cal()] });
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [madeRow],
      unavailable: [],
    });
    __resetCalendarUndoForTests();
    __resetCalendarStoreForTests({ calendars: [cal()] });
    __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'week' });
    render(<CalendarView />);
    await screen.findAllByRole('button', { name: /^Write report/ });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('has no resize handle and does not lift on drag', () => {
    expect(item().querySelector('[data-cal-resize]')).toBeNull();
    fireEvent.pointerDown(item(), { button: 0, clientX: 150, clientY: 9.25 * HOUR });
    fireEvent.pointerMove(window, { clientX: 156, clientY: 9.25 * HOUR + 6 });
    fireEvent.pointerMove(window, { clientX: 250, clientY: 14 * HOUR });
    fireEvent.pointerUp(window, { clientX: 250, clientY: 14 * HOUR });
    expect(document.querySelector('[data-calendar-drag-ghost]')).toBeNull();
    expect(writes.commitMove).not.toHaveBeenCalled();
  });

  it('Alt+arrows say it is read-only instead of moving it', () => {
    fireEvent.keyDown(item(), { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(item(), { key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(writes.commitMove).not.toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith('Write report is read-only here');
  });

  it('the menu offers only Open: no Move to…, Done, Skip or Repeat…', async () => {
    fireEvent.contextMenu(item(), { clientX: 150, clientY: 400 });
    const menu = await screen.findByRole('menu', { name: 'Write report actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent)
    ).toEqual(['Open']);
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeEnabled();
    expect(screen.queryByRole('dialog', { name: /^Move/ })).toBeNull();
    expect(writes.commitMove).not.toHaveBeenCalled();
    expect(writes.completeOrSkip).not.toHaveBeenCalled();
  });
});
