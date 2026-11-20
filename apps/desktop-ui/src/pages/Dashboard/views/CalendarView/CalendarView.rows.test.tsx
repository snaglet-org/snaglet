/**
 * Rows from the calendar, in the pane: quick add with a Table field makes a
 * row (one undo step) and shows its popover; clicking a row opens the row
 * popover, whose property edits are table edits (and calendar undo steps)
 * and whose Open full row opens the row window; picking a Table field in an
 * event's popover turns the event into a row, one undo putting it back.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setCalendarWeekStartForTests } from '@desktop/features/calendar/weekStart';
import type {
  Calendar,
  CalendarEvent,
  CalendarOccurrence,
  CalendarRowOccurrence,
  TableEntry,
  TableField,
  TableHistoryStep,
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
const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);
const tables = vi.hoisted(() => ({
  entries: vi.fn(),
  entry: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  createField: vi.fn(),
  fields: vi.fn(),
  history: vi.fn(),
}));
const archive = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock('@desktop/utils/api', async (orig) => {
  const actual = await orig<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, ...tables },
    archiveApi: { ...actual.archiveApi, ...archive },
  };
});
const history = vi.hoisted(() => ({ stepTableHistory: vi.fn() }));
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
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { FetchError } from '@desktop/utils/api';
import { __resetCalendarStoreForTests } from '@desktop/features/calendar/calendarStore';
import { __resetCalendarViewForTests } from '@desktop/features/calendar/calendarViewStore';
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
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';

function field(id: string, extra: Partial<TableField>): TableField {
  return {
    id,
    tableId: 'table-1',
    columnName: id,
    name: id,
    description: null,
    type: 'text',
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    range: false,
    options: null,
    position: 0,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    ...extra,
  };
}

const fields = [
  field('field-id', { name: 'ID', type: 'uuid', managed: true }),
  field('field-name', { name: 'Name', isTitle: true }),
  field('field-due', { name: 'Due', type: 'datetime', calendarId: 'cal-default' }),
  field('field-points', { name: 'Points', type: 'number' }),
  field('field-done', { name: 'Done', type: 'checkbox', defaultValue: false, nullable: false }),
];

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
        repeats: false,
        unscheduledCount: 0,
      },
    ],
  };
}

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

function step(id: string, kind: TableHistoryStep['kind']): TableHistoryStep {
  return {
    id,
    actor: { kind: 'user', id: 'user-1' },
    kind,
    label: `Step ${id}`,
    tableIds: ['table-1'],
    state: 'done',
    seq: 1,
    createdAt: '',
    updatedAt: '',
  };
}

function rowOccurrence(title: string, start: string): CalendarRowOccurrence {
  return {
    source: 'row',
    key: `row:field-due:${ENTRY_ID}:value`,
    calendarId: 'cal-default',
    title,
    time: { kind: 'timed', start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString() },
    status: 'upcoming',
    canMove: true,
    canResize: false,
    tableId: 'table-1',
    tableName: 'Test table',
    projectId: null,
    entryId: ENTRY_ID,
    fieldId: 'field-due',
    range: false,
    hasEnd: false,
    entryRevision: 'rev-1',
    schemaVersion: 'schema-1',
  };
}

const entry = (values: TableEntry['values'], revision = 'rev-1'): TableEntry => ({
  id: ENTRY_ID,
  createdAt: '',
  revision,
  values,
});
const entryResponse = (e: TableEntry) => ({
  entry: e,
  schemaVersion: 'schema-1',
  relatedEntries: {},
  relatedItems: {},
});

let shown: CalendarOccurrence[] = [];

const schemaOf = (list: TableField[]) => ({
  entries: [],
  fields: list,
  totalCount: 0,
  page: 1,
  pageSize: 10,
  schemaVersion: 'schema-1',
  relatedEntries: {},
  relatedItems: {},
});

function seed() {
  __resetCalendarStoreForTests({ calendars: [cal()] });
  __resetCalendarViewForTests({ anchor: '2026-10-14', zoom: 'week' });
}

function item(title: string) {
  return document.querySelector<HTMLElement>(`[data-calendar-item][aria-label^="${title},"]`);
}

async function pickField(dialog: HTMLElement, option: RegExp) {
  fireEvent.click(within(dialog).getByRole('button', { name: /^Table field:/ }));
  const list = await screen.findByRole('listbox', { name: 'Table field' });
  fireEvent.click(within(list).getByRole('option', { name: option }));
}

/** The toast's Undo for `message`. */
function toastUndo(message: string) {
  const call = toast.showToast.mock.calls.find(([text]) => text === message);
  expect(call).toBeDefined();
  return (call![1] as { action: { run: () => void } }).action.run;
}

// Weeks start on Monday here, whatever the machine's locale.
beforeEach(() => __setCalendarWeekStartForTests(1));
afterEach(() => __setCalendarWeekStartForTests(null));

describe('CalendarView rows from the calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
    window.localStorage.clear();
    for (const group of [api, tables, archive, history])
      Object.values(group).forEach((fn) => fn.mockReset());
    toast.showToast.mockReset();
    __resetCalendarUndoForTests();
    shown = [];
    api.listCalendars.mockResolvedValue({ calendars: [cal()] });
    api.occurrences.mockImplementation(async () => ({
      from: '',
      to: '',
      occurrences: shown,
      unavailable: [],
    }));
    tables.entries.mockResolvedValue(schemaOf(fields));
    tables.fields.mockResolvedValue({ fields });
    tables.createEntry.mockImplementation(async (_t: string, input: { values: object }) =>
      entryResponse(entry(input.values as TableEntry['values']))
    );
    tables.history.mockResolvedValue({ undo: step('h1', 'entry.create'), redo: null });
    history.stepTableHistory.mockResolvedValue(undefined);
    archive.restore.mockResolvedValue({});
  });
  afterEach(() => vi.useRealTimers());

  it('quick add with a Table field makes a row, shows its popover, and one Undo removes it', async () => {
    seed();
    render(<CalendarView />);
    fireEvent.keyDown(screen.getByRole('gridcell', { name: 'Wednesday, October 14, 9 AM' }), {
      key: 'Enter',
    });
    const dialog = await screen.findByRole('dialog', { name: 'New event' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Event title' }), {
      target: { value: 'Test row' },
    });
    await pickField(dialog, /Test table · Due/);
    const values = {
      'field-name': 'Test row',
      'field-due': at(14, 9),
      'field-points': null,
      'field-done': false,
    };
    tables.entry.mockResolvedValue(entryResponse(entry(values)));
    shown = [rowOccurrence('Test row', at(14, 9))];
    fireEvent.submit(within(dialog).getByRole('textbox', { name: 'Row title' }).closest('form')!);

    await waitFor(() => expect(tables.createEntry).toHaveBeenCalled());
    expect(tables.createEntry).toHaveBeenCalledWith('table-1', {
      id: expect.any(String),
      schemaVersion: 'schema-1',
      values,
    });
    expect(api.createEvent).not.toHaveBeenCalled();

    // The row's popover: its Name, date line, calendar · table · field, properties.
    const popover = await screen.findByRole('dialog', { name: 'Test row' });
    expect(within(popover).getByText('Default calendar · Test table · Due')).toBeInTheDocument();
    expect(
      within(popover).getByRole('button', { name: /^Due: Wed Oct 14, 9:00 AM/ })
    ).toBeInTheDocument();
    // A new row's properties are all empty, so they sit behind "Show N more".
    fireEvent.click(await within(popover).findByRole('button', { name: /^Show \d+ more$/ }));
    const props = await within(popover).findByLabelText('Properties');
    expect(props).toHaveTextContent('Points');
    expect(props).toHaveTextContent('Done');
    expect(props).not.toHaveTextContent('ID');
    expect(item('Test row')).not.toBeNull();
    // Focus lands in the popover (quick add's went with it).
    await waitFor(() =>
      expect(within(popover).getByRole('button', { name: 'Edit Name: Test row' })).toHaveFocus()
    );

    expect(calendarUndoState().undo).toBe('Step h1');
    toastUndo('Added Test row to Test table')();
    await waitFor(() =>
      expect(history.stepTableHistory).toHaveBeenCalledWith('undo', {
        expected: step('h1', 'entry.create'),
        tableId: 'table-1',
        rethrow: true,
      })
    );
  });

  it('clicking a row opens its popover: edits save as table edits, Open full row opens the row', async () => {
    shown = [rowOccurrence('Test row', at(14, 9))];
    tables.entry.mockResolvedValue(
      entryResponse(
        entry({ 'field-name': 'Test row', 'field-due': at(14, 9), 'field-points': null })
      )
    );
    tables.updateEntry.mockResolvedValue(
      entryResponse(
        entry({ 'field-name': 'Test row', 'field-due': at(14, 9), 'field-points': '3' }, 'rev-2')
      )
    );
    seed();
    render(<CalendarView />);
    await waitFor(() => expect(item('Test row')).not.toBeNull());
    fireEvent.click(item('Test row')!);
    const popover = await screen.findByRole('dialog', { name: 'Test row' });
    expect(tables.fields).toHaveBeenCalledWith('table-1');
    // A plain row: no Mark done / Skip, but Move to…
    fireEvent.click(within(popover).getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Move to…' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(within(popover).queryByRole('button', { name: 'Mark done' })).toBeNull();

    tables.history.mockResolvedValue({ undo: step('h2', 'entry.update'), redo: null });
    // Empty properties stay behind "Show N more".
    fireEvent.click(await within(popover).findByRole('button', { name: /^Show \d+ more$/ }));
    fireEvent.click(await within(popover).findByRole('button', { name: 'Edit Points' }));
    const input = within(popover).getByRole('textbox', { name: 'Points' });
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(tables.updateEntry).toHaveBeenCalledWith('table-1', ENTRY_ID, {
        values: { 'field-points': '3' },
        schemaVersion: 'schema-1',
        expectedRevision: 'rev-1',
      })
    );
    // On the calendar stack too, so Cmd+Z in the pane steps back through it.
    await waitFor(() => expect(calendarUndoState().undo).toBe('Step h2'));
    expect(await within(popover).findByRole('button', { name: 'Edit Points' })).toHaveTextContent(
      '3'
    );

    fireEvent.click(within(popover).getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open full row' }));
    expect(await screen.findByRole('dialog', { name: 'Row' })).toHaveTextContent(ENTRY_ID);
    expect(screen.queryByRole('dialog', { name: 'Test row' })).toBeNull();
  });

  it('a row with a time and no end is a dot, a row with an end is a block', async () => {
    shown = [rowOccurrence('Test row', at(14, 9))];
    seed();
    const { unmount } = render(<CalendarView />);
    await waitFor(() => expect(item('Test row')).not.toBeNull());
    expect(item('Test row')).toHaveAttribute('data-point');
    unmount();

    shown = [{ ...rowOccurrence('Test row', at(14, 9)), hasEnd: true, range: true }];
    seed();
    render(<CalendarView />);
    await waitFor(() => expect(item('Test row')).not.toBeNull());
    expect(item('Test row')).not.toHaveAttribute('data-point');
  });

  it('points at nearly one time draw as one "+N" mark that lists them', async () => {
    const point = (n: number, minute: number): CalendarOccurrence => ({
      ...rowOccurrence(`Merge ${n}`, at(14, 9, minute)),
      key: `row:field-due:entry-${n}:value`,
      entryId: `entry-${n}`,
    });
    shown = [point(1, 0), point(2, 1), point(3, 2)];
    seed();
    render(<CalendarView />);
    const group = await screen.findByRole('button', { name: '3 items, 9 AM–9:02 AM' });
    expect(group).toHaveTextContent('Merge 1+2');
    expect(item('Merge 2')).toBeNull();

    fireEvent.click(group);
    const list = await screen.findByRole('dialog', { name: /3 items$/ });
    for (const title of ['Merge 1', 'Merge 2', 'Merge 3'])
      expect(within(list).getByText(title)).toBeInTheDocument();
  });

  it('Escape in an open property editor cancels the edit, not the popover', async () => {
    shown = [rowOccurrence('Test row', at(14, 9))];
    tables.entry.mockResolvedValue(
      entryResponse(entry({ 'field-name': 'Test row', 'field-points': null }))
    );
    seed();
    render(<CalendarView />);
    await waitFor(() => expect(item('Test row')).not.toBeNull());
    fireEvent.click(item('Test row')!);
    const popover = await screen.findByRole('dialog', { name: 'Test row' });
    // Empty properties stay behind "Show N more".
    fireEvent.click(await within(popover).findByRole('button', { name: /^Show \d+ more$/ }));
    fireEvent.click(await within(popover).findByRole('button', { name: 'Edit Points' }));
    fireEvent.keyDown(within(popover).getByRole('textbox', { name: 'Points' }), {
      key: 'Escape',
    });
    expect(screen.getByRole('dialog', { name: 'Test row' })).toBeInTheDocument();
  });

  it('a press outside everything closes the popover with an open property editor, unsaved', async () => {
    shown = [rowOccurrence('Test row', at(14, 9))];
    tables.entry.mockResolvedValue(
      entryResponse(entry({ 'field-name': 'Test row', 'field-points': null }))
    );
    seed();
    render(<CalendarView />);
    await waitFor(() => expect(item('Test row')).not.toBeNull());
    fireEvent.click(item('Test row')!);
    const popover = await screen.findByRole('dialog', { name: 'Test row' });
    // Empty properties stay behind "Show N more".
    fireEvent.click(await within(popover).findByRole('button', { name: /^Show \d+ more$/ }));
    fireEvent.click(await within(popover).findByRole('button', { name: 'Edit Points' }));
    fireEvent.change(within(popover).getByRole('textbox', { name: 'Points' }), {
      target: { value: '5' },
    });

    // A press inside the popover, outside the editor, closes the editor only.
    fireEvent.pointerDown(within(popover).getByRole('button', { name: 'More actions' }));
    expect(within(popover).queryByRole('textbox', { name: 'Points' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Test row' })).toBeInTheDocument();

    // Outside everything: one press closes the editor and the popover.
    fireEvent.click(await within(popover).findByRole('button', { name: 'Edit Points' }));
    fireEvent.change(within(popover).getByRole('textbox', { name: 'Points' }), {
      target: { value: '7' },
    });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Test row' })).toBeNull());
    expect(tables.updateEntry).not.toHaveBeenCalled();
  });

  it('a row deleted by a batch while its popover is open shows as deleted, with no actions', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    shown = [rowOccurrence('Test row', at(14, 9))];
    tables.entry.mockResolvedValue(
      entryResponse(entry({ 'field-name': 'Test row', 'field-points': '2' }))
    );
    seed();
    render(<CalendarView />);
    await waitFor(() => expect(item('Test row')).not.toBeNull());
    fireEvent.click(item('Test row')!);
    const popover = await screen.findByRole('dialog', { name: 'Test row' });
    expect(await within(popover).findByRole('button', { name: 'Edit Points' })).toBeEnabled();

    // An agent deletes [other, this row] in one batch.
    tables.entry.mockRejectedValue(new FetchError('Entry not found', 404));
    shown = [];
    act(() =>
      emitTableEvent({
        type: 'table.entries.changed',
        tableId: 'table-1',
        entryId: other,
        entryIds: [other, ENTRY_ID],
      })
    );

    expect(await within(popover).findByRole('status')).toHaveTextContent('This row was deleted.');
    expect(within(popover).getByRole('button', { name: 'Points (read-only)' })).toBeDisabled();
    expect(within(popover).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(within(popover).queryByRole('button', { name: 'Move to…' })).toBeNull();
    expect(within(popover).queryByRole('button', { name: 'Open full row' })).toBeNull();
    expect(within(popover).queryByRole('alert')).toBeNull();
  });

  it('a row the calendar can’t move (a managed created_at) shows its date read-only', async () => {
    const created = field('field-created', { name: 'Created', type: 'datetime', managed: true });
    tables.fields.mockResolvedValue({ fields: [...fields, created] });
    shown = [
      {
        ...rowOccurrence('Test row', at(14, 9)),
        key: `row:field-created:${ENTRY_ID}:value`,
        fieldId: 'field-created',
        canMove: false,
      },
    ];
    tables.entry.mockResolvedValue(
      entryResponse(entry({ 'field-name': 'Test row', 'field-points': '2' }))
    );
    seed();
    render(<CalendarView />);
    await waitFor(() => expect(item('Test row')).not.toBeNull());
    fireEvent.click(item('Test row')!);
    const popover = await screen.findByRole('dialog', { name: 'Test row' });
    expect(
      await within(popover).findByRole('button', { name: /^Created: .*Read-only here$/ })
    ).toBeDisabled();
    // No Move button at all on a row that can't move.
    expect(within(popover).queryByRole('button', { name: /^Move to/ })).toBeNull();
    // The bound date is the date line, not a property row.
    expect(await within(popover).findByLabelText('Properties')).not.toHaveTextContent('Created');
  });

  describe('turning an event into a row', () => {
    const event = (): CalendarEvent => ({
      id: 'calendar-event-1',
      calendarId: 'cal-default',
      title: 'Test event',
      description: 'Agenda',
      location: '',
      time: { kind: 'timed', startAt: at(14, 9), endAt: at(14, 10), timeZone: ZONE },
      repeat: null,
      revision: 3,
      createdAt: '',
      updatedAt: '',
    });

    async function openEvent() {
      shown = [
        {
          source: 'event',
          key: 'event:calendar-event-1',
          eventId: 'calendar-event-1',
          revision: 3,
          calendarId: 'cal-default',
          title: 'Test event',
          time: { kind: 'timed', start: at(14, 9), end: at(14, 10) },
          status: 'upcoming',
          canMove: true,
          canResize: true,
        },
      ];
      api.getEvent.mockResolvedValue({ event: event() });
      seed();
      render(<CalendarView />);
      await waitFor(() => expect(item('Test event')).not.toBeNull());
      fireEvent.click(item('Test event')!);
      const dialog = await screen.findByRole('dialog', { name: 'Event' });
      await within(dialog).findByRole('textbox', { name: 'Event title' });
      return dialog;
    }

    it('moves its title, time and description into a new row, archives it, and one Undo puts it back', async () => {
      const dialog = await openEvent();
      const withDescription = [...fields, field('field-desc', { name: 'description' })];
      tables.entries
        .mockResolvedValueOnce(schemaOf(fields))
        .mockResolvedValue(schemaOf(withDescription));
      tables.createField.mockResolvedValue({ field: withDescription[withDescription.length - 1] });
      tables.history
        .mockResolvedValueOnce({ undo: step('h1', 'field.create'), redo: null })
        .mockResolvedValueOnce({ undo: step('h2', 'entry.create'), redo: null });
      api.deleteEvent.mockResolvedValue({ id: 'calendar-event-1' });
      tables.entry.mockResolvedValue(
        entryResponse(entry({ 'field-name': 'Test event', 'field-desc': 'Agenda' }))
      );
      shown = [rowOccurrence('Test event', at(14, 9))];

      await pickField(dialog, /Test table · Due/);

      await waitFor(() => expect(api.deleteEvent).toHaveBeenCalledWith('calendar-event-1', 3));
      expect(tables.createField).toHaveBeenCalledWith(
        'table-1',
        expect.objectContaining({ name: 'description', type: 'text' })
      );
      expect(tables.createEntry).toHaveBeenCalledWith(
        'table-1',
        expect.objectContaining({
          values: expect.objectContaining({
            'field-name': 'Test event',
            'field-due': at(14, 9),
            'field-desc': 'Agenda',
          }),
        })
      );
      // The event popover becomes the row's.
      expect(await screen.findByRole('dialog', { name: 'Test event' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'Event' })).toBeNull();

      const order: string[] = [];
      history.stepTableHistory.mockImplementation(
        async (dir: string, opts: { expected: TableHistoryStep }) => {
          order.push(`${dir} ${opts.expected.id}`);
        }
      );
      archive.restore.mockImplementation(async (id: string) => {
        order.push(`restore ${id}`);
        return {};
      });
      toastUndo('Moved to Test table · description. Added a description column to Test table')();
      await waitFor(() =>
        expect(order).toEqual(['undo h2', 'undo h1', 'restore calendar-event-1'])
      );
    });

    it('a failed conversion keeps the event and its popover', async () => {
      const dialog = await openEvent();
      tables.createField.mockResolvedValue({ field: field('field-desc', { name: 'description' }) });
      tables.createEntry.mockRejectedValue(new Error('Due is required.'));
      tables.history.mockResolvedValue({ undo: null, redo: null });
      await pickField(dialog, /Test table · Due/);
      await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Due is required.'));
      expect(api.deleteEvent).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Event' })).toBeInTheDocument();
    });
  });
});
