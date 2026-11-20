/**
 * calendar {op: "focus"} over mocked domain functions: what to do next,
 * ranked: overdue rows (longest first), rows due today, rows due tomorrow.
 * Events are left out; done and skipped rows too; no table read access means
 * an empty list with a note.
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
import { focusOp } from '@server/services/ToolService/handlers/calendar/focus';

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

let n = 0;
function row(
  title: string,
  day: string,
  extra: Partial<CalendarRowOccurrence> = {}
): CalendarRowOccurrence {
  n += 1;
  return {
    key: `row:f:${title}:${day}:${n}`,
    source: 'row',
    calendarId: 'cal-home',
    title,
    status: 'upcoming',
    canMove: true,
    canResize: false,
    tableId: 'table-1111111111111-aaaaaaaaa',
    tableName: 'Tasks',
    projectId: null,
    entryId: `entry-${title}`,
    fieldId: 'field-1111111111111-due',
    range: false,
    hasEnd: false,
    entryRevision: 'abcdef0123456789abcdef',
    schemaVersion: 's1',
    time: { kind: 'all_day', startDate: day, endDate: day },
    ...extra,
  } as CalendarRowOccurrence;
}

const event: CalendarOccurrence = {
  key: 'event:e1',
  source: 'event',
  eventId: 'event-1111111111111-aaaaaaaaa',
  revision: 1,
  calendarId: 'cal-home',
  title: 'Dinner',
  time: { kind: 'all_day', startDate: '2026-10-21', endDate: '2026-10-21' },
  status: 'upcoming',
  canMove: true,
  canResize: false,
} as CalendarOccurrence;

const reply = (occurrences: CalendarOccurrence[]): CalendarOccurrencesResponse => ({
  from: '',
  to: '',
  tz: 'America/Los_Angeles',
  occurrences,
  intervals: [],
  unavailable: [],
});

type Item = Record<string, unknown>;
const run = async (occurrences: CalendarOccurrence[], input: Record<string, unknown> = {}) => {
  listOccurrences.mockResolvedValue(reply(occurrences));
  return (await focusOp(input, person, NOW)) as {
    today: string;
    total: number;
    next: Item[];
    coming_up: Item[];
  };
};

beforeEach(() => {
  listCalendars.mockReset().mockResolvedValue([home]);
  listOccurrences.mockReset().mockResolvedValue(reply([]));
});

describe('calendar focus', () => {
  it('ranks overdue (longest first), then due today, then due tomorrow', async () => {
    const out = await run([
      row('Tomorrow task', '2026-10-22'),
      row('Today task', '2026-10-21'),
      row('Late a bit', '2026-10-19'),
      row('Late a lot', '2026-10-05'),
    ]);
    expect(out.next.map((i) => i.title)).toEqual([
      'Late a lot',
      'Late a bit',
      'Today task',
      'Tomorrow task',
    ]);
    expect(out.next.map((i) => i.why)).toEqual([
      'Overdue since 2026-10-05',
      'Overdue since 2026-10-19',
      'Due today',
      'Due tomorrow',
    ]);
    expect(out.next.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
  });

  it('leaves out events, done and skipped rows, and rows further out', async () => {
    const out = await run([
      event,
      row('Done', '2026-10-21', { status: 'done' }),
      row('Skipped', '2026-10-21', { status: 'skipped' }),
      row('Next week', '2026-10-28'),
      row('Real', '2026-10-21'),
    ]);
    expect(out.next.map((i) => i.title)).toEqual(['Real']);
  });

  it('gives what complete_occurrence needs', async () => {
    const out = await run([
      row('Pay rent', '2026-10-21', {
        repeat: { occurrence: '2026-10-21', isCurrent: true, summary: 'Monthly' },
      } as Partial<CalendarRowOccurrence>),
    ]);
    expect(out.next[0]).toMatchObject({
      kind: 'row',
      table: 'Tasks',
      table_id: 'table-1111111111111-aaaaaaaaa',
      entry_id: 'entry-Pay rent',
      field_id: 'field-1111111111111-due',
      rev: 'abcdef01',
      occurrence: '2026-10-21',
      calendar: 'Home',
    });
  });

  it('puts the first `limit` in next and the following ones in coming_up', async () => {
    const out = await run(
      [
        row('A', '2026-10-21'),
        row('B', '2026-10-21'),
        row('C', '2026-10-21'),
        row('D', '2026-10-22'),
      ],
      { limit: 2 }
    );
    expect(out.total).toBe(4);
    expect(out.next).toHaveLength(2);
    expect(out.coming_up).toHaveLength(2);
    await expect(focusOp({ limit: 0 }, person, NOW)).rejects.toThrow(/limit must be/);
  });

  it('reads 30 days back to tomorrow, once, in the zone asked for', async () => {
    // Name the zone: the default is the machine's, which differs between laptops and CI.
    await run([], { tz: 'America/Los_Angeles' });
    expect(listOccurrences).toHaveBeenCalledTimes(1);
    expect(listOccurrences.mock.calls[0]![0]).toMatchObject({
      from: '2026-09-21',
      to: '2026-10-23',
      tz: 'America/Los_Angeles',
    });
  });

  it('gives a caller without table read access an empty list and says why', async () => {
    const out = (await focusOp({}, noTables, NOW)) as { next: unknown[]; hidden: string[] };
    expect(out.next).toEqual([]);
    expect(out.hidden[0]).toMatch(/table rows/);
    expect(listOccurrences).not.toHaveBeenCalled();
  });

  it('says when a row repeats more often than once a minute (the calendar lists none of it)', async () => {
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
    const out = (await focusOp({}, person, NOW)) as { notes?: string[] };
    expect(out.notes).toEqual([
      '"Ping" repeats more often than once a minute: the calendar lists none of its times; the row and its repeat still work in the table',
    ]);
    const quiet = (await run([])) as { notes?: string[] };
    expect(quiet.notes).toBeUndefined();
  });
});
