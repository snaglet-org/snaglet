/**
 * Repeats on the calendar (docs/architecture.md): overdue from the server, and
 * "Repeat…" opening the table's repeat editor. The table APIs are mocked at
 * the wire.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import type { Calendar, CalendarOccurrence, CalendarRowOccurrence } from '@snaglet/shared/types';
import { createTableRepeat, type TableRepeat } from '@snaglet/shared/utils';

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
const tables = vi.hoisted(() => ({ fields: vi.fn(), history: vi.fn(), entry: vi.fn() }));
vi.mock('@desktop/utils/api', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api')>();
  return { ...actual, tablesApi: { ...actual.tablesApi, ...tables } };
});
const repeats = vi.hoisted(() => ({
  get: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
  undoOccurrence: vi.fn(),
}));
vi.mock('@desktop/utils/api/tableRepeats', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api/tableRepeats')>();
  return { ...actual, tableRepeatsApi: { ...actual.tableRepeatsApi, ...repeats } };
});
const history = vi.hoisted(() => ({ stepTableHistory: vi.fn() }));
// The real newestTableStep reads the mocked tablesApi.history.
vi.mock('@desktop/features/database/tableHistory', async (orig) => ({
  ...(await orig<typeof import('@desktop/features/database/tableHistory')>()),
  ...history,
}));
vi.mock('@desktop/features/pane-find/PaneFindContext', () => ({ usePaneIsActive: () => true }));
vi.mock('../TableView/TableEntryModal', () => ({
  TableEntryModal: ({ entryId }: { entryId: string }) => (
    <div role="dialog" aria-label="Row">
      {entryId}
    </div>
  ),
}));

import { CalendarView } from './CalendarView';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
import { __resetCalendarUndoForTests } from '@desktop/features/calendar/calendarUndo';

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
        tableName: 'Habits',
        projectId: null,
        fieldId: 'f1',
        fieldName: 'When',
        fieldType: 'date',
        repeats: true,
        unscheduledCount: 0,
      },
    ],
  };
}

type RepeatInfo = NonNullable<CalendarRowOccurrence['repeat']>;

function row(
  title: string,
  key: string,
  time: CalendarRowOccurrence['time'],
  repeat: Partial<RepeatInfo> | null,
  extra: Partial<CalendarRowOccurrence> = {}
): CalendarOccurrence {
  return {
    source: 'row',
    key,
    calendarId: 'cal-default',
    title,
    time,
    status: 'upcoming',
    canMove: true,
    canResize: false,
    tableId: 't1',
    tableName: 'Habits',
    projectId: null,
    entryId: 'e1',
    fieldId: 'f1',
    range: false,
    hasEnd: false,
    entryRevision: 'r1',
    schemaVersion: 's1',
    ...(repeat
      ? {
          repeat: {
            occurrence: key.split(':').slice(3).join(':'),
            isCurrent: true,
            summary: '',
            ...repeat,
          },
        }
      : {}),
    ...extra,
  };
}

const days = (start: string, end: string) => ({
  kind: 'all_day' as const,
  startDate: start,
  endDate: end,
});

function make(input: Parameters<typeof createTableRepeat>[0]): TableRepeat {
  const created = createTableRepeat(input);
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

const view = (repeat: TableRepeat, log: unknown[] = []) => ({
  entryId: 'e1',
  revision: 'r2',
  repeats: { f1: repeat },
  log,
});

const step = { id: 'h1', label: 'Gym', state: 'done', tableIds: ['t1'] };

async function renderWith(
  occurrences: CalendarOccurrence[],
  zoom: 'week' | 'month' | 'day' = 'month'
) {
  api.occurrences.mockResolvedValue({ from: '', to: '', occurrences, unavailable: [] });
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({ anchor: '2026-10-14', zoom });
  render(<CalendarView />);
  await screen.findAllByRole('button', { name: new RegExp(`^${occurrences[0]!.title}`) });
}

function item(title: string) {
  return document.querySelector<HTMLElement>(`[data-calendar-item][aria-label^="${title},"]`)!;
}

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('CalendarView repeats', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0)); // Wed Oct 14, noon
    window.localStorage.clear();
    for (const group of [api, repeats, tables, history])
      Object.values(group).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    api.listCalendars.mockResolvedValue({ calendars: [cal()] });
    tables.history.mockResolvedValue({ undo: step, redo: null });
    tables.fields.mockResolvedValue({ fields: [] });
    tables.entry.mockReturnValue(new Promise(() => {}));
    history.stepTableHistory.mockResolvedValue(undefined);
    __resetCalendarUndoForTests();
  });
  afterEach(() => vi.useRealTimers());

  it('says when an interval row repeats too often to show every time in the view', async () => {
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [
        row(
          'Stretch',
          'row:f1:e1:2026-10-14T09:00:00',
          { kind: 'timed', start: '2026-10-14T09:00:00.000Z', end: '2026-10-14T09:30:00.000Z' },
          { summary: 'Every 1 min' }
        ),
      ],
      unavailable: [],
      truncated: [{ tableId: 't1', fieldId: 'f1', entryId: 'e1', title: 'Stretch', shown: 500 }],
    });
    __resetCalendarStoreForTests({ calendars: [cal()] });
    __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'week' });
    render(<CalendarView />);
    expect(
      await screen.findByText(
        '“Stretch” repeats too often to show every time in this week: only its first 500 are here'
      )
    ).toBeInTheDocument();
  });

  it('says when a row repeats more often than once a minute and is not drawn', async () => {
    api.occurrences.mockResolvedValue({
      from: '',
      to: '',
      occurrences: [],
      unavailable: [],
      truncated: [
        { tableId: 't1', fieldId: 'f1', entryId: 'e1', title: 'Ping', shown: 0, hidden: true },
      ],
    });
    __resetCalendarStoreForTests({ calendars: [cal()] });
    __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'week' });
    render(<CalendarView />);
    expect(
      await screen.findByText(
        '“Ping” repeats more often than once a minute: too frequent to show on the calendar'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/only its first/)).toBeNull();
  });

  describe('context menu', () => {
    it('Repeat… opens the Repeat panel at the item; a choice saves on Done', async () => {
      const rent = make({ date: '2026-10-01', rrule: 'FREQ=MONTHLY', tz: 'UTC' });
      repeats.get.mockResolvedValue(view(rent, []));
      tables.fields.mockResolvedValue({
        fields: [
          {
            id: 'f1',
            type: 'date',
            range: false,
            recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
          },
        ],
      });
      const daily = make({ date: '2026-10-01', rrule: 'FREQ=DAILY', tz: 'UTC' });
      repeats.set.mockResolvedValue({
        fieldId: 'f1',
        repeat: daily,
        logged: [],
        removed: [],
        changed: true,
      });
      await renderWith([
        row(
          'Pay rent',
          'row:f1:e4:2026-10-01',
          days('2026-10-01', '2026-10-02'),
          {
            summary: 'Every month on the 1st',
          },
          { entryId: 'e4' }
        ),
      ]);
      fireEvent.contextMenu(item('Pay rent'), { clientX: 100, clientY: 100 });
      const menu = await screen.findByRole('menu', { name: 'Pay rent actions' });
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Repeat…' }));
      const editor = await screen.findByRole('dialog', { name: 'Repeat Pay rent' });
      const monthly = await within(editor).findByRole('radio', {
        name: 'Every month on the 1st',
      });
      expect(monthly).toHaveAttribute('aria-checked', 'true');
      expect(repeats.get).toHaveBeenCalledWith('t1', 'e4');
      expect(tables.fields).toHaveBeenCalledWith('t1');
      fireEvent.click(within(editor).getByRole('radio', { name: 'Every day' }));
      expect(repeats.set).not.toHaveBeenCalled();
      fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(repeats.set).toHaveBeenCalledTimes(1));
      expect(repeats.set).toHaveBeenCalledWith('t1', 'e4', 'f1', {
        expectedRevision: 'r2',
        schemaVersion: 's1',
        expectedCurrent: '2026-10-01',
        rrule: 'FREQ=DAILY',
        date: '2026-10-01',
      });
      await waitFor(() =>
        expect(toast.showToast).toHaveBeenCalledWith(
          'Pay rent: Every day',
          expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
        )
      );
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Repeat Pay rent' })).toBeNull()
      );
    });

    it('Repeat… on a plain row of a repeating field starts a repeat', async () => {
      repeats.get.mockResolvedValue({ entryId: 'e7', revision: 'r9', repeats: {}, log: [] });
      repeats.set.mockResolvedValue({
        fieldId: 'f1',
        repeat: null,
        logged: [],
        removed: [],
        changed: true,
      });
      await renderWith([
        row('Dentist', 'row:f1:e7:value', days('2026-10-15', '2026-10-16'), null, {
          entryId: 'e7',
        }),
      ]);
      fireEvent.contextMenu(item('Dentist'), { clientX: 100, clientY: 100 });
      fireEvent.click(
        within(await screen.findByRole('menu', { name: 'Dentist actions' })).getByRole('menuitem', {
          name: 'Repeat…',
        })
      );
      const editor = await screen.findByRole('dialog', { name: 'Repeat Dentist' });
      fireEvent.click(await within(editor).findByRole('radio', { name: 'Every week on Thursday' }));
      fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(repeats.set).toHaveBeenCalledTimes(1));
      expect(repeats.set.mock.calls[0]![3]).toMatchObject({
        expectedRevision: 'r9',
        expectedCurrent: null,
        rrule: 'FREQ=WEEKLY;BYDAY=TH',
        date: '2026-10-15',
      });
    });

    it('Doesn’t repeat clears the repeat', async () => {
      const rent = make({ date: '2026-10-01', rrule: 'FREQ=MONTHLY', tz: 'UTC' });
      repeats.get.mockResolvedValue(view(rent, []));
      repeats.clear.mockResolvedValue({
        fieldId: 'f1',
        repeat: null,
        logged: [],
        removed: [],
        changed: true,
      });
      await renderWith([
        row(
          'Pay rent',
          'row:f1:e4:2026-10-01',
          days('2026-10-01', '2026-10-02'),
          {
            summary: 'Every month on the 1st',
          },
          { entryId: 'e4' }
        ),
      ]);
      fireEvent.contextMenu(item('Pay rent'), { clientX: 100, clientY: 100 });
      fireEvent.click(
        within(await screen.findByRole('menu', { name: 'Pay rent actions' })).getByRole(
          'menuitem',
          { name: 'Repeat…' }
        )
      );
      const editor = await screen.findByRole('dialog', { name: 'Repeat Pay rent' });
      fireEvent.click(await within(editor).findByRole('radio', { name: 'Doesn’t repeat' }));
      fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(repeats.clear).toHaveBeenCalledTimes(1));
      expect(repeats.clear).toHaveBeenCalledWith('t1', 'e4', 'f1', {
        expectedRevision: 'r2',
        schemaVersion: 's1',
        expectedCurrent: '2026-10-01',
      });
      await waitFor(() =>
        expect(toast.showToast).toHaveBeenCalledWith('Pay rent: Doesn’t repeat', expect.anything())
      );
    });

    it('rows of a field that doesn’t repeat get no Repeat…', async () => {
      __resetCalendarStoreForTests({ calendars: [{ ...cal(), boundFields: [] }] });
      api.occurrences.mockResolvedValue({
        from: '',
        to: '',
        occurrences: [row('Dentist', 'row:f1:e7:value', days('2026-10-15', '2026-10-16'), null)],
        unavailable: [],
      });
      __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'month' });
      api.listCalendars.mockResolvedValue({ calendars: [{ ...cal(), boundFields: [] }] });
      render(<CalendarView />);
      await screen.findAllByRole('button', { name: /^Dentist/ });
      fireEvent.contextMenu(item('Dentist'), { clientX: 100, clientY: 100 });
      const menu = await screen.findByRole('menu', { name: 'Dentist actions' });
      expect(within(menu).queryByRole('menuitem', { name: 'Repeat…' })).toBeNull();
    });
  });
});
