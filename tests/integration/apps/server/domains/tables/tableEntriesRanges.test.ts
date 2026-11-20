/**
 * Filters, sort and search over date range fields, through the REST route
 * the grid uses, against real PostgreSQL: `is` holds when the range covers
 * the day (a datetime range overlapping the user-zone day), other operators
 * compare the start, sort is by start then end with empty last, `q` matches
 * the start, and search previews show the range.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier, TableEntries } from '@snaglet/db';
import type { TableEntriesResponse, TableField } from '@snaglet/shared/types';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableHistoryChanged: jest.fn(),
}));
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import { createTableEntry, listTableEntries } from '@server/domains/tables/tableEntries';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const TABLE_ID = 'table-1111111111111-rangesaaa';
const NAME_FIELD = `field-title-${TABLE_ID}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The user's zone: neither UTC nor the machine running the tests (+13:00 in October). */
const ZONE = 'Pacific/Auckland';

function app(): express.Application {
  const value = express();
  value.use(express.json());
  value.use('/api/tables', tablesRouter);
  value.use(errorHandler);
  return value;
}

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    "SELECT table_name FROM public.table_catalog WHERE origin = 'custom'"
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await getDb().query('DELETE FROM public.table_history');
}

function mockZone(): void {
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat
  ) {
    return { ...resolved.call(this), timeZone: ZONE };
  });
}

let stay: TableField;
let slot: TableField;

async function list(query: Record<string, string>): Promise<request.Response> {
  return request(app()).get(`/api/tables/${TABLE_ID}/entries`).query(query);
}

/** Entry numbers (1–5) of a listing, in order. */
async function rows(query: Record<string, string>): Promise<number[]> {
  const response = await list({ pageSize: '100', ...query });
  expect(response.status).toBe(200);
  const body = response.body.data as TableEntriesResponse;
  return body.entries.map((entry) => Number(entry.id.slice(-12)));
}

const where = (field: TableField, operator: string, value?: string) => ({
  where: JSON.stringify([{ fieldId: field.id, operator, ...(value !== undefined && { value }) }]),
});
const sort = (field: TableField, direction: 'asc' | 'desc') => ({
  sort: `${field.id}:${direction}`,
});

describe('date range fields in lists (real DB)', () => {
  beforeAll(async () => {
    mockZone();
    await clean();
    await createTable({ id: TABLE_ID, name: 'range_items' });
    const base = { description: null, nullable: true, defaultValue: null, referenceTableId: null };
    ({ field: stay } = await createTableField(TABLE_ID, {
      ...base,
      id: 'field-1111111111111-stay',
      name: 'stay',
      type: 'date',
      range: true,
    }));
    ({ field: slot } = await createTableField(TABLE_ID, {
      ...base,
      id: 'field-1111111111111-slot',
      name: 'slot',
      type: 'datetime',
      range: true,
    }));
    const schemaVersion = (await listTableEntries(TABLE_ID)).schemaVersion;
    const values: Array<[string, string | null, string | null]> = [
      /* 1 */ ['Harbor', '2026-10-12/2026-10-15', '2026-10-12T09:00/2026-10-12T10:30'],
      /* 2 */ ['Ferry', '2026-10-12', '2026-10-12T09:00'],
      // Ends at local midnight: it does not reach the 14th.
      /* 3 */ ['Ridge', '2026-10-14/2026-10-20', '2026-10-13T22:00/2026-10-14T00:00'],
      /* 4 */ ['Empty', null, null],
      /* 5 */ ['Month', '2026-10-01/2026-10-31', '2026-10-14T23:30/2026-10-15T01:00'],
    ];
    for (const [index, [name, day, time]] of values.entries())
      await createTableEntry(TABLE_ID, {
        id: id(index + 1),
        values: { [NAME_FIELD]: name, [stay.id]: day, [slot.id]: time },
        schemaVersion,
      });
    jest.restoreAllMocks();
  });
  beforeEach(mockZone);
  afterEach(() => jest.restoreAllMocks());
  afterAll(clean);

  it('lists ranges in their wire form', async () => {
    const response = await list({ pageSize: '100' });
    const body = response.body.data as TableEntriesResponse;
    expect(body.entries.map((entry) => [entry.values[stay.id], entry.values[slot.id]])).toEqual([
      ['2026-10-12/2026-10-15', '2026-10-11T20:00:00.000000Z/2026-10-11T21:30:00.000000Z'],
      ['2026-10-12', '2026-10-11T20:00:00.000000Z'],
      ['2026-10-14/2026-10-20', '2026-10-13T09:00:00.000000Z/2026-10-13T11:00:00.000000Z'],
      [null, null],
      ['2026-10-01/2026-10-31', '2026-10-14T10:30:00.000000Z/2026-10-14T12:00:00.000000Z'],
    ]);
  });

  it('matches a date range by the days it covers, and compares its start otherwise', async () => {
    expect(await rows(where(stay, 'is', '2026-10-13'))).toEqual([1, 5]);
    expect(await rows(where(stay, 'is', '2026-10-12'))).toEqual([1, 2, 5]);
    // The end day is included.
    expect(await rows(where(stay, 'is', '2026-10-15'))).toEqual([1, 3, 5]);
    expect(await rows(where(stay, 'is', '2026-10-20'))).toEqual([3, 5]);
    expect(await rows(where(stay, 'before', '2026-10-12'))).toEqual([5]);
    expect(await rows(where(stay, 'after', '2026-10-12'))).toEqual([3]);
    expect(await rows(where(stay, 'on_or_before', '2026-10-12'))).toEqual([1, 2, 5]);
    expect(await rows(where(stay, 'on_or_after', '2026-10-12'))).toEqual([1, 2, 3]);
    expect(await rows(where(stay, 'is_empty'))).toEqual([4]);
    expect(await rows(where(stay, 'is_not_empty'))).toEqual([1, 2, 3, 5]);
  });

  it('matches a datetime range by the local days it overlaps, and compares its start day otherwise', async () => {
    expect(await rows(where(slot, 'is', '2026-10-12'))).toEqual([1, 2]);
    expect(await rows(where(slot, 'is', '2026-10-13'))).toEqual([3]);
    // Row 3 ends at midnight, so the 14th is only row 5's.
    expect(await rows(where(slot, 'is', '2026-10-14'))).toEqual([5]);
    expect(await rows(where(slot, 'is', '2026-10-15'))).toEqual([5]);
    expect(await rows(where(slot, 'before', '2026-10-13'))).toEqual([1, 2]);
    expect(await rows(where(slot, 'after', '2026-10-13'))).toEqual([5]);
    expect(await rows(where(slot, 'on_or_after', '2026-10-13'))).toEqual([3, 5]);
    expect(await rows(where(slot, 'is_empty'))).toEqual([4]);
    expect((await list(where(slot, 'before', '2026-10-13/2026-10-14'))).status).toBe(400);
  });

  it('sorts by start, then end, with empty ranges last both ways', async () => {
    expect(await rows(sort(stay, 'asc'))).toEqual([5, 2, 1, 3, 4]);
    expect(await rows(sort(stay, 'desc'))).toEqual([3, 1, 2, 5, 4]);
    // Rows 1 and 2 start together; the single instant ends first.
    expect(await rows(sort(slot, 'asc'))).toEqual([2, 1, 3, 5, 4]);
    expect(await rows(sort(slot, 'desc'))).toEqual([5, 3, 1, 2, 4]);
  });

  it('matches search terms against the start, dates as ISO prefixes and datetimes locally', async () => {
    expect(await rows({ q: '2026-10-14' })).toEqual([3, 5]);
    expect(await rows({ q: '2026-10-12' })).toEqual([1, 2]);
    expect(await rows({ q: '23:30' })).toEqual([5]);
    // The end is not searched.
    expect(await rows({ q: '2026-10-31' })).toEqual([]);
  });

  it('previews ranges in search results, datetimes in the user zone', async () => {
    const { results } = await TableEntries.searchEntries(TABLE_ID, { q: 'harbor' });
    expect(results).toEqual([
      {
        id: id(1),
        name: 'Harbor',
        preview: '2026-10-12/2026-10-15 · 2026-10-12 09:00/2026-10-12 10:30',
      },
    ]);
    const single = await TableEntries.searchEntries(TABLE_ID, { q: 'ferry' });
    expect(single.results[0]?.preview).toBe('2026-10-12 · 2026-10-12 09:00');
    const empty = await TableEntries.searchEntries(TABLE_ID, { q: 'empty' });
    expect(empty.results[0]?.preview).toBe('');
  });
});
