/**
 * Table rows ("entries") in quick search, over the palette route against real
 * PostgreSQL: `entry:` across every table, `table:<name> entry:` kept to one
 * table (quoted, case- and `_`-insensitive, prefix/contains forgiving, with
 * ambiguous, unknown, archived and Snaglet-table names reported instead of
 * searched), the short Entries section an unfiltered search asks for, and
 * the toolbar search's matching rule: fuzzy Name, contains on other text,
 * select labels, numbers and date prefixes, every word AND-ed. Archived
 * tables and deleted rows never surface; a project scope keeps to that
 * project's tables.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Containers, getDb, quoteIdentifier } from '@snaglet/db';
import { TableSemantic } from '@snaglet/db/tables/table_semantic';
import { PALETTE_ENTRY_STRONG_MATCH_SCORE, type PaletteEntryHit } from '@snaglet/shared/constants';
import type { TableEntryValues, TableField } from '@snaglet/shared/types';

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
import {
  createTableEntry,
  deleteTableEntries,
  listTableEntries,
} from '@server/domains/tables/tableEntries';
import { archiveTable } from '@server/domains/tables/tableLifecycle';
import paletteSearchRouter from '@server/routes/palette-search';
import { errorHandler } from '@server/middleware/errorHandler';

const PROJECT = 'container-1111111111111-aaaaaaaaa';
const LIST = 'table-1111111111111-aaaaaaaaa';
const NOTES = 'table-1111111111111-bbbbbbbbb';
const ARCHIVED = 'table-1111111111111-ccccccccc';
const TABLES = [LIST, NOTES, ARCHIVED];
const entryId = (table: number, n: number) =>
  `0000000${table}-0000-4000-8000-${String(n).padStart(12, '0')}`;

type EntryBody = {
  entries: PaletteEntryHit[];
  executionPlan?: {
    scopeLabel?: string;
    scopeSource?: string;
    scopeId?: string;
    scopeError?: { code: string; message: string; matches?: string[] };
  };
};

function app(): express.Application {
  const value = express();
  value.use(express.json());
  value.use('/api/search/palette', paletteSearchRouter);
  value.use(errorHandler);
  return value;
}

async function search(body: Record<string, unknown>): Promise<EntryBody> {
  const response = await request(app()).post('/api/search/palette').send(body);
  expect(response.status).toBe(200);
  return response.body.data as EntryBody;
}

const names = (body: EntryBody) => body.entries.map((hit) => hit.name);

async function cleanup(): Promise<void> {
  const db = getDb();
  const { rows } = await db.query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = ANY($1::text[])',
    [TABLES]
  );
  for (const row of rows)
    await db.query(`DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`);
  await db.query('DELETE FROM public.table_fields WHERE table_id = ANY($1::text[])', [TABLES]);
  await db.query('DELETE FROM public.table_history');
  await db.query('DELETE FROM public.table_catalog WHERE id = ANY($1::text[])', [TABLES]);
  await db.query('DELETE FROM public.nodes WHERE id = $1', [PROJECT]);
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

/** Add rows by field name ('name' is the Name field) to `tableId`, in order. */
async function addRows(
  tableId: string,
  table: number,
  fields: Record<string, TableField>,
  rows: Array<Record<string, string>>
): Promise<void> {
  const schemaVersion = (await listTableEntries(tableId)).schemaVersion;
  for (const [index, values] of rows.entries()) {
    const byId: TableEntryValues = {};
    for (const [name, value] of Object.entries(values))
      byId[name === 'name' ? `field-title-${tableId}` : fields[name]!.id] = value;
    await createTableEntry(tableId, {
      id: entryId(table, index + 1),
      values: byId,
      schemaVersion,
    });
  }
}

beforeAll(async () => {
  await cleanup();
  await Containers.create({ id: PROJECT, name: 'Test Project', category: 'project' });

  await createTable({ id: LIST, name: 'item_list' });
  const listFields: Record<string, TableField> = {};
  for (const definition of [
    field('aaaaaaaaa', 'owner', 'text'),
    field('bbbbbbbbb', 'status', 'select', { options: [{ label: 'open' }, { label: 'closed' }] }),
    field('ccccccccc', 'size', 'number'),
    field('ddddddddd', 'due', 'date'),
  ]) {
    const { field: created } = await createTableField(LIST, definition);
    listFields[created.name] = created;
  }
  await addRows(LIST, 1, listFields, [
    /* 1 */ { name: 'Orchid plan', owner: 'Test User', status: 'open', size: '1225' },
    /* 2 */ {
      name: 'Garden review',
      owner: 'Orchid team',
      status: 'closed',
      size: '864',
      due: '2026-03-14',
    },
    /* 3 */ { name: 'Lighthouse', owner: 'Test User' },
    /* 4 */ { name: '', owner: 'orchid helper' },
  ]);

  await createTable({ id: NOTES, name: 'item_notes', projectId: PROJECT });
  const { field: body } = await createTableField(NOTES, field('eeeeeeeee', 'body', 'text'));
  await addRows(NOTES, 2, { body }, [
    /* 1 */ { name: 'Orchid notes' },
    /* 2 */ { name: 'Weekly summary', body: 'mentions orchid' },
    /* 3 */ { name: 'Orchid follow-up' },
    /* 4 */ { name: 'Orchid checklist' },
    /* 5 */ { name: 'Orchid retro' },
  ]);

  await createTable({ id: ARCHIVED, name: 'archived_items' });
  await addRows(ARCHIVED, 3, {}, [{ name: 'Orchid archive' }]);
  await archiveTable(ARCHIVED);
});

describe('quick search entries (real DB)', () => {
  // Nested on purpose: a file-level afterAll runs after the shared database
  // teardown has already closed the pool.
  afterAll(cleanup);

  it('entry: finds rows across every live table, Name matches first, each with its table', async () => {
    const body = await search({ query: 'entry: orchid', mode: 'keyword' });

    expect(names(body)).toEqual([
      'Orchid plan',
      'Orchid notes',
      'Orchid follow-up',
      'Orchid checklist',
      'Orchid retro',
      // Matched by another field: the owner, the body, an unnamed row's owner.
      ...names(body).slice(5),
    ]);
    expect(names(body).slice(5).sort()).toEqual(['', 'Garden review', 'Weekly summary']);
    expect(body.entries[0]).toMatchObject({
      tableId: LIST,
      tableName: 'item_list',
      projectId: null,
      entryId: entryId(1, 1),
      name: 'Orchid plan',
    });
    expect(body.entries[1]).toMatchObject({ tableName: 'item_notes', projectId: PROJECT });
    expect(body.entries[0]!.score).toBeGreaterThan(body.entries[7]!.score);
    // The archived table's row never surfaces.
    expect(names(body)).not.toContain('Orchid archive');
  });

  it('matches the Name fuzzily, and select labels, numbers and date prefixes by contains', async () => {
    expect(names(await search({ query: 'entry: lighthose' }))).toEqual(['Lighthouse']);
    expect(names(await search({ query: 'entry: closed' }))).toEqual(['Garden review']);
    expect(names(await search({ query: 'entry: 122' }))).toEqual(['Orchid plan']);
    expect(names(await search({ query: 'entry: 2026-03' }))).toEqual(['Garden review']);
  });

  it('ANDs every word', async () => {
    expect(names(await search({ query: 'entry: orchid closed' }))).toEqual(['Garden review']);
    expect(names(await search({ query: 'entry: orchid 1225' }))).toEqual(['Orchid plan']);
    expect(names(await search({ query: 'entry: orchid lighthouse' }))).toEqual([]);
  });

  it('table:<name> entry: keeps to that table, case- and space-insensitively', async () => {
    const plain = await search({ query: 'table:item_list entry: orchid' });
    expect(names(plain)).toEqual(['Orchid plan', ...names(plain).slice(1)]);
    expect(names(plain).slice(1).sort()).toEqual(['', 'Garden review']);
    expect(plain.entries.every((hit) => hit.tableId === LIST)).toBe(true);
    expect(plain.executionPlan).toMatchObject({
      scopeSource: 'named_table',
      scopeLabel: 'item_list',
      scopeId: LIST,
    });

    const quoted = await search({ query: 'table:"Item List" entry: orchid' });
    expect(quoted.entries.map((hit) => hit.entryId)).toEqual(
      plain.entries.map((hit) => hit.entryId)
    );
    const curly = await search({ query: 'table:“ITEM LIST” entry: orchid' });
    expect(curly.entries).toHaveLength(plain.entries.length);
  });

  it('resolves a unique prefix or contained name, and lists a scoped table with no keywords', async () => {
    const prefix = await search({ query: 'table:item_n entry: orchid' });
    expect(prefix.executionPlan?.scopeLabel).toBe('item_notes');
    expect(prefix.entries.every((hit) => hit.tableId === NOTES)).toBe(true);

    const contained = await search({ query: 'table:notes entry:' });
    expect(contained.executionPlan?.scopeLabel).toBe('item_notes');
    // No keywords: the table's rows in row order.
    expect(names(contained)).toEqual([
      'Orchid notes',
      'Weekly summary',
      'Orchid follow-up',
      'Orchid checklist',
      'Orchid retro',
    ]);
  });

  it('reports an ambiguous, unknown, archived or Snaglet table name instead of searching every table', async () => {
    const ambiguous = await search({ query: 'table:item entry: orchid' });
    expect(ambiguous.entries).toEqual([]);
    expect(ambiguous.executionPlan?.scopeError).toMatchObject({
      code: 'ambiguous',
      matches: ['item_list', 'item_notes'],
    });
    expect(ambiguous.executionPlan?.scopeError?.message).toContain('More than one table');

    const unknown = await search({ query: 'table:"No such table" entry: orchid' });
    expect(unknown.entries).toEqual([]);
    expect(unknown.executionPlan?.scopeError).toMatchObject({
      code: 'not_found',
      message: 'No table named "No such table".',
    });

    const archived = await search({ query: 'table:archived_items entry: orchid' });
    expect(archived.entries).toEqual([]);
    expect(archived.executionPlan?.scopeError?.message).toBe(
      'archived_items is archived. Restore it to search its entries.'
    );

    const builtin = await search({ query: 'table:docs entry: orchid' });
    expect(builtin.entries).toEqual([]);
    expect(builtin.executionPlan?.scopeError?.message).toContain('is a Snaglet table');
  });

  it('keeps entry: to a named project, and refuses a table outside it', async () => {
    const scoped = await search({ query: 'entry: orchid in "Test Project"' });
    expect(scoped.entries.length).toBe(5);
    expect(scoped.entries.every((hit) => hit.tableId === NOTES)).toBe(true);
    expect(scoped.executionPlan).toMatchObject({ scopeLabel: 'Test Project' });

    const conflict = await search({ query: 'table:item_list entry: orchid in "Test Project"' });
    expect(conflict.entries).toEqual([]);
    expect(conflict.executionPlan?.scopeError?.code).toBe('conflict');
  });

  it('searches by meaning only for the entry: search, never for the Entries section of an ordinary search', async () => {
    // The meaning search starts by listing the tables that opted in; the section must never get that far.
    const listSearchable = jest.spyOn(TableSemantic, 'listSearchable');
    try {
      await search({ query: 'orchid', includeEntries: true });
      await search({ query: 'orchid', mode: 'hybrid', includeEntries: true });
      expect(listSearchable).not.toHaveBeenCalled();
      await search({ query: 'entry: orchid' });
      expect(listSearchable).toHaveBeenCalledTimes(1);
    } finally {
      listSearchable.mockRestore();
    }
  });

  it('adds a short Entries section to an unfiltered search only when asked', async () => {
    const section = await search({ query: 'orchid', mode: 'keyword', includeEntries: true });
    expect(names(section)).toEqual([
      'Orchid plan',
      'Orchid notes',
      'Orchid follow-up',
      'Orchid checklist',
      'Orchid retro',
    ]);
    // A strong Name match, which quick search lists near the top, is the whole
    // Name (1) or its start (0.9); a match inside the Name scores below.
    expect(section.entries.map((hit) => hit.score)).toEqual(
      Array(5).fill(PALETTE_ENTRY_STRONG_MATCH_SCORE)
    );
    const whole = await search({ query: 'lighthouse', mode: 'keyword', includeEntries: true });
    expect(whole.entries[0]).toMatchObject({ name: 'Lighthouse', score: 1 });
    const inside = await search({ query: 'plan', mode: 'keyword', includeEntries: true });
    expect(inside.entries[0]).toMatchObject({ name: 'Orchid plan' });
    expect(inside.entries[0]!.score).toBeLessThan(PALETTE_ENTRY_STRONG_MATCH_SCORE);

    expect((await search({ query: 'orchid', mode: 'keyword' })).entries).toEqual([]);
    // A kind filter is not an unfiltered search; one character is too little.
    expect(
      (await search({ query: 'orchid', mode: 'keyword', kinds: ['doc'], includeEntries: true }))
        .entries
    ).toEqual([]);
    expect((await search({ query: 'o', mode: 'keyword', includeEntries: true })).entries).toEqual(
      []
    );
  });

  it('a table: filter alone keeps the Entries section; any other filter does not', async () => {
    const asKind = await search({
      query: 'orchid',
      mode: 'keyword',
      kinds: ['table'],
      includeEntries: true,
    });
    expect(names(asKind)).toContain('Orchid plan');
    const asPrefix = await search({
      query: 'table: orchid',
      mode: 'keyword',
      includeEntries: true,
    });
    expect(names(asPrefix)).toContain('Orchid plan');
    // The rows of a table the words name come first, though the words are not in the rows.
    const ofTable = await search({
      query: 'item_list',
      mode: 'keyword',
      kinds: ['table'],
      includeEntries: true,
    });
    expect(names(ofTable).length).toBeGreaterThan(0);
    expect(ofTable.entries.every((hit) => hit.tableName === 'item_list')).toBe(true);
    // Tables plus another kind is a mixed filter: no rows.
    expect(
      (
        await search({
          query: 'orchid',
          mode: 'keyword',
          kinds: ['table', 'doc'],
          includeEntries: true,
        })
      ).entries
    ).toEqual([]);
  });

  it('never returns a deleted row', async () => {
    expect(names(await search({ query: 'entry: lighthouse' }))).toEqual(['Lighthouse']);
    await deleteTableEntries(LIST, { entryIds: [entryId(1, 3)] });
    expect(names(await search({ query: 'entry: lighthouse' }))).toEqual([]);
  });
});
