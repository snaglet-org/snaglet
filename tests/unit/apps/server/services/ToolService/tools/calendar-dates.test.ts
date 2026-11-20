/**
 * calendar {op: "dates"} over mocked domain functions: the Year view's marked
 * days (one-off dates, repeats landing a few times a year) by day with what is
 * on each; frequent repeats left out; `from` and `limit`; a year
 * read as windows of at most 62 days one at a time; rows only with table read
 * access, events always.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  Calendar,
  CalendarOccurrence,
  CalendarOccurrencesResponse,
  CalendarRowOccurrence,
} from '@snaglet/shared/types';

const listCalendars = jest.fn<() => Promise<Calendar[]>>();
const listOccurrences =
  jest.fn<(query: Record<string, unknown>) => Promise<CalendarOccurrencesResponse>>();

jest.mock('@server/domains/calendar/calendarService', () => ({
  listCalendars: () => listCalendars(),
}));
jest.mock('@server/domains/calendar/occurrences', () => ({
  listOccurrences: (query: Record<string, unknown>) => listOccurrences(query),
}));

import type { CalendarCaller } from '@server/services/ToolService/handlers/calendar/access';
import { datesOp } from '@server/services/ToolService/handlers/calendar/dates';

const NOW = new Date('2026-10-21T19:00:00Z'); // Wednesday, noon in Los Angeles
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
const home = {
  id: 'cal-home',
  title: 'Home',
  description: '',
  timeZone: 'America/Los_Angeles',
  color: null,
  isDefault: true,
  sortOrder: 0,
  revision: 1,
  createdAt: '',
  updatedAt: '',
  boundFields: [],
} as Calendar;

const next = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function event(
  id: string,
  title: string,
  day: string,
  extra: Partial<CalendarOccurrence> = {}
): CalendarOccurrence {
  return {
    key: `event:${id}:${day}`,
    source: 'event',
    eventId: id,
    revision: 3,
    calendarId: 'cal-home',
    title,
    status: 'upcoming',
    canMove: true,
    canResize: false,
    time: { kind: 'all_day', startDate: day, endDate: next(day) },
    ...extra,
  } as CalendarOccurrence;
}

function row(entry: string, title: string, day: string): CalendarRowOccurrence {
  return {
    key: `row:f:${entry}:${day}`,
    source: 'row',
    calendarId: 'cal-home',
    title,
    status: 'upcoming',
    canMove: true,
    canResize: false,
    tableId: 'table-1111111111111-aaaaaaaaa',
    tableName: 'Tasks',
    projectId: null,
    entryId: entry,
    fieldId: 'field-1111111111111-due',
    range: false,
    hasEnd: false,
    entryRevision: 'abcdef0123456789abcdef',
    schemaVersion: 's1',
    time: { kind: 'all_day', startDate: day, endDate: next(day) },
  } as CalendarRowOccurrence;
}

const reply = (occurrences: CalendarOccurrence[]): CalendarOccurrencesResponse => ({
  from: '',
  to: '',
  tz: 'America/Los_Angeles',
  occurrences,
  intervals: [],
  unavailable: [],
});

type Day = { day: string; items: Array<Record<string, unknown>> };
const run = async (
  occurrences: CalendarOccurrence[],
  input: Record<string, unknown> = {},
  caller: CalendarCaller = person
) => {
  listOccurrences.mockResolvedValue(reply(occurrences));
  return (await datesOp(input, caller, NOW)) as {
    year: number;
    total_days: number;
    days: Day[];
    note?: string;
    hidden?: string[];
  };
};

beforeEach(() => {
  listCalendars.mockReset().mockResolvedValue([home]);
  listOccurrences.mockReset().mockResolvedValue(reply([]));
});

describe('calendar dates', () => {
  it('lists the year’s marked days in order, with what is on each', async () => {
    const out = await run([
      event('e1', 'Wedding', '2026-09-12'),
      event('e2', 'Taxes due', '2026-04-15', {
        repeatSummary: 'Every year',
      } as Partial<CalendarOccurrence>),
      event('e3', 'Review', '2026-04-15'),
    ]);
    expect(out.year).toBe(2026);
    expect(out.days.map((d) => d.day)).toEqual(['2026-04-15', '2026-09-12']);
    expect(out.days[0]!.items.map((i) => i.title).sort()).toEqual(['Review', 'Taxes due']);
    expect(out.days[0]!.items.find((i) => i.title === 'Taxes due')).toMatchObject({
      kind: 'event',
      repeats: 'Every year',
      event_id: 'e2',
      rev: '3',
      calendar: 'Home',
    });
  });

  it('leaves out an event that repeats often', async () => {
    const standup = Array.from({ length: 13 }, (_, i) =>
      event('standup', 'Standup', `2026-01-${String(i + 1).padStart(2, '0')}`)
    );
    const out = await run([...standup, event('one', 'Dinner', '2026-10-24')]);
    expect(out.days.map((d) => d.day)).toEqual(['2026-10-24']);
  });

  it('shows a row with what is needed to act on it', async () => {
    const out = await run([row('entry-1', 'File taxes', '2026-10-22')]);
    expect(out.days[0]!.items[0]).toMatchObject({
      kind: 'table_row',
      table: 'Tasks',
      entry_id: 'entry-1',
      field_id: 'field-1111111111111-due',
      rev: 'abcdef01',
    });
  });

  it('`from` keeps only the days from it, and `date` picks the year', async () => {
    const all = [event('a', 'Early', '2026-02-01'), event('b', 'Late', '2026-11-01')];
    expect((await run(all, { from: '2026-10-21' })).days.map((d) => d.day)).toEqual(['2026-11-01']);
    const other = await run([event('c', 'Next year', '2027-03-01')], { date: '2027-06-01' });
    expect(other.year).toBe(2027);
    expect(other.days.map((d) => d.day)).toEqual(['2027-03-01']);
  });

  it('`limit` shows the first days and says how to continue', async () => {
    const many = ['2026-01-05', '2026-02-05', '2026-03-05'].map((d, i) =>
      event(`e${i}`, `T${i}`, d)
    );
    const out = await run(many, { limit: 2 });
    expect(out.total_days).toBe(3);
    expect(out.days).toHaveLength(2);
    expect(out.note).toMatch(/first 2 days/);
    await expect(datesOp({ limit: 0 }, person, NOW)).rejects.toThrow(/limit must be/);
  });

  it('reads the year as windows of at most 62 days, one after another', async () => {
    let inFlight = 0;
    let peak = 0;
    listOccurrences.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return reply([]);
    });
    await datesOp({}, person, NOW);
    const asked = listOccurrences.mock.calls.map(([q]) => q as { from: string; to: string });
    expect(asked[0]!.from).toBe('2026-01-01');
    expect(asked[asked.length - 1]!.to).toBe('2027-01-01');
    for (const w of asked)
      expect((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000).toBeLessThanOrEqual(62);
    expect(peak).toBe(1);
  });

  it('without table read access it still lists events, leaves rows out, and says so', async () => {
    const out = await run(
      [event('e1', 'Dinner', '2026-10-24'), row('r1', 'Hidden task', '2026-10-25')],
      {},
      noTables
    );
    expect(out.days.map((d) => d.day)).toEqual(['2026-10-24']);
    expect(out.hidden?.[0]).toMatch(/table rows/);
  });

  it('says once when a row repeats more often than once a minute, across its windows', async () => {
    listOccurrences.mockResolvedValue({
      ...reply([]),
      truncated: [
        {
          tableId: 't1',
          fieldId: 'f1',
          entryId: 'e1',
          title: 'Ping',
          shown: 0,
          hidden: true,
        },
      ],
    });
    const out = (await datesOp({}, person, NOW)) as { notes?: string[] };
    expect(out.notes).toEqual([
      '"Ping" repeats more often than once a minute: the calendar lists none of its times; the row and its repeat still work in the table',
    ]);
    // Without table access, rows (and so this) are left out.
    const none = (await datesOp({}, noTables, NOW)) as { notes?: string[] };
    expect(none.notes).toBeUndefined();
  });
});
