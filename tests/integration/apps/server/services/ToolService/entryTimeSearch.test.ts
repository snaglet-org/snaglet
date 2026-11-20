/**
 * search(kinds:["entry"]) with a month phrase against a real database: rows
 * filtered by a date field, soonest first (newest first for a past month), the
 * field named by a word of the query ("due"), the creation-time fallback, and a
 * named month that also finds rows whose text says it.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableEntriesDeleted: jest.fn(),
}));
import { applyAgentSchema, writeAgentEntries } from '@server/domains/tables/tableAgent';
import entrySearch from '@server/services/ToolService/handlers/search/entrySearch';
import { todayInUserZone } from '@server/services/search/entryTimeSearch';
import { searchPaletteEntries } from '@server/services/search/paletteEntrySearch';

async function cleanup(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' }))
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
  await getDb().query('DELETE FROM public.table_semantic_search');
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
}

/** A day in the month `offset` months from today (the user's zone), as `YYYY-MM-DD`. */
function inMonth(offset: number, day = 15): string {
  const [year, month] = todayInUserZone().split('-').map(Number) as [number, number];
  const total = year * 12 + (month - 1) + offset;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

interface Result {
  entries: Array<{ title: string; found_by?: string }>;
  time?: {
    phrase: string;
    range: string;
    from: string;
    before: string;
    date_fields: string[];
    note: string;
  };
  tables_searched: number;
}

async function search(input: Record<string, unknown>): Promise<Result> {
  return JSON.parse(
    (await entrySearch({ kinds: ['entry'], table: 'tasks', ...input }, {}, undefined)) as string
  ) as Result;
}

const titles = (result: Result) => result.entries.map((entry) => entry.title);

/** `tasks` with a title, notes, a `due` date and a `starts` date. */
async function seedTasks(rows: Array<Record<string, string>>): Promise<void> {
  await applyAgentSchema('tasks', {
    fields: [
      { name: 'summary', type: 'text' },
      { name: 'notes', type: 'text' },
      { name: 'due', type: 'date' },
      { name: 'starts', type: 'date' },
    ],
    ops: [{ op: 'set_title_field', name: 'summary' }],
  });
  await writeAgentEntries('tasks', { insert: rows.map((values) => ({ values })) });
}

describe('entry search with a month or week phrase (real DB)', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('"due next month" lists rows due next month, soonest first, and says what it did', async () => {
    await seedTasks([
      { summary: 'Pay rent', due: inMonth(1, 28) },
      { summary: 'File report', due: inMonth(1, 3) },
      { summary: 'Book flights', due: inMonth(0, 20) },
      { summary: 'Annual review', due: inMonth(2, 5) },
      { summary: 'No date at all' },
    ]);
    const result = await search({ query: 'due next month' });
    expect(titles(result)).toEqual(['File report', 'Pay rent']);
    expect(result.time).toMatchObject({
      phrase: 'next month',
      from: inMonth(1, 1),
      before: inMonth(2, 1),
      date_fields: ['due'],
    });
    expect(result.time!.note).toMatch(/due in next month.*soonest first/);
  });

  it('this month and last month; last month is newest first', async () => {
    await seedTasks([
      { summary: 'Early last month', due: inMonth(-1, 2) },
      { summary: 'Late last month', due: inMonth(-1, 25) },
      { summary: 'This month', due: inMonth(0, 10) },
    ]);
    expect(titles(await search({ query: 'tasks due this month' }))).toEqual(['This month']);
    expect(titles(await search({ query: 'what was due last month' }))).toEqual([
      'Late last month',
      'Early last month',
    ]);
  });

  it('"a few months ago" covers two to four months back, not last month', async () => {
    await seedTasks([
      { summary: 'Two months back', due: inMonth(-2) },
      { summary: 'Four months back', due: inMonth(-4) },
      { summary: 'Last month', due: inMonth(-1) },
      { summary: 'Six months back', due: inMonth(-6) },
    ]);
    expect(titles(await search({ query: 'a few months ago' })).sort()).toEqual([
      'Four months back',
      'Two months back',
    ]);
    expect(titles(await search({ query: 'something from 6 months ago' }))).toEqual([
      'Six months back',
    ]);
  });

  it('a named month finds rows dated then and rows whose text says the month, dated rows first', async () => {
    const year = Number(inMonth(0).slice(0, 4)) + 1;
    await seedTasks([
      { summary: 'Dated row', due: `${year}-06-12` },
      { summary: 'June planning', notes: 'all about June', due: `${year}-06-20` },
      { summary: 'Mentions June only', notes: 'we talked about June', due: `${year}-09-01` },
      { summary: 'Dated in July row', due: `${year}-07-04` },
    ]);
    const result = await search({ query: `june ${year}` });
    expect(Object.fromEntries(result.entries.map((e) => [e.title, e.found_by]))).toEqual({
      'June planning': 'both',
      'Dated row': 'date',
      'Mentions June only': 'text',
    });
    // The row that is both comes first; July is not there.
    expect(titles(result)[0]).toBe('June planning');
    expect(titles(result)).not.toContain('Dated in July row');
    expect(result.time!.range).toBe(`June ${year}`);
    expect(result.time!.note).toMatch(/mention "june"/);
  });

  it('a relative month does not match text: only dates count', async () => {
    await seedTasks([
      { summary: 'Says next month in the title', notes: 'next month', due: inMonth(4) },
      { summary: 'Due next month', due: inMonth(1) },
    ]);
    expect(titles(await search({ query: 'next month' }))).toEqual(['Due next month']);
  });

  it('a word of a field name picks that field; with no hint any date field counts', async () => {
    const year = Number(inMonth(0).slice(0, 4)) + 1;
    await seedTasks([
      { summary: 'Due first, starts later', due: `${year}-06-10`, starts: `${year}-08-01` },
      { summary: 'Starts first, due later', due: `${year}-08-20`, starts: `${year}-06-05` },
    ]);
    const hinted = await search({ query: `due in June ${year}` });
    expect(titles(hinted)).toEqual(['Due first, starts later']);
    expect(hinted.time!.date_fields).toEqual(['due']);
    const starting = await search({ query: `starts june ${year}` });
    expect(titles(starting)).toEqual(['Starts first, due later']);
    const either = await search({ query: `june ${year}` });
    expect(titles(either).sort()).toEqual(['Due first, starts later', 'Starts first, due later']);
    expect(either.time!.date_fields.sort()).toEqual(['due', 'starts']);
  });

  it('the other words still have to match the row: "budget due next month"', async () => {
    await seedTasks([
      { summary: 'Budget review', due: inMonth(1, 5) },
      { summary: 'Team offsite', due: inMonth(1, 6) },
    ]);
    expect(titles(await search({ query: 'budget due next month' }))).toEqual(['Budget review']);
  });

  it('a table with no date field falls back to when the row was created', async () => {
    await applyAgentSchema('notes_only', { fields: [{ name: 'summary', type: 'text' }] });
    await writeAgentEntries('notes_only', { insert: [{ values: { name: 'Written today' } }] });
    const now = await search({ table: 'notes_only', query: 'created this month' });
    expect(titles(now)).toEqual(['Written today']);
    expect(now.time!.date_fields).toEqual(['created_at']);
    expect(titles(await search({ table: 'notes_only', query: 'created next month' }))).toEqual([]);
  });

  it('with no table named, month phrases route and search across tables', async () => {
    await seedTasks([{ summary: 'Pay rent', due: inMonth(1, 8) }]);
    const result = await search({ table: undefined, query: 'tasks due next month' });
    expect(titles(result)).toEqual(['Pay rent']);
    expect(result.time?.date_fields).toEqual(['due']);
  });

  it('a query without a month phrase is unchanged', async () => {
    await seedTasks([{ summary: 'Pay rent', due: inMonth(1, 8) }]);
    const result = await search({ query: 'rent' });
    expect(titles(result)).toEqual(['Pay rent']);
    expect(result.time).toBeUndefined();
  });

  it('the palette entry: search understands month phrases too', async () => {
    await seedTasks([
      { summary: 'Pay rent', due: inMonth(1, 8) },
      { summary: 'File report', due: inMonth(1, 2) },
      { summary: 'Later', due: inMonth(3, 2) },
    ]);
    const hits = await searchPaletteEntries({ keywords: 'tasks due next month', limit: 10 });
    expect(hits.map((hit) => hit.name)).toEqual(['File report', 'Pay rent']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    // The month alone searches every table; a named table scopes it.
    const all = await searchPaletteEntries({ keywords: 'next month', limit: 10 });
    expect(all.map((hit) => hit.name)).toEqual(['File report', 'Pay rent']);
    // No month phrase: plain keyword search.
    expect(
      (await searchPaletteEntries({ keywords: 'rent', limit: 10 })).map((hit) => hit.name)
    ).toEqual(['Pay rent']);
  });

  it('before, after and since are open ranges, not "during that month"', async () => {
    const year = Number(inMonth(0).slice(0, 4)) + 1;
    await seedTasks([
      { summary: 'Early', due: `${year}-02-10` },
      { summary: 'Just before', due: `${year}-05-30` },
      { summary: 'In the month', notes: 'June planning', due: `${year}-06-12` },
      { summary: 'After', due: `${year}-08-01` },
    ]);
    // Newest first before the boundary; the row dated in June is not "before June".
    expect(titles(await search({ query: `due before June ${year}` }))).toEqual([
      'Just before',
      'Early',
    ]);
    expect(titles(await search({ query: `due after June ${year}` }))).toEqual(['After']);
    expect(titles(await search({ query: `due since June ${year}` }))).toEqual([
      'In the month',
      'After',
    ]);
    expect(titles(await search({ query: `due by June ${year}` }))).toEqual([
      'In the month',
      'Just before',
      'Early',
    ]);
    // A row that only says June, dated later, is not pulled in by an open range.
    const before = await search({ query: `due before June ${year}` });
    expect(before.time).toMatchObject({ from: null, before: `${year}-06-01` });
    expect(before.time!.note).toMatch(/before 2\d{3}-06-01/);
  });

  describe('weeks', () => {
    /** A day `offset` days from today in the user's zone, as `YYYY-MM-DD`. */
    function inDays(offset: number): string {
      const [y, m, d] = todayInUserZone().split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
    }

    it('this, next and last week are calendar weeks (Monday to Sunday)', async () => {
      await seedTasks([
        { summary: 'Today', due: inDays(0) },
        { summary: 'Next week', due: inDays(7) },
        { summary: 'Last week', due: inDays(-7) },
        { summary: 'Two weeks out', due: inDays(14) },
      ]);
      expect(titles(await search({ query: 'due this week' }))).toEqual(['Today']);
      const next = await search({ query: 'tasks due next week' });
      expect(titles(next)).toEqual(['Next week']);
      expect(next.time).toMatchObject({ phrase: 'next week', date_fields: ['due'] });
      expect(next.time!.range).toMatch(/^next week \(\w{3} \d+ to \w{3} \d+\)$/);
      expect(titles(await search({ query: 'last week' }))).toEqual(['Last week']);
    });

    it('a few weeks ago covers two to four weeks back, not last week or five', async () => {
      await seedTasks([
        { summary: 'Last week', due: inDays(-7) },
        { summary: 'Two weeks back', due: inDays(-14) },
        { summary: 'Three weeks back', due: inDays(-21) },
        { summary: 'Five weeks back', due: inDays(-35) },
      ]);
      expect(titles(await search({ query: 'a few weeks ago' }))).toEqual([
        'Two weeks back',
        'Three weeks back',
      ]);
      expect(titles(await search({ query: '5 weeks ago' }))).toEqual(['Five weeks back']);
    });

    it('rolling windows count from today: the next 2 weeks and the past week', async () => {
      await seedTasks([
        { summary: 'In 3 days', due: inDays(3) },
        { summary: 'In 13 days', due: inDays(13) },
        { summary: 'In 20 days', due: inDays(20) },
        { summary: '3 days ago', due: inDays(-3) },
        { summary: '8 days ago', due: inDays(-8) },
      ]);
      expect(titles(await search({ query: 'due in the next 2 weeks' }))).toEqual([
        'In 3 days',
        'In 13 days',
      ]);
      expect(titles(await search({ query: 'something from the past week' }))).toEqual([
        '3 days ago',
      ]);
    });

    it('open ranges work with weeks, and a row that only says "next week" is not pulled in', async () => {
      await seedTasks([
        { summary: 'Old', due: inDays(-30) },
        { summary: 'Last week', due: inDays(-7) },
        { summary: 'Next week', due: inDays(7) },
        { summary: 'Says next week', notes: 'do it next week', due: inDays(60) },
      ]);
      expect(titles(await search({ query: 'due before this week' }))).toEqual(['Last week', 'Old']);
      expect(titles(await search({ query: 'due after this week' }))).toEqual([
        'Next week',
        'Says next week',
      ]);
      expect(titles(await search({ query: 'next week' }))).toEqual(['Next week']);
    });

    it('the palette entry: search understands week phrases', async () => {
      // Pick days within the same Monday–Sunday week, even when today is Sunday.
      const weekday = new Date(`${inDays(0)}T00:00:00Z`).getUTCDay();
      const nextMonday = 7 - ((weekday + 6) % 7);
      await seedTasks([
        { summary: 'Pay rent', due: inDays(nextMonday) },
        { summary: 'File report', due: inDays(nextMonday + 1) },
        { summary: 'Later', due: inDays(40) },
      ]);
      const hits = await searchPaletteEntries({ keywords: 'tasks due next week', limit: 10 });
      expect(hits.map((hit) => hit.name)).toEqual(['Pay rent', 'File report']);
    });
  });

  describe('days', () => {
    function inDays(offset: number): string {
      const [y, m, d] = todayInUserZone().split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
    }

    it('today, tomorrow and yesterday are single days', async () => {
      await seedTasks([
        { summary: 'Yesterday', due: inDays(-1) },
        { summary: 'Today', due: inDays(0) },
        { summary: 'Tomorrow', due: inDays(1) },
        { summary: 'Next week', due: inDays(7) },
      ]);
      expect(titles(await search({ query: 'tasks due today' }))).toEqual(['Today']);
      expect(titles(await search({ query: 'due tomorrow' }))).toEqual(['Tomorrow']);
      const yesterday = await search({ query: 'due yesterday' });
      expect(titles(yesterday)).toEqual(['Yesterday']);
      expect(yesterday.time).toMatchObject({ phrase: 'yesterday', date_fields: ['due'] });
    });

    it('a few days ago covers two to four days back; 3 days ago and in 2 days are exact', async () => {
      await seedTasks([
        { summary: 'Yesterday', due: inDays(-1) },
        { summary: 'Two back', due: inDays(-2) },
        { summary: 'Four back', due: inDays(-4) },
        { summary: 'Five back', due: inDays(-5) },
        { summary: 'In two', due: inDays(2) },
        { summary: 'In five', due: inDays(5) },
      ]);
      expect(titles(await search({ query: 'a few days ago' }))).toEqual(['Two back', 'Four back']);
      expect(titles(await search({ query: '5 days ago' }))).toEqual(['Five back']);
      expect(titles(await search({ query: 'in 2 days' }))).toEqual(['In two']);
      expect(titles(await search({ query: 'in a few days' }))).toEqual(['In two']);
    });

    it('open ranges and rolling windows work with days', async () => {
      await seedTasks([
        { summary: 'Yesterday', due: inDays(-1) },
        { summary: 'Today', due: inDays(0) },
        { summary: 'In three', due: inDays(3) },
        { summary: 'In nine', due: inDays(9) },
      ]);
      expect(titles(await search({ query: 'before today' }))).toEqual(['Yesterday']);
      expect(titles(await search({ query: 'the next 5 days' }))).toEqual(['Today', 'In three']);
      expect(titles(await search({ query: 'after tomorrow' }))).toEqual(['In three', 'In nine']);
    });

    it('the palette entry: search understands day phrases', async () => {
      await seedTasks([
        { summary: 'Pay rent', due: inDays(1) },
        { summary: 'File report', due: inDays(2) },
      ]);
      const hits = await searchPaletteEntries({ keywords: 'tasks due tomorrow', limit: 10 });
      expect(hits.map((hit) => hit.name)).toEqual(['Pay rent']);
    });
  });

  describe('years', () => {
    /** A day `years` calendar years from today (same month and day), as `YYYY-MM-DD`. */
    function inYears(years: number): string {
      const [y, m, d] = todayInUserZone().split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
    }

    it('this, next and last year are calendar years', async () => {
      await seedTasks([
        { summary: 'Last year', due: inYears(-1) },
        { summary: 'This year', due: inYears(0) },
        { summary: 'Next year', due: inYears(1) },
        { summary: 'Far out', due: inYears(5) },
      ]);
      expect(titles(await search({ query: 'tasks due last year' }))).toEqual(['Last year']);
      expect(titles(await search({ query: 'due next year' }))).toEqual(['Next year']);
      const thisYear = await search({ query: 'due this year' });
      expect(titles(thisYear)).toEqual(['This year']);
      expect(thisYear.time).toMatchObject({ phrase: 'this year', date_fields: ['due'] });
    });

    it('N years ago, a few years ago and in N years', async () => {
      await seedTasks([
        { summary: 'One back', due: inYears(-1) },
        { summary: 'Three back', due: inYears(-3) },
        { summary: 'Six back', due: inYears(-6) },
        { summary: 'In three', due: inYears(3) },
      ]);
      expect(titles(await search({ query: '3 years ago' }))).toEqual(['Three back']);
      expect(titles(await search({ query: 'a few years ago' }))).toEqual(['Three back']);
      expect(titles(await search({ query: 'in 3 years' }))).toEqual(['In three']);
      expect(titles(await search({ query: 'in a few years' }))).toEqual(['In three']);
    });

    it('open ranges work with years, and the palette entry: search understands them', async () => {
      await seedTasks([
        { summary: 'Old', due: inYears(-4) },
        { summary: 'Recent', due: inYears(-1) },
        { summary: 'Soon', due: inYears(1) },
      ]);
      expect(titles(await search({ query: 'before last year' }))).toEqual(['Old']);
      expect(titles(await search({ query: 'since last year' }))).toEqual(['Recent', 'Soon']);
      const hits = await searchPaletteEntries({ keywords: 'tasks due next year', limit: 10 });
      expect(hits.map((hit) => hit.name)).toEqual(['Soon']);
    });
  });

  describe('weekdays', () => {
    const NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    function inDays(offset: number): string {
      const [y, m, d] = todayInUserZone().split('-').map(Number) as [number, number, number];
      return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
    }
    /** Days from today to the next occurrence of weekday `index` (0 Sunday), today counting as 0. */
    function untilNext(index: number): number {
      const [y, m, d] = todayInUserZone().split('-').map(Number) as [number, number, number];
      const today = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return (index - today + 7) % 7;
    }

    it('a bare weekday is its next occurrence and also finds rows that say its name', async () => {
      const target = (new Date(inDays(3)).getUTCDay() + 7) % 7;
      const name = NAMES[target]!;
      const ahead = untilNext(target);
      await seedTasks([
        { summary: 'On the day', due: inDays(ahead) },
        { summary: 'A week later', due: inDays(ahead + 7) },
        {
          summary: `${name[0]!.toUpperCase()}${name.slice(1)} standup notes`,
          due: inDays(ahead + 30),
        },
        { summary: 'Unrelated', due: inDays(ahead + 1) },
      ]);
      const found = await search({ query: `tasks due ${name}` });
      expect(titles(found).slice(0, 1)).toEqual(['On the day']);
      expect(titles(found)).toContain(`${name[0]!.toUpperCase()}${name.slice(1)} standup notes`);
      expect(titles(found)).not.toContain('A week later');
      expect(found.time).toMatchObject({ phrase: name, date_fields: ['due'] });
    });

    it('last <weekday> is the most recent one before today', async () => {
      const target = (new Date(inDays(3)).getUTCDay() + 7) % 7;
      const name = NAMES[target]!;
      const lastOffset = untilNext(target) === 0 ? -7 : untilNext(target) - 7;
      await seedTasks([
        { summary: 'Last one', due: inDays(lastOffset) },
        { summary: 'Before that', due: inDays(lastOffset - 7) },
        { summary: 'Today', due: inDays(0) },
      ]);
      expect(titles(await search({ query: `last ${name}` }))).toEqual(['Last one']);
    });

    it('the palette entry: search understands weekday phrases', async () => {
      const target = (new Date(inDays(3)).getUTCDay() + 7) % 7;
      const name = NAMES[target]!;
      await seedTasks([
        { summary: 'Pay rent', due: inDays(untilNext(target)) },
        { summary: 'Later', due: inDays(untilNext(target) + 8) },
      ]);
      const hits = await searchPaletteEntries({ keywords: `tasks due ${name}`, limit: 10 });
      expect(hits.map((hit) => hit.name)).toEqual(['Pay rent']);
    });
  });
});
