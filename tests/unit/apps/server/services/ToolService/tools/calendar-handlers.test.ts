/**
 * calendar tool handlers over mocked domain functions: the query span,
 * filters, paging and compact views; table rows only with table read access
 * (left out of query and list, refused for reminders) and occurrence writes
 * only with table write access, refused before any table is touched; `rev`
 * → expectedRevision for events and the row-rev guard for occurrences; and
 * event times (wall time in the calendar's zone, all-day ends as the last
 * day).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  Calendar,
  CalendarEvent,
  CalendarOccurrence,
  CalendarOccurrencesResponse,
} from '@snaglet/shared/types';

const listCalendars = jest.fn<() => Promise<Calendar[]>>();
const createCalendar = jest.fn<(input: unknown) => Promise<Calendar>>();
const getEvent = jest.fn<(id: string) => Promise<CalendarEvent>>();
const createEvent =
  jest.fn<(input: unknown) => Promise<{ event: CalendarEvent; created: boolean }>>();
const updateEvent = jest.fn<(id: string, input: unknown) => Promise<CalendarEvent>>();
const deleteEvent = jest.fn<(id: string, rev: unknown) => Promise<{ id: string }>>();
const restoreEvent = jest.fn<(id: string) => Promise<CalendarEvent>>();
const listOccurrences =
  jest.fn<(query: Record<string, unknown>) => Promise<CalendarOccurrencesResponse>>();
const getTableEntry = jest.fn<(tableId: string, entryId: string) => Promise<unknown>>();
const getTableEntryRepeats = jest.fn<(tableId: string, entryId: string) => Promise<unknown>>();
const tableEntryRepeatAction = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const listTableFields = jest.fn<(tableId: string) => Promise<unknown[]>>();
const describeAgentTable = jest.fn<(table: string) => Promise<unknown>>();
const automationsList = jest.fn<(options: unknown) => Promise<Array<{ id: string }>>>();
const remindersGet = jest.fn<(item: unknown) => Promise<unknown>>();
const remindersSave = jest.fn<(item: unknown, input: unknown) => Promise<unknown>>();
const remindersRemove = jest.fn<(item: unknown) => Promise<boolean>>();
const assertReminderItemExists = jest.fn<(item: unknown) => Promise<void>>();
const refreshReminderTables = jest.fn<() => Promise<void>>();
const emitRemindersChanged = jest.fn();

jest.mock('@server/domains/calendar/calendarService', () => ({
  listCalendars: () => listCalendars(),
  createCalendar: (input: unknown) => createCalendar(input),
  getEvent: (id: string) => getEvent(id),
  createEvent: (input: unknown) => createEvent(input),
  updateEvent: (id: string, input: unknown) => updateEvent(id, input),
  deleteEvent: (id: string, rev: unknown) => deleteEvent(id, rev),
  restoreEvent: (id: string) => restoreEvent(id),
}));
jest.mock('@server/domains/calendar/occurrences', () => ({
  listOccurrences: (query: Record<string, unknown>) => listOccurrences(query),
}));
jest.mock('@server/domains/tables/tableEntries', () => ({
  getTableEntry: (t: string, e: string) => getTableEntry(t, e),
  getTableEntryRepeats: (t: string, e: string) => getTableEntryRepeats(t, e),
  tableEntryRepeatAction: (...args: unknown[]) => tableEntryRepeatAction(...args),
}));
jest.mock('@server/domains/tables/tableFields', () => ({
  listTableFields: (tableId: string) => listTableFields(tableId),
}));
jest.mock('@server/domains/tables/tableAgent', () => ({
  describeAgentTable: (table: string) => describeAgentTable(table),
}));
jest.mock('@snaglet/db/tables/automations', () => ({
  Automations: { list: (options: unknown) => automationsList(options) },
}));
jest.mock('@snaglet/db/tables/calendars', () => ({
  Calendars: { findById: async (id: string) => ({ id, title: id === CAL_WORK ? 'Work' : 'Home' }) },
}));
jest.mock('@snaglet/db/tables/reminders', () => ({
  Reminders: {
    get: (item: unknown) => remindersGet(item),
    save: (item: unknown, input: unknown) => remindersSave(item, input),
    remove: (item: unknown) => remindersRemove(item),
  },
}));
jest.mock('@server/domains/reminders/reminderInput', () => ({
  ...jest.requireActual<object>('@server/domains/reminders/reminderInput'),
  assertReminderItemExists: (item: unknown) => assertReminderItemExists(item),
}));
jest.mock('@server/domains/reminders/upcomingReminders', () => ({
  refreshReminderTables: () => refreshReminderTables(),
}));
jest.mock('@server/realtime/surfaces/reminders', () => ({
  emitRemindersChanged: () => emitRemindersChanged(),
}));

import type { CalendarCaller } from '@server/services/ToolService/handlers/calendar/access';
import {
  createCalendarOp,
  listCalendarsOp,
} from '@server/services/ToolService/handlers/calendar/calendars';
import { queryOp } from '@server/services/ToolService/handlers/calendar/query';
import {
  createEventOp,
  deleteEventOp,
  updateEventOp,
} from '@server/services/ToolService/handlers/calendar/events';
import {
  completeOccurrenceOp,
  moveOccurrenceOp,
  skipOccurrenceOp,
} from '@server/services/ToolService/handlers/calendar/occurrences';
import {
  getRemindersOp,
  setRemindersOp,
} from '@server/services/ToolService/handlers/calendar/reminders';

const CAL_WORK = 'cal-work';
const CAL_HOME = 'cal-home';
const TABLE = 'table-1111111111111-aaaaaaaaa';
const FIELD_DUE = 'field-1111111111111-due';
const FIELD_STATUS = 'field-1111111111111-status';
const ENTRY = '11111111-1111-4111-8111-111111111111';
const ROW_REV = 'abcdef0123456789';
const NOW = new Date('2026-10-15T17:00:00Z'); // Thursday, 10:00 in Los Angeles

const allowed = async () => ({ allowed: true });
const person: CalendarCaller = {
  agentId: null,
  tableAccess: allowed,
  automationAccess: allowed,
  automationWriteAccess: allowed,
};
const noTables: CalendarCaller = {
  agentId: 'test-agent-a',
  tableAccess: async () => ({ allowed: false, reason: 'rule `table`' }),
  automationAccess: allowed,
  automationWriteAccess: allowed,
};
const readOnlyTables: CalendarCaller = {
  agentId: 'test-agent-a',
  tableAccess: async (need) =>
    need === 'read' ? { allowed: true } : { allowed: false, reason: 'rule `table_write`' },
  automationAccess: allowed,
  automationWriteAccess: allowed,
};

function calendar(id: string, title: string, timeZone: string, extra: Partial<Calendar> = {}) {
  return {
    id,
    title,
    description: '',
    timeZone,
    color: null,
    isDefault: false,
    sortOrder: 0,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    boundFields: [],
    ...extra,
  } as Calendar;
}

const work = calendar(CAL_WORK, 'Work', 'America/Los_Angeles', {
  isDefault: true,
  boundFields: [
    {
      tableId: TABLE,
      tableName: 'chores',
      projectId: null,
      fieldId: FIELD_DUE,
      fieldName: 'due',
      fieldType: 'date',
      repeats: true,
      unscheduledCount: 0,
    },
  ],
});
const home = calendar(CAL_HOME, 'Home', 'Europe/Paris');

const eventOccurrence: CalendarOccurrence = {
  key: 'event:event-1',
  source: 'event',
  eventId: 'event-1',
  revision: 3,
  timeZone: 'America/Los_Angeles',
  calendarId: CAL_WORK,
  title: 'Standup',
  time: { kind: 'timed', start: '2026-10-15T16:00:00.000Z', end: '2026-10-15T16:30:00.000Z' },
  status: 'upcoming',
  canMove: true,
  canResize: true,
};
const rowOccurrence: CalendarOccurrence = {
  key: `row:${FIELD_DUE}:${ENTRY}:2026-10-15`,
  source: 'row',
  calendarId: CAL_WORK,
  title: 'Water plants',
  time: { kind: 'all_day', startDate: '2026-10-15', endDate: '2026-10-16' },
  status: 'upcoming',
  canMove: true,
  canResize: false,
  tableId: TABLE,
  tableName: 'chores',
  projectId: null,
  entryId: ENTRY,
  fieldId: FIELD_DUE,
  range: false,
  hasEnd: false,
  entryRevision: ROW_REV,
  schemaVersion: 'v1',
  repeat: { occurrence: '2026-10-15', isCurrent: true, summary: 'Every day', shape: 'schedule' },
};
const plainRow: CalendarOccurrence = {
  ...(rowOccurrence as Extract<CalendarOccurrence, { source: 'row' }>),
  key: `row:${FIELD_DUE}:${ENTRY}:value`,
  title: 'File taxes',
  status: 'done',
  repeat: undefined,
};
const automationOccurrence: CalendarOccurrence = {
  key: 'automation:auto-1:2026-10-15T20:00:00.000Z',
  source: 'automation',
  calendarId: CAL_HOME,
  title: 'Check the build',
  time: { kind: 'timed', start: '2026-10-15T20:00:00.000Z', end: '2026-10-15T20:15:00.000Z' },
  status: 'upcoming',
  canMove: false,
  canResize: false,
  automationId: 'auto-1',
  agentId: 'test-agent-a',
  agentName: 'Test Agent A',
  threadId: 'thread-1',
  automationStatus: 'active',
};

function occurrencesResponse(occurrences: CalendarOccurrence[]): CalendarOccurrencesResponse {
  return {
    from: '',
    to: '',
    tz: '',
    occurrences,
    intervals: [],
    unavailable: [{ tableId: 'table-2', fieldId: 'field-2', reason: 'table_archived' }],
  };
}

interface QueryResult {
  from: string;
  to: string;
  tz: string;
  total: number;
  occurrences: Array<Record<string, unknown>>;
  has_more: boolean;
  next?: string;
  hidden?: string;
  notes?: string[];
  unavailable?: unknown[];
}

const query = async (input: Record<string, unknown>, caller = person) =>
  (await queryOp(input, caller, NOW)) as QueryResult;

beforeEach(() => {
  jest.clearAllMocks();
  listCalendars.mockResolvedValue([work, home]);
  listOccurrences.mockResolvedValue(
    occurrencesResponse([eventOccurrence, rowOccurrence, plainRow, automationOccurrence])
  );
  automationsList.mockResolvedValue([{ id: 'auto-1' }]);
  listTableFields.mockResolvedValue([
    { id: FIELD_DUE, name: 'due', type: 'date' },
    { id: FIELD_STATUS, name: 'status', type: 'select' },
    { id: 'field-notes', name: 'notes', type: 'text' },
  ]);
  getTableEntry.mockResolvedValue({
    entry: {
      id: ENTRY,
      revision: ROW_REV,
      values: { [FIELD_STATUS]: 'todo', 'field-notes': 'x'.repeat(500) },
    },
    schemaVersion: 'v1',
  });
});

describe('query: table access', () => {
  it('leaves rows out (and says why) when the caller may not read tables', async () => {
    const result = await query({}, noTables);
    expect(result.occurrences.map((o) => o.kind)).toEqual(['event', 'automation']);
    expect(result.hidden).toMatch(/table rows .* left out: rule `table`/);
    expect(result.unavailable).toBeUndefined();
    expect(getTableEntry).not.toHaveBeenCalled();
  });

  it('asked for rows only, without access, returns none', async () => {
    const result = await query({ kinds: ['table_rows'] }, noTables);
    expect(result.occurrences).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('list hides the bound table fields too', async () => {
    const result = (await listCalendarsOp({}, noTables)) as {
      calendars: Array<Record<string, unknown>>;
      hidden?: string;
    };
    expect(result.calendars[0]).not.toHaveProperty('bound_fields');
    expect(result.hidden).toMatch(/left out/);
    const open = (await listCalendarsOp({}, person)) as {
      calendars: Array<Record<string, unknown>>;
    };
    expect(open.calendars[0]!.bound_fields).toEqual([
      expect.objectContaining({ table: 'chores', field: 'due', repeats: true }),
    ]);
  });
});

describe('create_calendar', () => {
  it('passes title, description, color and zone, and shows the new calendar with its rev', async () => {
    createCalendar.mockResolvedValue({
      id: 'cal-work',
      title: 'Work',
      description: 'Day job',
      timeZone: 'America/New_York',
      color: '#3366cc',
      isDefault: false,
      revision: 1,
      boundFields: [],
    } as unknown as Calendar);
    const result = await createCalendarOp({
      title: 'Work',
      description: 'Day job',
      color: '#36c',
      tz: 'America/New_York',
    });
    expect(createCalendar).toHaveBeenCalledWith({
      title: 'Work',
      description: 'Day job',
      color: '#36c',
      timeZone: 'America/New_York',
    });
    expect(result).toEqual({
      calendar: {
        id: 'cal-work',
        title: 'Work',
        tz: 'America/New_York',
        description: 'Day job',
        color: '#3366cc',
        rev: '1',
      },
      created: true,
    });
  });

  it('sends only the title when that is all it is given (the zone defaults to the user’s)', async () => {
    createCalendar.mockResolvedValue({ ...home, id: 'cal-x', title: 'X' } as Calendar);
    await createCalendarOp({ title: ' X ' });
    expect(createCalendar).toHaveBeenCalledWith({ title: ' X ' });
  });

  it('refuses a missing title and badly typed fields before calling the service', async () => {
    await expect(createCalendarOp({})).rejects.toThrow('title is required');
    await expect(createCalendarOp({ title: '  ' })).rejects.toThrow('title is required');
    await expect(createCalendarOp({ title: 'X', color: 5 })).rejects.toThrow('color must be text');
    await expect(createCalendarOp({ title: 'X', description: 5 })).rejects.toThrow(
      'description must be text'
    );
    expect(createCalendar).not.toHaveBeenCalled();
  });
});

describe('query: views', () => {
  it('shows times in the zone with an offset, all-day ends as the last day, row source ids', async () => {
    const result = await query({});
    expect(result.tz).toBe('America/Los_Angeles');
    const [event, row] = result.occurrences;
    expect(event).toEqual({
      kind: 'event',
      title: 'Standup',
      start: '2026-10-15T09:00:00-07:00',
      end: '2026-10-15T09:30:00-07:00',
      all_day: false,
      calendar: 'Work',
      status: 'upcoming',
      event_id: 'event-1',
      rev: '3',
    });
    expect(row).toMatchObject({
      kind: 'table_row',
      start: '2026-10-15',
      end: '2026-10-15',
      all_day: true,
      table: 'chores',
      table_id: TABLE,
      entry_id: ENTRY,
      field: 'due',
      field_id: FIELD_DUE,
      rev: 'abcdef01',
      repeat: { occurrence: '2026-10-15', current: true, summary: 'Every day' },
      values: { status: 'todo' },
    });
    expect(result.occurrences[3]).toMatchObject({ kind: 'automation', repeats: true });
    expect(result.unavailable).toEqual([
      { table_id: 'table-2', field_id: 'field-2', reason: 'table_archived' },
    ]);
  });

  it('returns the asked-for row fields, shortened, and notes unknown ones', async () => {
    const result = await query({ fields: ['notes', 'Status', 'nope'], kinds: ['table_rows'] });
    const values = result.occurrences[0]!.values as Record<string, string>;
    expect(Object.keys(values)).toEqual(['notes', 'status']);
    expect(values.notes).toHaveLength(200);
    expect(values.notes!.endsWith('…')).toBe(true);
    expect(result.notes).toEqual(["fields not in these rows' tables: nope"]);
  });
});

describe('query: rows cut short', () => {
  it('lists a row that repeats more often than one read shows, with a note', async () => {
    listOccurrences.mockResolvedValue({
      ...occurrencesResponse([rowOccurrence]),
      truncated: [
        { tableId: TABLE, fieldId: FIELD_DUE, entryId: ENTRY, title: 'Water plants', shown: 500 },
      ],
    });
    const result = (await query({})) as QueryResult & { truncated?: unknown[] };
    expect(result.truncated).toEqual([
      {
        table: 'chores',
        table_id: TABLE,
        entry_id: ENTRY,
        field: 'due',
        title: 'Water plants',
        shown: 500,
      },
    ]);
    expect(result.notes).toEqual([
      'a row repeats more often than one read shows (at most 500 times per row): only the first `shown` are listed; query a shorter span for the rest',
    ]);
    const hidden = (await query({}, noTables)) as QueryResult & { truncated?: unknown[] };
    expect(hidden.truncated).toBeUndefined();
    const otherTable = (await query({ tables: ['groceries'] })) as QueryResult & {
      truncated?: unknown[];
    };
    expect(otherTable.truncated).toBeUndefined();
  });

  it('marks a row repeating more often than once a minute as hidden, with its own note', async () => {
    listOccurrences.mockResolvedValue({
      ...occurrencesResponse([]),
      truncated: [
        {
          tableId: TABLE,
          fieldId: FIELD_DUE,
          entryId: ENTRY,
          title: 'Ping',
          shown: 0,
          hidden: true,
        },
      ],
    });
    const result = (await query({})) as QueryResult & { truncated?: unknown[] };
    expect(result.truncated).toEqual([
      {
        table: 'chores',
        table_id: TABLE,
        entry_id: ENTRY,
        field: 'due',
        title: 'Ping',
        shown: 0,
        hidden: true,
      },
    ]);
    expect(result.notes).toEqual([
      '"Ping" repeats more often than once a minute: the calendar lists none of its times; the row and its repeat still work in the table',
    ]);
  });
});

describe('query: filters and paging', () => {
  it.each([
    [{ kinds: ['events'] }, ['Standup']],
    [{ tables: ['CHORES'] }, ['Water plants', 'File taxes']],
    [{ repeats: 'exclude' }, ['Standup', 'File taxes']],
    [{ repeats: 'only' }, ['Water plants', 'Check the build']],
    [{ status: ['done'] }, ['File taxes']],
    [{ text: 'PLANTS' }, ['Water plants']],
    [{ calendars: ['home'] }, ['Standup', 'Water plants', 'File taxes', 'Check the build']],
  ])('%j', async (filter, titles) => {
    const result = await query(filter);
    expect(result.occurrences.map((o) => o.title)).toEqual(titles);
  });

  it('passes the chosen calendars, project and span to listOccurrences', async () => {
    await query({ calendars: ['Home'], project_id: 'container-1', range: 'today' });
    expect(listOccurrences).toHaveBeenCalledWith({
      from: '2026-10-15',
      to: '2026-10-16',
      tz: 'Europe/Paris',
      calendarIds: [CAL_HOME],
      projectId: 'container-1',
    });
  });

  it('notes a table filter that matches no date field on the calendars', async () => {
    const result = await query({ tables: ['groceries'] });
    expect(result.notes).toEqual([
      'no date field of these tables is on the queried calendars: groceries',
    ]);
  });

  it('pages with limit and the next cursor', async () => {
    const first = await query({ limit: 3 });
    expect(first).toMatchObject({ total: 4, has_more: true, next: '3' });
    expect(first.occurrences).toHaveLength(3);
    const second = await query({ limit: 3, cursor: first.next });
    expect(second.occurrences.map((o) => o.title)).toEqual(['Check the build']);
    expect(second).toMatchObject({ has_more: false });
    expect(second).not.toHaveProperty('next');
  });

  it('refuses unknown calendars, kinds and statuses with the allowed values', async () => {
    await expect(query({ calendars: ['Gym'] })).rejects.toThrow(
      'No calendar "Gym". Calendars: "Work", "Home".'
    );
    await expect(query({ kinds: ['tasks'] })).rejects.toThrow(
      'kinds[0] must be one of events, table_rows, automations'
    );
    await expect(query({ status: ['late'] })).rejects.toThrow(/status\[0\] must be one of/);
  });

  it('asks for an id when two calendars share a title', async () => {
    listCalendars.mockResolvedValue([work, calendar('cal-work-2', 'Work', 'UTC')]);
    await expect(query({ calendars: ['work'] })).rejects.toThrow(
      '2 calendars are called "work"; pass an id: cal-work, cal-work-2'
    );
  });
});

describe('query: span', () => {
  const span = async (input: Record<string, unknown>) => {
    await query({ tz: 'America/Los_Angeles', ...input });
    const call = listOccurrences.mock.calls.at(-1)![0];
    return [call.from, call.to];
  };

  it.each([
    [{}, ['2026-10-15', '2026-10-22']],
    [{ range: 'today' }, ['2026-10-15', '2026-10-16']],
    [{ range: 'tomorrow' }, ['2026-10-16', '2026-10-17']],
    [{ range: 'this_week' }, ['2026-10-12', '2026-10-19']],
    [{ range: 'next_week' }, ['2026-10-19', '2026-10-26']],
    [{ range: 'this_month' }, ['2026-10-01', '2026-11-01']],
    [{ days: 3 }, ['2026-10-15', '2026-10-18']],
    [{ from: '2026-12-30', days: 5 }, ['2026-12-30', '2027-01-04']],
    [{ from: '2026-11-02' }, ['2026-11-02', '2026-11-03']],
    [{ from: '2026-11-02', to: '2026-11-09' }, ['2026-11-02', '2026-11-09']],
    [{ from: '2026-11-02T09:00', to: '2026-11-02T17:00' }, ['2026-11-02', '2026-11-03']],
  ])('%j → %j', async (input, expected) => {
    expect(await span(input)).toEqual(expected);
  });

  it('today follows the zone: late evening in Los Angeles is already tomorrow in Paris', async () => {
    const late = new Date('2026-10-16T05:30:00Z');
    await queryOp({ range: 'today', tz: 'Europe/Paris' }, person, late);
    expect(listOccurrences.mock.calls[0]![0]).toMatchObject({ from: '2026-10-16' });
  });

  it('a date-time span keeps only occurrences overlapping it', async () => {
    const result = await query({
      from: '2026-10-15T09:15',
      to: '2026-10-15T12:00',
      tz: 'America/Los_Angeles',
    });
    // Standup 9:00–9:30 overlaps; the all-day rows cover the day; the 13:00 wake does not.
    expect(result.occurrences.map((o) => o.title)).toEqual([
      'Standup',
      'Water plants',
      'File taxes',
    ]);
    expect(result.from).toBe('2026-10-15T09:15:00-07:00');
  });

  it.each([
    [{ from: '2026-10-01', to: '2026-12-15' }, /at most 62 days; this one is 75/],
    [{ days: 63 }, /days must be an integer 1-62/],
    [{ to: '2026-10-20' }, /to needs from/],
    [{ range: 'today', days: 2 }, /pass range, or days \/ from \/ to, not both/],
    [{ from: '2026-10-20', to: '2026-10-20' }, /to must be after from/],
    [{ range: 'fortnight' }, /range must be one of today, tomorrow/],
    [{ tz: 'Mars/Olympus' }, /tz must be a known IANA time zone/],
  ])('refuses %j', async (input, message) => {
    await expect(query(input)).rejects.toThrow(message);
    expect(listOccurrences).not.toHaveBeenCalled();
  });
});

describe('events: times and rev', () => {
  const timed: CalendarEvent = {
    id: 'event-1',
    calendarId: CAL_WORK,
    title: 'Standup',
    description: '',
    location: '',
    time: {
      kind: 'timed',
      startAt: '2026-10-15T16:00:00.000Z',
      endAt: '2026-10-15T16:30:00.000Z',
      timeZone: 'America/Los_Angeles',
    },
    revision: 3,
    createdAt: '',
    updatedAt: '',
  };

  beforeEach(() => {
    createEvent.mockImplementation(async (input) => ({
      event: { ...timed, ...(input as Partial<CalendarEvent>), revision: 1 },
      created: true,
    }));
    getEvent.mockResolvedValue(timed);
    updateEvent.mockImplementation(async (_id, input) => ({
      ...timed,
      ...(input as Partial<CalendarEvent>),
      revision: 4,
    }));
    deleteEvent.mockResolvedValue({ id: 'event-1' });
  });

  it('create reads a wall time in the calendar’s zone and defaults to an hour, on Default', async () => {
    const out = (await createEventOp({ title: 'Review', start: '2026-10-20T14:00' })) as {
      event: Record<string, unknown>;
    };
    expect(createEvent).toHaveBeenCalledWith({
      calendarId: CAL_WORK,
      title: 'Review',
      time: {
        kind: 'timed',
        startAt: '2026-10-20T21:00:00.000Z',
        endAt: '2026-10-20T22:00:00.000Z',
        timeZone: 'America/Los_Angeles',
      },
    });
    expect(out.event).toMatchObject({ start: '2026-10-20T14:00:00-07:00', all_day: false });
  });

  it('create with a date is all-day; end is the last day, sent exclusive, in the calendar zone', async () => {
    await createEventOp({
      title: 'Trip',
      calendar: 'home',
      start: '2026-11-02',
      end: '2026-11-04',
    });
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: CAL_HOME,
        time: {
          kind: 'all_day',
          startDate: '2026-11-02',
          endDate: '2026-11-05',
          timeZone: 'Europe/Paris',
        },
      })
    );
  });

  it('create refuses a date-time for an all-day event and a date for a timed one', async () => {
    await expect(
      createEventOp({ title: 'x', start: '2026-11-02T09:00', all_day: true })
    ).rejects.toThrow(/all-day event starts on a date/);
    await expect(
      createEventOp({ title: 'x', start: '2026-11-02', all_day: false })
    ).rejects.toThrow(/a date alone is all-day/);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('update maps rev to expectedRevision; start alone moves the event and keeps its length', async () => {
    await updateEventOp({ id: 'event-1', rev: '3', start: '2026-10-16T11:00:00-07:00' });
    expect(updateEvent).toHaveBeenCalledWith('event-1', {
      expectedRevision: 3,
      time: {
        kind: 'timed',
        startAt: '2026-10-16T18:00:00.000Z',
        endAt: '2026-10-16T18:30:00.000Z',
        timeZone: 'America/Los_Angeles',
      },
    });
  });

  it('update needs rev, and a new start to switch between timed and all-day', async () => {
    await expect(updateEventOp({ id: 'event-1', title: 'x' })).rejects.toThrow(/rev is required/);
    await expect(updateEventOp({ id: 'event-1', rev: 3, all_day: true })).rejects.toThrow(
      /making the event all-day needs a new start/
    );
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('delete maps rev and names the undo', async () => {
    expect(await deleteEventOp({ id: 'event-1', rev: 3 })).toEqual({
      deleted: 'event-1',
      undo: 'calendar {op: "restore_event", id: "event-1"}',
    });
    expect(deleteEvent).toHaveBeenCalledWith('event-1', 3);
  });
});

describe('occurrence writes', () => {
  const target = {
    id: TABLE,
    name: 'chores',
    fields: [
      {
        id: FIELD_DUE,
        name: 'due',
        type: 'date',
        range: false,
        recurrence: { statusFieldId: null, doneOptionIds: [], resetOptionId: null },
      },
    ],
  };
  const repeat = {
    rrule: 'FREQ=DAILY',
    dtstart: '2026-10-01',
    current: '2026-10-15',
    tz: 'America/Los_Angeles',
  };
  const input = { table: 'chores', entry_id: ENTRY, field: 'due', rev: ROW_REV.slice(0, 8) };

  beforeEach(() => {
    describeAgentTable.mockResolvedValue(target);
    getTableEntryRepeats.mockResolvedValue({ repeats: { [FIELD_DUE]: repeat }, log: [] });
    tableEntryRepeatAction.mockResolvedValue({
      entry: { id: ENTRY, revision: 'fedcba9876543210' },
      repeat: { ...repeat, current: '2026-10-16' },
      changed: true,
    });
  });

  it.each([
    ['move', moveOccurrenceOp, { move_to: '2026-10-17' }],
    ['complete', completeOccurrenceOp, {}],
    ['skip', skipOccurrenceOp, {}],
  ])(
    '%s is refused without table write access, before any table is touched',
    async (_a, op, extra) => {
      await expect(op({ ...input, ...extra }, readOnlyTables)).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(
          /needs table write access.*rule `table_write`.*Nothing was changed/
        ),
      });
      expect(describeAgentTable).not.toHaveBeenCalled();
      expect(tableEntryRepeatAction).not.toHaveBeenCalled();
    }
  );

  it('complete runs the repeat action with the full revision, schema version and current guard', async () => {
    const out = await completeOccurrenceOp({ ...input, occurrence: '2026-10-15' }, person);
    expect(tableEntryRepeatAction).toHaveBeenCalledWith(TABLE, ENTRY, FIELD_DUE, 'complete', {
      expectedRevision: ROW_REV,
      schemaVersion: 'v1',
      expectedCurrent: '2026-10-15',
    });
    expect(out).toEqual({
      table: 'chores',
      entry_id: ENTRY,
      field: 'due',
      done: '2026-10-15',
      rev: 'fedcba98',
      changed: true,
      repeat: { summary: expect.any(String), current: '2026-10-16' },
    });
  });

  it('move passes the occurrence and its new date', async () => {
    await moveOccurrenceOp({ ...input, occurrence: '2026-10-18', move_to: '2026-10-19' }, person);
    expect(tableEntryRepeatAction).toHaveBeenCalledWith(TABLE, ENTRY, FIELD_DUE, 'move', {
      expectedRevision: ROW_REV,
      schemaVersion: 'v1',
      expectedCurrent: '2026-10-15',
      to: '2026-10-19',
      occurrence: '2026-10-18',
    });
  });

  it('a stale rev is a 409 naming the row’s current rev; nothing runs', async () => {
    await expect(skipOccurrenceOp({ ...input, rev: '00000000' }, person)).rejects.toMatchObject({
      statusCode: 409,
      details: { entry: { id: ENTRY } },
    });
    expect(tableEntryRepeatAction).not.toHaveBeenCalled();
  });

  it('complete or skip of an occurrence that is not the current one is a 409', async () => {
    await expect(skipOccurrenceOp({ ...input, occurrence: '2026-10-16' }, person)).rejects.toThrow(
      /Only the row's current occurrence \(2026-10-15\) can be marked skipped/
    );
    expect(tableEntryRepeatAction).not.toHaveBeenCalled();
  });

  it('a row that does not repeat points to table write', async () => {
    getTableEntryRepeats.mockResolvedValue({ repeats: {}, log: [] });
    await expect(completeOccurrenceOp(input, person)).rejects.toThrow(
      /doesn't repeat.*table \{op: "write"/
    );
  });

  it('needs rev and move_to', async () => {
    await expect(completeOccurrenceOp({ ...input, rev: undefined }, person)).rejects.toThrow(
      /rev is required/
    );
    await expect(moveOccurrenceOp(input, person)).rejects.toThrow(/move_to is required/);
  });
});

describe('reminders', () => {
  const rowItem = { table: 'chores', entry_id: ENTRY, field: 'due' };

  beforeEach(() => {
    describeAgentTable.mockResolvedValue({
      id: TABLE,
      name: 'chores',
      fields: [{ id: FIELD_DUE, name: 'due', type: 'datetime' }],
    });
    remindersGet.mockResolvedValue(null);
    remindersSave.mockImplementation(async (item, input) => ({
      item,
      ...(input as object),
      updatedAt: '2026-10-15T00:00:00Z',
    }));
  });

  it('get and set on a row are refused without table read access, before the table is read', async () => {
    for (const op of [getRemindersOp, setRemindersOp]) {
      await expect(op({ ...rowItem, before: ['15m'] }, noTables)).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(/^Reminders on a table row needs table read access/),
      });
    }
    expect(describeAgentTable).not.toHaveBeenCalled();
    expect(remindersGet).not.toHaveBeenCalled();
    expect(remindersSave).not.toHaveBeenCalled();
  });

  it('an event’s reminders need no table access', async () => {
    const out = await getRemindersOp({ id: 'event-1' }, noTables);
    expect(out).toEqual({ item: { kind: 'event', id: 'event-1' }, reminders: null });
  });

  it('set on a row merges over the defaults, parses `before`, saves, refreshes and emits', async () => {
    const out = (await setRemindersOp(
      { ...rowItem, before: ['15m', '2 hours', '1d'] },
      person
    )) as {
      reminders: Record<string, unknown>;
    };
    const item = { kind: 'table_entry', tableId: TABLE, entryId: ENTRY, fieldId: FIELD_DUE };
    expect(assertReminderItemExists).toHaveBeenCalledWith(item);
    expect(remindersSave).toHaveBeenCalledWith(item, {
      enabled: true,
      atStart: true,
      offsets: [
        { amount: 15, unit: 'minutes' },
        { amount: 2, unit: 'hours' },
        { amount: 1, unit: 'days' },
      ],
      sound: 'chime',
    });
    expect(refreshReminderTables).toHaveBeenCalled();
    expect(emitRemindersChanged).toHaveBeenCalled();
    expect(out.reminders).toMatchObject({ before: ['15m', '2h', '1d'], at_start: true });
  });

  it('clear removes; clear with settings, two items, or a bad offset are refused', async () => {
    remindersRemove.mockResolvedValue(true);
    expect(await setRemindersOp({ automation_id: 'auto-1', clear: true }, noTables)).toEqual({
      item: { kind: 'automation', automation_id: 'auto-1' },
      reminders: null,
    });
    await expect(
      setRemindersOp({ id: 'event-1', clear: true, sound: 'bell' }, person)
    ).rejects.toThrow(/pass it alone/);
    await expect(setRemindersOp({ id: 'event-1', automation_id: 'a' }, person)).rejects.toThrow(
      /name one item/
    );
    await expect(setRemindersOp({ id: 'event-1', before: ['soon'] }, person)).rejects.toThrow(
      /before\[0\] must be like/
    );
  });
});
