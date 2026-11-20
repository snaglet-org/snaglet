/**
 * The entry list's `q` filter over the REST route the grid uses, against real
 * PostgreSQL: fuzzy Name matching, AND across words, select, number, date,
 * datetime and linked-Name matches, literal `%`/`_`, paging over the matches,
 * full-table row numbers, and entries kept listed while filtering.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { TableEntriesResponse, TableEntryValues, TableField } from '@snaglet/shared/types';

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

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const LINKED_ID = 'table-1111111111111-bbbbbbbbb';
const NAME_FIELD = `field-title-${TABLE_ID}`;
const LINKED_NAME_FIELD = `field-title-${LINKED_ID}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LINKED_ENTRY = '99999999-9999-4999-8999-999999999999';

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

function field(key: string, name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id: `field-1111111111111-${key}`,
    name,
    description: null,
    type,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    ...extra,
  };
}

let fields: Record<string, TableField>;

/** GET the entry list with these query parameters. */
async function list(query: Record<string, string>): Promise<request.Response> {
  return request(app()).get(`/api/tables/${TABLE_ID}/entries`).query(query);
}

async function filtered(q: string, extra: Record<string, string> = {}) {
  const response = await list({ q, ...extra });
  expect(response.status).toBe(200);
  const body = response.body.data as TableEntriesResponse;
  return {
    ...body,
    names: body.entries.map((entry) => entry.values[NAME_FIELD]),
    numbers: body.entries.map((entry) => body.rowNumbers?.[entry.id]),
  };
}

describe('entry list filter (real DB)', () => {
  beforeAll(async () => {
    await clean();
    await createTable({ id: LINKED_ID, name: 'linked_items' });
    const linkedVersion = (await listTableEntries(LINKED_ID)).schemaVersion;
    await createTableEntry(LINKED_ID, {
      id: LINKED_ENTRY,
      values: { [LINKED_NAME_FIELD]: 'Orion' },
      schemaVersion: linkedVersion,
    });

    await createTable({ id: TABLE_ID, name: 'filter_items' });
    const definitions = [
      field('aaaaaaaaa', 'notes', 'text'),
      field('bbbbbbbbb', 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] }),
      field('ccccccccc', 'tags', 'select', {
        multiple: true,
        defaultValue: [],
        options: [{ label: 'crimson' }, { label: 'teal' }],
      }),
      field('ddddddddd', 'amount', 'number'),
      field('eeeeeeeee', 'due', 'date'),
      field('fffffffff', 'meets', 'datetime'),
      field('ggggggggg', 'item', 'relation', { referenceTableId: LINKED_ID }),
    ];
    const created: Array<{ field: TableField }> = [];
    for (const definition of definitions)
      created.push(await createTableField(TABLE_ID, definition));
    fields = Object.fromEntries(created.map(({ field: value }) => [value.name, value]));
    const schemaVersion = (await listTableEntries(TABLE_ID)).schemaVersion;
    const rows: TableEntryValues[] = [
      /* 1 */ { name: 'Project Alpha', status: 'done', amount: '12.50', due: '2026-09-15' },
      /* 2 */ { name: '', notes: 'batch one' },
      /* 3 */ { name: 'Alpha launch', status: 'todo', amount: '100', due: '2026-10-01' },
      /* 4 */ {
        name: 'Beta review',
        status: 'done',
        notes: '50% complete batch',
        tags: ['crimson'],
      },
      /* 5 */ { name: 'Gamma', notes: 'a_b literal' },
      /* 6 */ { name: 'Delta', notes: 'axb and 500 units batch' },
      /* 7 */ { name: '', meets: '2026-07-04T12:00:00Z' },
      /* 8 */ { name: 'Product launch', notes: 'batch', item: LINKED_ENTRY },
      /* 9 */ { name: 'Protect plan' },
    ];
    for (const [index, values] of rows.entries()) {
      const byId: TableEntryValues = {};
      for (const [name, value] of Object.entries(values))
        byId[name === 'name' ? NAME_FIELD : fields[name].id] = value;
      await createTableEntry(TABLE_ID, { id: id(index + 1), values: byId, schemaVersion });
    }
  });
  afterAll(clean);

  it('lists every entry without q, and no row numbers', async () => {
    const response = await list({ page: '1', pageSize: '100' });
    expect(response.status).toBe(200);
    expect(response.body.data.totalCount).toBe(9);
    expect(response.body.data).not.toHaveProperty('rowNumbers');
    const blank = await filtered('   ');
    expect(blank.totalCount).toBe(9);
    expect(blank).not.toHaveProperty('rowNumbers');
  });

  it('matches the Name fuzzily, so a typo still finds it', async () => {
    const result = await filtered('projct');
    expect(result.names).toEqual(['Project Alpha']);
    expect(result.numbers).toEqual([1]);
    // Short words, words with digits and quoted phrases only match as written.
    expect((await filtered('Gam')).names).toEqual(['Gamma']);
    expect((await filtered('"projct"')).names).toEqual([]);
  });

  it('requires every word to match some field, in row order', async () => {
    expect((await filtered('alpha')).names).toEqual(['Project Alpha', 'Alpha launch']);
    const result = await filtered('alpha done');
    expect(result.names).toEqual(['Project Alpha']);
    expect(result.totalCount).toBe(1);
    expect((await filtered('ALPHA TODO')).names).toEqual(['Alpha launch']);
    expect((await filtered('"alpha launch"')).names).toEqual(['Alpha launch']);
  });

  it('matches select labels, numbers, date and datetime prefixes, and linked names', async () => {
    expect((await filtered('todo')).names).toEqual(['Alpha launch']);
    expect((await filtered('crimson')).names).toEqual(['Beta review']);
    expect((await filtered('12.5')).names).toEqual(['Project Alpha']);
    expect((await filtered('2026-09')).names).toEqual(['Project Alpha']);
    expect((await filtered('2026-10-01')).names).toEqual(['Alpha launch']);
    // A datetime matches its date in the user's time zone (noon UTC stays on that date).
    expect((await filtered('2026-07-04')).numbers).toEqual([7]);
    expect((await filtered('orion')).names).toEqual(['Product launch']);
  });

  it('treats % and _ literally', async () => {
    expect((await filtered('50%')).names).toEqual(['Beta review']);
    expect((await filtered('a_b')).names).toEqual(['Gamma']);
    expect((await filtered('%')).names).toEqual(['Beta review']);
  });

  it('pages over the matches and keeps full-table row numbers', async () => {
    const first = await filtered('batch', { page: '1', pageSize: '2' });
    expect(first.totalCount).toBe(4);
    expect(first.page).toBe(1);
    expect(first.entries.map((entry) => entry.id)).toEqual([id(2), id(4)]);
    expect(first.rowNumbers).toEqual({ [id(2)]: 2, [id(4)]: 4 });
    const second = await filtered('batch', { page: '2', pageSize: '2' });
    expect(second.entries.map((entry) => entry.id)).toEqual([id(6), id(8)]);
    expect(second.rowNumbers).toEqual({ [id(6)]: 6, [id(8)]: 8 });
    const beyond = await filtered('batch', { page: '5', pageSize: '2' });
    expect(beyond.entries).toEqual([]);
    expect(beyond.totalCount).toBe(4);
  });

  it('matches an unnamed entry by its "Untitled N" label', async () => {
    const result = await filtered('untitled');
    expect(result.numbers).toEqual([2, 7]);
    expect((await filtered('"untitled 7"')).numbers).toEqual([7]);
  });

  it('lists kept entries even when they do not match', async () => {
    const result = await filtered('gamma', { keep: `${id(9)},${id(1).toUpperCase()}` });
    expect(result.names).toEqual(['Project Alpha', 'Gamma', 'Protect plan']);
    expect(result.numbers).toEqual([1, 5, 9]);
    expect(result.totalCount).toBe(3);
  });

  it('shows no matches as an empty list', async () => {
    const result = await filtered('nothing-here');
    expect(result.entries).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.rowNumbers).toEqual({});
  });

  describe('sort', () => {
    const sortBy = (...levels: Array<[string, 'asc' | 'desc']>) =>
      levels
        .map(([name, dir]) => `${name === 'name' ? NAME_FIELD : fields[name].id}:${dir}`)
        .join(',');
    const order = async (query: Record<string, string>) => {
      const response = await list({ pageSize: '100', ...query });
      expect(response.status).toBe(200);
      const body = response.body.data as TableEntriesResponse;
      return body.entries.map((entry) => Number(entry.id.slice(-12)));
    };

    it('sorts text A–Z and Z–A, case-insensitively, empty names last both ways', async () => {
      expect(await order({ sort: sortBy(['name', 'asc']) })).toEqual([3, 4, 6, 5, 8, 1, 9, 2, 7]);
      expect(await order({ sort: sortBy(['name', 'desc']) })).toEqual([9, 1, 8, 5, 6, 4, 3, 2, 7]);
    });

    it('sorts a select by its option order, not alphabetically', async () => {
      // Options are todo, done: todo first ascending; empty last; ties keep row order.
      expect(await order({ sort: sortBy(['status', 'asc']) })).toEqual([3, 1, 4, 2, 5, 6, 7, 8, 9]);
      expect(await order({ sort: sortBy(['status', 'desc']) })).toEqual([
        1, 4, 3, 2, 5, 6, 7, 8, 9,
      ]);
    });

    it('sorts numbers numerically and dates chronologically', async () => {
      expect(await order({ sort: sortBy(['amount', 'asc']) })).toEqual([1, 3, 2, 4, 5, 6, 7, 8, 9]);
      expect(await order({ sort: sortBy(['amount', 'desc']) })).toEqual([
        3, 1, 2, 4, 5, 6, 7, 8, 9,
      ]);
      expect(await order({ sort: sortBy(['due', 'desc']) })).toEqual([3, 1, 2, 4, 5, 6, 7, 8, 9]);
    });

    it('uses later levels only to break ties of earlier ones', async () => {
      // status desc groups done (1, 4) then todo (3); name desc reorders only within done.
      expect(await order({ sort: sortBy(['status', 'desc'], ['name', 'desc']) })).toEqual([
        1, 4, 3, 9, 8, 5, 6, 2, 7,
      ]);
    });

    it('combines with search, keeping full-table row numbers', async () => {
      const result = await filtered('batch', { sort: sortBy(['name', 'asc']) });
      expect(result.names).toEqual(['Beta review', 'Delta', 'Product launch', '']);
      expect(result.numbers).toEqual([4, 6, 8, 2]);
    });

    it('pages over the sorted order and finds a focused entry on its sorted page', async () => {
      const sort = sortBy(['name', 'asc']);
      expect(await order({ sort, pageSize: '4', page: '2' })).toEqual([8, 1, 9, 2]);
      const response = await list({ sort, pageSize: '4', focusEntryId: id(9) });
      expect(response.status).toBe(200);
      expect(response.body.data.page).toBe(2);
    });

    it('refuses unknown, repeated, multi-value or malformed levels', async () => {
      expect((await list({ sort: 'field-0000000000000-nope:asc' })).status).toBe(400);
      expect((await list({ sort: sortBy(['name', 'asc'], ['name', 'desc']) })).status).toBe(400);
      expect((await list({ sort: sortBy(['tags', 'asc']) })).status).toBe(400);
      expect((await list({ sort: `${NAME_FIELD}:up` })).status).toBe(400);
    });
  });

  describe('where (field conditions)', () => {
    const cond = (name: string, operator: string, value?: string | boolean) => ({
      fieldId: name === 'name' ? NAME_FIELD : fields[name].id,
      operator,
      ...(value !== undefined && { value }),
    });
    const ids = async (query: Record<string, string>) => {
      const response = await list({ pageSize: '100', ...query });
      expect(response.status).toBe(200);
      const body = response.body.data as TableEntriesResponse;
      return body.entries.map((entry) => Number(entry.id.slice(-12)));
    };
    const where = (...conditions: object[]) => ({ where: JSON.stringify(conditions) });

    it('filters text, select, number, date and emptiness', async () => {
      expect(await ids(where(cond('notes', 'contains', 'batch')))).toEqual([2, 4, 6, 8]);
      expect(await ids(where(cond('name', 'starts_with', 'alpha')))).toEqual([3]);
      expect(await ids(where(cond('status', 'is', 'done')))).toEqual([1, 4]);
      expect(await ids(where(cond('status', 'is_not', 'done')))).toEqual([2, 3, 5, 6, 7, 8, 9]);
      expect(await ids(where(cond('tags', 'contains', 'crimson')))).toEqual([4]);
      expect(await ids(where(cond('amount', 'gt', '50')))).toEqual([3]);
      expect(await ids(where(cond('amount', 'lte', '12.5')))).toEqual([1]);
      expect(await ids(where(cond('due', 'before', '2026-10-01')))).toEqual([1]);
      expect(await ids(where(cond('due', 'on_or_after', '2026-10-01')))).toEqual([3]);
      expect(await ids(where(cond('item', 'is_not_empty')))).toEqual([8]);
      expect(await ids(where(cond('name', 'is_empty')))).toEqual([2, 7]);
    });

    it('ANDs conditions and combines with search, sort and row numbers', async () => {
      expect(
        await ids(where(cond('notes', 'contains', 'batch'), cond('name', 'is_not_empty')))
      ).toEqual([4, 6, 8]);
      expect(await ids({ q: 'launch', ...where(cond('status', 'is', 'todo')) })).toEqual([3]);
      const sorted = await ids({
        ...where(cond('notes', 'contains', 'batch')),
        sort: `${NAME_FIELD}:desc`,
      });
      expect(sorted).toEqual([8, 6, 4, 2]);
      const response = await list(where(cond('status', 'is', 'done')));
      expect(response.body.data.totalCount).toBe(2);
      expect(response.body.data.rowNumbers).toEqual({ [id(1)]: 1, [id(4)]: 4 });
    });

    it('keeps saved entries listed even when they stop matching', async () => {
      expect(await ids({ ...where(cond('status', 'is', 'done')), keep: id(9) })).toEqual([1, 4, 9]);
    });

    it('opens a focused entry on its page within the filtered list', async () => {
      const response = await list({
        ...where(cond('notes', 'contains', 'batch')),
        pageSize: '2',
        focusEntryId: id(8),
      });
      expect(response.status).toBe(200);
      expect(response.body.data.page).toBe(2);
    });

    it('refuses unknown fields, wrong operators and bad values', async () => {
      expect(
        (await list(where({ fieldId: 'field-0000000000000-nope', operator: 'is', value: 'x' })))
          .status
      ).toBe(400);
      expect((await list(where(cond('amount', 'contains', '5')))).status).toBe(400);
      expect((await list(where(cond('amount', 'gt', 'many')))).status).toBe(400);
      expect((await list(where(cond('due', 'before', 'next week')))).status).toBe(400);
      expect((await list({ where: 'not json' })).status).toBe(400);
    });
  });

  it('refuses oversized or conflicting filters', async () => {
    expect((await list({ q: 'x'.repeat(201) })).status).toBe(400);
    expect((await list({ q: 'alpha', focusEntryId: id(1) })).status).toBe(400);
    expect((await list({ q: 'alpha', keep: 'not-a-uuid' })).status).toBe(400);
    expect(
      (await list({ q: Array.from({ length: 17 }, (_, n) => `w${n}`).join(' ') })).status
    ).toBe(400);
  });
});
