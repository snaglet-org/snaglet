/**
 * Rows from the calendar: how a slot lands in each date-field kind, quick
 * add's one create (and its undo), and turning an event into a row with its
 * description in the table's Description column (reused or added), its
 * location in a Location column or appended to the description, the event
 * archived, and one undo putting everything back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CalendarEvent,
  TableEntry,
  TableField,
  TableHistoryStep,
} from '@snaglet/shared/types';
import { tableNameProblem } from '@snaglet/shared/utils';

const tables = vi.hoisted(() => ({
  entries: vi.fn(),
  createEntry: vi.fn(),
  createField: vi.fn(),
  deleteField: vi.fn(),
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
const calendar = vi.hoisted(() => ({ deleteEvent: vi.fn(), getEvent: vi.fn() }));
vi.mock('./calendarApi', () => ({ calendarApi: calendar }));
const history = vi.hoisted(() => ({ stepTableHistory: vi.fn() }));
// The real newestTableStep reads the mocked tablesApi.history.
vi.mock('@desktop/features/database/tableHistory', async (orig) => ({
  ...(await orig<typeof import('@desktop/features/database/tableHistory')>()),
  ...history,
}));
vi.mock('@desktop/features/database/tableEvents', () => ({ emitTableEvent: vi.fn() }));

import {
  convertEventToRow,
  createdRowUndo,
  createRowAt,
  descriptionFieldFor,
  eventDescriptionText,
  locationFieldFor,
  rowDateValue,
  type RowTarget,
} from './rowCreate';

const NY = 'America/New_York';

function field(id: string, extra: Partial<TableField> = {}): TableField {
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

const nameField = field('field-name', { name: 'Name', isTitle: true });
const idField = field('field-id', { name: 'ID', type: 'uuid', managed: true });
const notes = field('field-notes', { name: 'Notes', defaultValue: 'none yet' });
const due = (type: 'date' | 'datetime', range = false) =>
  field('field-due', { name: 'Due', type, range });

const target: RowTarget = {
  tableId: 'table-1',
  tableName: 'Test table',
  fieldId: 'field-due',
  fieldName: 'Due',
  fieldType: 'date',
};

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

function schema(fields: TableField[], schemaVersion = 'schema-1') {
  return {
    entries: [],
    fields,
    totalCount: 0,
    page: 1,
    pageSize: 10,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  };
}

const entry = (values: TableEntry['values']): TableEntry => ({
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '',
  revision: 'rev-1',
  values,
});

const timed = (start: string, end: string) => ({ kind: 'timed' as const, start, end });
const allDay = (startDate: string, endDate: string) => ({
  kind: 'all_day' as const,
  startDate,
  endDate,
});

beforeEach(() => {
  for (const group of [tables, archive, calendar, history])
    Object.values(group).forEach((fn) => fn.mockReset());
  tables.createEntry.mockImplementation(async (_id: string, input: { values: object }) => ({
    entry: entry(input.values as TableEntry['values']),
    schemaVersion: 'schema-1',
    relatedEntries: {},
    relatedItems: {},
  }));
  history.stepTableHistory.mockResolvedValue(undefined);
  calendar.deleteEvent.mockResolvedValue({ id: 'calendar-event-1' });
  archive.restore.mockResolvedValue({});
});

describe('rowDateValue', () => {
  // Mon Oct 12 2026, 9:00–9:30 AM in New York (EDT, UTC−4).
  const nine = timed('2026-10-12T13:00:00.000Z', '2026-10-12T13:30:00.000Z');

  it('date: the start day; a timed slot reads its day in the zone', () => {
    expect(rowDateValue(due('date'), nine, NY)).toBe('2026-10-12');
    expect(rowDateValue(due('date'), allDay('2026-10-12', '2026-10-15'), NY)).toBe('2026-10-12');
    // 11 PM on the 12th in New York is the 13th in UTC.
    const late = timed('2026-10-13T03:00:00.000Z', '2026-10-13T03:30:00.000Z');
    expect(rowDateValue(due('date'), late, NY)).toBe('2026-10-12');
  });

  it('date & time: the start instant; an all-day slot starts at 00:00 in the zone', () => {
    expect(rowDateValue(due('datetime'), nine, NY)).toBe('2026-10-12T13:00:00.000Z');
    expect(rowDateValue(due('datetime'), allDay('2026-10-12', '2026-10-13'), NY)).toBe(
      '2026-10-12T04:00:00.000Z'
    );
  });

  it('date range: first / last day (end day included), one day without a slash', () => {
    expect(rowDateValue(due('date', true), allDay('2026-10-12', '2026-10-15'), NY)).toBe(
      '2026-10-12/2026-10-14'
    );
    expect(rowDateValue(due('date', true), allDay('2026-10-12', '2026-10-13'), NY)).toBe(
      '2026-10-12'
    );
    expect(rowDateValue(due('date', true), nine, NY)).toBe('2026-10-12');
    // A sweep from 10 PM to 1 AM the next day spans two days.
    const overnight = timed('2026-10-13T02:00:00.000Z', '2026-10-13T05:00:00.000Z');
    expect(rowDateValue(due('date', true), overnight, NY)).toBe('2026-10-12/2026-10-13');
    // Ending at midnight stays on the one day.
    const toMidnight = timed('2026-10-13T02:00:00.000Z', '2026-10-13T04:00:00.000Z');
    expect(rowDateValue(due('date', true), toMidnight, NY)).toBe('2026-10-12');
  });

  it('date & time range: start / end instants; an all-day slot is 00:00 to 00:00 after its last day', () => {
    expect(rowDateValue(due('datetime', true), nine, NY)).toBe(
      '2026-10-12T13:00:00.000Z/2026-10-12T13:30:00.000Z'
    );
    expect(rowDateValue(due('datetime', true), allDay('2026-10-12', '2026-10-14'), NY)).toBe(
      '2026-10-12T04:00:00.000Z/2026-10-14T04:00:00.000Z'
    );
  });
});

describe('createRowAt (quick add)', () => {
  const slot = timed('2026-10-12T13:00:00.000Z', '2026-10-12T14:00:00.000Z');

  it.each([
    ['date', false, '2026-10-12'],
    ['datetime', false, '2026-10-12T13:00:00.000Z'],
    ['date', true, '2026-10-12'],
    ['datetime', true, '2026-10-12T13:00:00.000Z/2026-10-12T14:00:00.000Z'],
  ] as const)(
    'a %s field (range %s) gets %s, the title its Name, the rest their defaults',
    async (type, range, value) => {
      tables.entries.mockResolvedValue(schema([idField, nameField, notes, due(type, range)]));
      tables.history.mockResolvedValue({ undo: step('h1', 'entry.create'), redo: null });
      const row = await createRowAt({ ...target, fieldType: type }, 'Test row', slot, NY);
      expect(tables.entries).toHaveBeenCalledWith('table-1', { pageSize: 10 });
      expect(tables.createEntry).toHaveBeenCalledWith('table-1', {
        id: expect.any(String),
        schemaVersion: 'schema-1',
        values: {
          'field-name': 'Test row',
          'field-notes': 'none yet',
          'field-due': value,
        },
      });
      expect(row.step?.id).toBe('h1');
      expect(row.dateField.id).toBe('field-due');
    }
  );

  it('refuses a field that is no longer a date field, writing nothing', async () => {
    tables.entries.mockResolvedValue(schema([nameField, field('field-due', { name: 'Due' })]));
    await expect(createRowAt(target, 'Test row', slot, NY)).rejects.toThrow(
      /isn't a date field any more/
    );
    expect(tables.createEntry).not.toHaveBeenCalled();
  });

  it('refuses a managed date field (created_at), writing nothing', async () => {
    tables.entries.mockResolvedValue(
      schema([nameField, field('field-due', { name: 'Created', type: 'datetime', managed: true })])
    );
    await expect(createRowAt(target, 'Test row', slot, NY)).rejects.toThrow(
      "Snaglet sets Test table · Due, so a row can't be added there."
    );
    expect(tables.createEntry).not.toHaveBeenCalled();
  });

  it('one undo step removes the row: exactly its create step, redo puts it back', async () => {
    tables.entries.mockResolvedValue(schema([nameField, due('date')]));
    const created = step('h1', 'entry.create');
    tables.history.mockResolvedValue({ undo: created, redo: null });
    const undo = createdRowUndo(await createRowAt(target, 'Test row', slot, NY));
    await undo!.undo();
    expect(history.stepTableHistory).toHaveBeenCalledWith('undo', {
      expected: created,
      tableId: 'table-1',
      rethrow: true,
    });
    await undo!.redo!();
    expect(history.stepTableHistory).toHaveBeenLastCalledWith('redo', {
      expected: { ...created, state: 'undone' },
      tableId: 'table-1',
      rethrow: true,
    });
  });

  it('no undo when the newest history step is not the create', async () => {
    tables.entries.mockResolvedValue(schema([nameField, due('date')]));
    tables.history.mockResolvedValue({ undo: step('h9', 'entry.update'), redo: null });
    expect(createdRowUndo(await createRowAt(target, 'Test row', slot, NY))).toBeNull();
  });
});

describe('descriptionFieldFor', () => {
  it('reuses a text field named Description, any case or spacing', () => {
    const desc = field('field-desc', { name: ' description ' });
    expect(descriptionFieldFor([nameField, desc])).toEqual({ field: desc, name: ' description ' });
  });

  it('names a new one Description, or Event description when something else owns the name', () => {
    expect(descriptionFieldFor([nameField])).toEqual({ field: null, name: 'description' });
    const numeric = field('field-desc', { name: 'description', type: 'number' });
    expect(descriptionFieldFor([nameField, numeric])).toEqual({
      field: null,
      name: 'event_description',
    });
    const title = field('field-name', { name: 'description', isTitle: true });
    expect(descriptionFieldFor([title]).name).toBe('event_description');
    const other = field('field-ev', { name: 'event_description' });
    expect(descriptionFieldFor([numeric, other]).field).toBe(other);
  });

  it('only proposes names a field may have (lowercase snake_case)', () => {
    const numeric = field('field-desc', { name: 'description', type: 'number' });
    for (const fields of [[nameField], [nameField, numeric]]) {
      expect(tableNameProblem(descriptionFieldFor(fields).name, 'field')).toBeNull();
    }
  });
});

describe('locationFieldFor / eventDescriptionText', () => {
  it('finds a text field named Location, any case, never the Name or another kind', () => {
    const place = field('field-place', { name: ' Location ' });
    expect(locationFieldFor([nameField, place])).toBe(place);
    expect(locationFieldFor([nameField])).toBeNull();
    expect(
      locationFieldFor([field('field-place', { name: 'location', type: 'number' })])
    ).toBeNull();
    expect(locationFieldFor([field('field-name', { name: 'location', isTitle: true })])).toBeNull();
  });

  it('appends the location as its own paragraph, or stands alone', () => {
    expect(eventDescriptionText('Agenda\n', ' Room 4 ')).toBe('Agenda\n\nLocation: Room 4');
    expect(eventDescriptionText('  ', 'Room 4')).toBe('Location: Room 4');
    expect(eventDescriptionText('Agenda', '')).toBe('Agenda');
    expect(eventDescriptionText(' \n', '  ')).toBe('');
  });
});

describe('convertEventToRow', () => {
  const event = (description: string, location = ''): CalendarEvent => ({
    id: 'calendar-event-1',
    calendarId: 'cal-1',
    title: 'Test event',
    description,
    location,
    time: {
      kind: 'all_day',
      startDate: '2026-10-12',
      endDate: '2026-10-14',
      timeZone: NY,
    },
    repeat: null,
    revision: 4,
    createdAt: '',
    updatedAt: '',
  });
  const rangeTarget = { ...target, fieldType: 'date' as const };

  it('reuses the table’s Description column, then archives the event', async () => {
    const desc = field('field-desc', { name: 'description' });
    tables.entries.mockResolvedValue(schema([nameField, desc, due('date', true)]));
    tables.history.mockResolvedValue({ undo: step('h1', 'entry.create'), redo: null });
    const result = await convertEventToRow(event('Agenda\nsecond line'), rangeTarget, NY);
    expect(tables.createField).not.toHaveBeenCalled();
    expect(tables.createEntry).toHaveBeenCalledWith('table-1', {
      id: expect.any(String),
      schemaVersion: 'schema-1',
      values: {
        'field-name': 'Test event',
        'field-desc': 'Agenda\nsecond line',
        'field-due': '2026-10-12/2026-10-13',
      },
    });
    expect(calendar.deleteEvent).toHaveBeenCalledWith('calendar-event-1', 4);
    expect(result.message).toBe('Moved to Test table · description');
    expect(result.addedField).toBe(false);
  });

  it('adds a Description text column when the table has none, and fills it', async () => {
    tables.entries
      .mockResolvedValueOnce(schema([nameField, due('date')]))
      .mockResolvedValueOnce(
        schema([nameField, due('date'), field('field-new', { name: 'description' })], 'schema-2')
      );
    tables.createField.mockResolvedValue({ field: field('field-new', { name: 'description' }) });
    tables.history
      .mockResolvedValueOnce({ undo: step('h1', 'field.create'), redo: null })
      .mockResolvedValueOnce({ undo: step('h2', 'entry.create'), redo: null });
    const result = await convertEventToRow(event('Agenda'), target, NY);
    expect(tables.createField).toHaveBeenCalledWith('table-1', {
      id: expect.stringMatching(/^field-\d{13}-/),
      name: 'description',
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
    });
    expect(tables.createEntry).toHaveBeenCalledWith(
      'table-1',
      expect.objectContaining({
        schemaVersion: 'schema-2',
        values: expect.objectContaining({ 'field-new': 'Agenda', 'field-due': '2026-10-12' }),
      })
    );
    expect(result.addedField).toBe(true);
    expect(result.message).toBe(
      'Moved to Test table · description. Added a description column to Test table'
    );
  });

  it('names the new column Event description when a non-text field owns Description', async () => {
    const numeric = field('field-desc', { name: 'description', type: 'number' });
    tables.entries.mockResolvedValue(schema([nameField, numeric, due('date')]));
    tables.createField.mockResolvedValue({
      field: field('field-new', { name: 'event_description' }),
    });
    tables.history.mockResolvedValue({ undo: step('h1', 'field.create'), redo: null });
    await convertEventToRow(event('Agenda'), target, NY);
    expect(tables.createField).toHaveBeenCalledWith(
      'table-1',
      expect.objectContaining({ name: 'event_description', type: 'text' })
    );
  });

  it('an empty description adds no column and writes none', async () => {
    tables.entries.mockResolvedValue(schema([nameField, due('date')]));
    tables.history.mockResolvedValue({ undo: step('h1', 'entry.create'), redo: null });
    const result = await convertEventToRow(event('  \n '), target, NY);
    expect(tables.createField).not.toHaveBeenCalled();
    expect(tables.createEntry.mock.calls[0]![1].values).toEqual({
      'field-name': 'Test event',
      'field-due': '2026-10-12',
    });
    expect(result.message).toBe('Moved to Test table');
  });

  it('puts the location in the table’s Location column, next to the description', async () => {
    const desc = field('field-desc', { name: 'description' });
    const place = field('field-place', { name: 'Location' });
    tables.entries.mockResolvedValue(schema([nameField, desc, place, due('date')]));
    tables.history.mockResolvedValue({ undo: step('h1', 'entry.create'), redo: null });
    const result = await convertEventToRow(event('Agenda', ' Room 4 '), target, NY);
    expect(tables.createEntry.mock.calls[0]![1].values).toEqual({
      'field-name': 'Test event',
      'field-desc': 'Agenda',
      'field-place': 'Room 4',
      'field-due': '2026-10-12',
    });
    expect(result.locationField).toBe(place);
    expect(result.message).toBe('Moved to Test table · description, Location');
  });

  it('a location with no column of its own is appended to the description', async () => {
    const desc = field('field-desc', { name: 'description' });
    // A Location field that can't hold text doesn't take it either.
    const numeric = field('field-place', { name: 'location', type: 'number' });
    tables.entries.mockResolvedValue(schema([nameField, desc, numeric, due('date')]));
    tables.history.mockResolvedValue({ undo: step('h1', 'entry.create'), redo: null });
    const result = await convertEventToRow(event('Agenda', 'Room 4'), target, NY);
    expect(tables.createEntry.mock.calls[0]![1].values).toEqual({
      'field-name': 'Test event',
      'field-desc': 'Agenda\n\nLocation: Room 4',
      'field-place': null,
      'field-due': '2026-10-12',
    });
    expect(result.locationField).toBeNull();
    expect(result.message).toBe('Moved to Test table · description');
  });

  it('a location alone still adds the Description column, so it is never lost', async () => {
    tables.entries
      .mockResolvedValueOnce(schema([nameField, due('date')]))
      .mockResolvedValueOnce(
        schema([nameField, due('date'), field('field-new', { name: 'description' })], 'schema-2')
      );
    tables.createField.mockResolvedValue({ field: field('field-new', { name: 'description' }) });
    const fieldStep = step('h1', 'field.create');
    const entryStep = step('h2', 'entry.create');
    tables.history
      .mockResolvedValueOnce({ undo: fieldStep, redo: null })
      .mockResolvedValueOnce({ undo: entryStep, redo: null });
    const result = await convertEventToRow(event('', 'Room 4'), target, NY);
    expect(tables.createField).toHaveBeenCalledWith(
      'table-1',
      expect.objectContaining({ name: 'description', type: 'text' })
    );
    expect(tables.createEntry.mock.calls[0]![1].values).toEqual({
      'field-name': 'Test event',
      'field-new': 'Location: Room 4',
      'field-due': '2026-10-12',
    });
    expect(result.addedField).toBe(true);
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
    await result.undo!.undo();
    expect(order).toEqual(['undo h2', 'undo h1', 'restore calendar-event-1']);
  });

  it('one undo removes the row, then the added column, and restores the event', async () => {
    tables.entries.mockResolvedValue(schema([nameField, due('date')]));
    tables.createField.mockResolvedValue({ field: field('field-new', { name: 'description' }) });
    const fieldStep = step('h1', 'field.create');
    const entryStep = step('h2', 'entry.create');
    tables.history
      .mockResolvedValueOnce({ undo: fieldStep, redo: null })
      .mockResolvedValueOnce({ undo: entryStep, redo: null });
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
    const result = await convertEventToRow(event('Agenda'), target, NY);
    await result.undo!.undo();
    expect(order).toEqual(['undo h2', 'undo h1', 'restore calendar-event-1']);
  });

  it('a refused row undo leaves the event archived and the column in place', async () => {
    tables.entries.mockResolvedValue(schema([nameField, due('date')]));
    tables.history.mockResolvedValue({ undo: step('h2', 'entry.create'), redo: null });
    const result = await convertEventToRow(event(''), target, NY);
    history.stepTableHistory.mockRejectedValueOnce(new Error('Can’t undo: the data changed'));
    await expect(result.undo!.undo()).rejects.toThrow('the data changed');
    expect(archive.restore).not.toHaveBeenCalled();
  });

  it('a failed archive rolls the row and the added column back, and rethrows', async () => {
    tables.entries.mockResolvedValue(schema([nameField, due('date')]));
    tables.createField.mockResolvedValue({ field: field('field-new', { name: 'description' }) });
    tables.history
      .mockResolvedValueOnce({ undo: step('h1', 'field.create'), redo: null })
      .mockResolvedValueOnce({ undo: step('h2', 'entry.create'), redo: null });
    calendar.deleteEvent.mockRejectedValue(new Error('Conflict'));
    await expect(convertEventToRow(event('Agenda'), target, NY)).rejects.toThrow('Conflict');
    expect(
      history.stepTableHistory.mock.calls.map(([dir, o]) => `${dir} ${o.expected.id}`)
    ).toEqual(['undo h2', 'undo h1']);
  });
});
