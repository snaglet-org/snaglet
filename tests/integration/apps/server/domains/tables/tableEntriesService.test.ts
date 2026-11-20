import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier, TableCatalog } from '@snaglet/db';
import type { TableField } from '@snaglet/shared/types';

const emitEntries = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: (...args: unknown[]) => emitEntries(...args),
}));
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import {
  listTableEntries,
  createTableEntry,
  getTableEntry,
} from '@server/domains/tables/tableEntries';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const LINKED_ID = 'table-1111111111111-bbbbbbbbb';
const ROW_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
let field: TableField;
let schemaVersion: string;
function app(): express.Application {
  const result = express();
  result.use(express.json());
  result.use('/api/tables', tablesRouter);
  result.use(errorHandler);
  return result;
}
async function clean(): Promise<void> {
  // The linked table's relation field references TABLE_ID, so it goes first.
  for (const id of [LINKED_ID, TABLE_ID]) {
    const table = await TableCatalog.findById(id);
    if (table)
      await getDb().query(
        `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
      );
    await getDb().query('DELETE FROM public.table_fields WHERE table_id=$1', [id]);
    await getDb().query('DELETE FROM public.table_catalog WHERE id=$1', [id]);
  }
}

describe('custom entry API and services (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await createTable({ id: TABLE_ID, name: 'entry_table' });
    field = (
      await createTableField(TABLE_ID, {
        id: 'field-1111111111111-aaaaaaaaa',
        name: 'notes',
        description: null,
        type: 'text',
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
      })
    ).field;
    schemaVersion = (await listTableEntries(TABLE_ID)).schemaVersion;
    emitEntries.mockClear();
  });
  afterAll(clean);

  it('creates, reads and replays one row with the same ID and only one after-commit event', async () => {
    const input = {
      id: ROW_ID,
      values: { [field.id]: 'Text [Doc](doc-1111111111111-aaaaaaaaa)' },
      schemaVersion,
    };
    const created = await request(app()).post(`/api/tables/${TABLE_ID}/entries`).send(input);
    expect(created.status).toBe(201);
    expect(created.body.data).not.toHaveProperty('created');
    expect(created.body.data.entry.values[field.id]).toBe(input.values[field.id]);
    const replay = await request(app()).post(`/api/tables/${TABLE_ID}/entries`).send(input);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(created.body.data);
    const found = await request(app()).get(`/api/tables/${TABLE_ID}/entries/${ROW_ID}`);
    expect(found.body.data).toEqual(created.body.data);
    const list = await request(app()).get(`/api/tables/${TABLE_ID}/entries?page=1&pageSize=10`);
    expect(list.body.data).toMatchObject({
      totalCount: 1,
      page: 1,
      pageSize: 10,
      entries: [created.body.data.entry],
      schemaVersion,
    });
    expect(emitEntries).toHaveBeenCalledTimes(1);
    expect(emitEntries).toHaveBeenCalledWith(TABLE_ID, ROW_ID);
  });

  it('patches sparsely, suppresses no-op events and returns current entry details on stale writes', async () => {
    const created = await createTableEntry(TABLE_ID, { id: ROW_ID, values: {}, schemaVersion });
    emitEntries.mockClear();
    const input = {
      values: { [field.id]: 'Saved' },
      schemaVersion,
      expectedRevision: created.entry.revision,
    };
    const saved = await request(app())
      .patch(`/api/tables/${TABLE_ID}/entries/${ROW_ID}`)
      .send(input);
    expect(saved.status).toBe(200);
    expect(saved.body.data).not.toHaveProperty('updated');
    const noop = await request(app())
      .patch(`/api/tables/${TABLE_ID}/entries/${ROW_ID}`)
      .send({ ...input, expectedRevision: saved.body.data.entry.revision });
    expect(noop.body.data).toEqual(saved.body.data);
    const stale = await request(app())
      .patch(`/api/tables/${TABLE_ID}/entries/${ROW_ID}`)
      .send({ ...input, values: { [field.id]: 'Overwrite' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toEqual(saved.body.data);
    expect(emitEntries).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed requests, foreign field keys and JS-number values', async () => {
    const valid = { id: ROW_ID, values: {}, schemaVersion };
    const invalid: object[] = [
      [],
      {},
      { ...valid, id: 'bad' },
      { ...valid, schemaVersion: 'bad' },
      { ...valid, values: [] },
      { ...valid, values: { [field.id]: 1.5 } },
      { ...valid, values: { [field.id]: { nested: 'x' } } },
      { ...valid, values: { unknown: 'x' } },
      { ...valid, values: { [`field-managed-${TABLE_ID}-id`]: OTHER_ID } },
    ];
    for (const input of invalid) {
      const response = await request(app()).post(`/api/tables/${TABLE_ID}/entries`).send(input);
      expect({ input, status: response.status }).toEqual({ input, status: 400 });
    }
    const badRevision = await request(app())
      .patch(`/api/tables/${TABLE_ID}/entries/${ROW_ID}`)
      .send({ values: {}, schemaVersion, expectedRevision: 'bad' });
    expect(badRevision.status).toBe(400);
    expect((await listTableEntries(TABLE_ID)).totalCount).toBe(0);
    expect(emitEntries).not.toHaveBeenCalled();
  });

  it('rejects invalid pagination instead of silently coercing or loading unbounded rows', async () => {
    for (const query of [
      'page=0',
      'page=-1',
      'page=1.5',
      'page=x',
      'page=1&page=2',
      'pageSize=0',
      'pageSize=101',
      'pageSize=1e2',
      'pageSize[]=10',
    ]) {
      const response = await request(app()).get(`/api/tables/${TABLE_ID}/entries?${query}`);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
    }
    expect(
      (await request(app()).get(`/api/tables/${TABLE_ID}/entries?page=2`)).body.data
    ).toMatchObject({ page: 2, entries: [], totalCount: 0 });
  });

  it('refuses built-in entry reads and writes, missing table/row, and a different replay', async () => {
    const input = { id: ROW_ID, values: {}, schemaVersion };
    for (const id of ['table-builtin-docs', 'table-builtin-credentials']) {
      expect((await request(app()).get(`/api/tables/${id}/entries`)).status).toBe(403);
      expect((await request(app()).get(`/api/tables/${id}/entries/${ROW_ID}`)).status).toBe(403);
      expect((await request(app()).post(`/api/tables/${id}/entries`).send(input)).status).toBe(403);
    }
    expect((await request(app()).get('/api/tables/missing/entries')).status).toBe(404);
    expect((await request(app()).get(`/api/tables/${TABLE_ID}/entries/${ROW_ID}`)).status).toBe(
      404
    );
    expect((await request(app()).get(`/api/tables/${TABLE_ID}/entries/bad`)).status).toBe(400);
    await createTableEntry(TABLE_ID, input);
    emitEntries.mockClear();
    const conflict = await request(app())
      .post(`/api/tables/${TABLE_ID}/entries`)
      .send({ ...input, values: { [field.id]: 'Different' } });
    expect(conflict.status).toBe(409);
    expect(emitEntries).not.toHaveBeenCalled();
  });

  it('inserts ahead of beforeEntryId over POST and rejects a malformed one', async () => {
    const post = (body: Record<string, unknown>) =>
      request(app())
        .post(`/api/tables/${TABLE_ID}/entries`)
        .send({ values: {}, schemaVersion, ...body });
    expect((await post({ id: ROW_ID })).status).toBe(201);
    expect((await post({ id: OTHER_ID, beforeEntryId: ROW_ID })).status).toBe(201);
    const listed = await request(app()).get(`/api/tables/${TABLE_ID}/entries`);
    expect(listed.body.data.entries.map((entry: { id: string }) => entry.id)).toEqual([
      OTHER_ID,
      ROW_ID,
    ]);
    const malformed = await post({
      id: '33333333-3333-4333-8333-333333333333',
      beforeEntryId: 'first',
    });
    expect(malformed.status).toBe(400);
  });

  describe('POST /entries/delete', () => {
    const remove = (body: unknown, tableId = TABLE_ID) =>
      request(app())
        .post(`/api/tables/${tableId}/entries/delete`)
        .send(body as object);
    async function ids(): Promise<string[]> {
      return (await listTableEntries(TABLE_ID)).entries.map((entry) => entry.id);
    }

    it('deletes entries atomically, emits once, and reports retries as already deleted', async () => {
      for (const id of [ROW_ID, OTHER_ID, THIRD_ID])
        await createTableEntry(TABLE_ID, { id, values: {}, schemaVersion });
      emitEntries.mockClear();
      const deleted = await remove({ entryIds: [ROW_ID, OTHER_ID] });
      expect(deleted.status).toBe(200);
      expect(deleted.body.data).toEqual({
        deletedIds: [ROW_ID, OTHER_ID],
        alreadyDeleted: [],
        clearedReferences: [],
      });
      expect(emitEntries).toHaveBeenCalledTimes(1);
      expect(emitEntries).toHaveBeenCalledWith(TABLE_ID, [ROW_ID, OTHER_ID]);
      const retry = await remove({ entryIds: [ROW_ID, OTHER_ID] });
      expect(retry.status).toBe(200);
      expect(retry.body.data).toEqual({
        deletedIds: [],
        alreadyDeleted: [ROW_ID, OTHER_ID],
        clearedReferences: [],
      });
      expect(emitEntries).toHaveBeenCalledTimes(1);
      expect(await ids()).toEqual([THIRD_ID]);
    });

    it('returns 409 details for changed or linked entries, then clears links on confirmation', async () => {
      await createTable({ id: LINKED_ID, name: 'linked_table' });
      const link = (
        await createTableField(LINKED_ID, {
          id: 'field-1111111111111-bbbbbbbbb',
          name: 'entry_link',
          description: null,
          type: 'relation',
          nullable: true,
          defaultValue: null,
          referenceTableId: TABLE_ID,
        })
      ).field;
      const { entry } = await createTableEntry(TABLE_ID, { id: ROW_ID, values: {}, schemaVersion });
      const linkedVersion = (await listTableEntries(LINKED_ID)).schemaVersion;
      await createTableEntry(LINKED_ID, {
        id: OTHER_ID,
        values: { [link.id]: ROW_ID },
        schemaVersion: linkedVersion,
      });
      emitEntries.mockClear();

      const stale = await remove({
        entryIds: [ROW_ID],
        expectedRevisions: { [ROW_ID]: 'a'.repeat(64) },
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.details).toEqual({ entries: [entry], schemaVersion });

      const body = { entryIds: [ROW_ID], expectedRevisions: { [ROW_ID]: entry.revision } };
      const linked = await remove(body);
      expect(linked.status).toBe(409);
      expect(linked.body.error.message).toBe(
        '1 link from another entry points to the selected entries. Confirm to remove those links.'
      );
      expect(linked.body.error.details).toEqual({
        references: [
          {
            tableId: LINKED_ID,
            tableName: 'linked_table',
            fieldId: link.id,
            fieldName: 'entry_link',
            count: 1,
          },
        ],
      });
      expect(await ids()).toEqual([ROW_ID]);
      expect(emitEntries).not.toHaveBeenCalled();

      const confirmed = await remove({ ...body, clearReferences: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data).toEqual({
        deletedIds: [ROW_ID],
        alreadyDeleted: [],
        clearedReferences: [{ tableId: LINKED_ID, fieldId: link.id, count: 1 }],
      });
      expect(emitEntries.mock.calls).toEqual([
        [TABLE_ID, [ROW_ID]],
        [LINKED_ID, [OTHER_ID]],
      ]);
      expect((await getTableEntry(LINKED_ID, OTHER_ID)).entry.values[link.id]).toBeNull();
      expect(await ids()).toEqual([]);
    });

    it('rejects malformed bodies, builtins and missing tables without deleting or emitting', async () => {
      await createTableEntry(TABLE_ID, { id: ROW_ID, values: {}, schemaVersion });
      emitEntries.mockClear();
      const one = { entryIds: [ROW_ID] };
      for (const body of [
        [],
        {},
        { entryIds: ROW_ID },
        { entryIds: [] },
        { entryIds: [1] },
        { entryIds: ['bad'] },
        { entryIds: [ROW_ID, ROW_ID] },
        { entryIds: Array.from({ length: 501 }, () => ROW_ID) },
        { ...one, expectedRevisions: [] },
        { ...one, expectedRevisions: { [ROW_ID]: 5 } },
        { ...one, expectedRevisions: { [ROW_ID]: 'bad' } },
        { ...one, clearReferences: 'yes' },
      ]) {
        const result = await remove(body);
        expect({ body, status: result.status }).toEqual({ body, status: 400 });
      }
      expect((await remove(one, 'table-1111111111111-missing')).status).toBe(404);
      for (const id of ['table-builtin-docs', 'table-builtin-credentials'])
        expect((await remove(one, id)).status).toBe(403);
      expect(await ids()).toEqual([ROW_ID]);
      expect(emitEntries).not.toHaveBeenCalled();
    });
  });

  describe('entry names, search and focus over HTTP', () => {
    const TITLE_ID = `field-title-${TABLE_ID}`;
    async function seed(): Promise<void> {
      for (const [id, name] of [
        [ROW_ID, 'Alpha'],
        [OTHER_ID, 'Beta'],
        [THIRD_ID, 'Alphabet'],
      ])
        await createTableEntry(TABLE_ID, { id, values: { [TITLE_ID]: name }, schemaVersion });
    }

    it('routes POST /entries/resolve ahead of the /:id routes and validates refs', async () => {
      await seed();
      const resolve = (body: unknown) =>
        request(app())
          .post('/api/tables/entries/resolve')
          .send(body as object);
      const resolved = await resolve({
        refs: [
          { tableId: TABLE_ID, entryId: ROW_ID },
          { tableId: 'table-builtin-docs', entryId: ROW_ID },
          { tableId: TABLE_ID, entryId: '99999999-9999-4999-8999-999999999999' },
        ],
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body.data).toEqual({
        entries: [{ tableId: TABLE_ID, entryId: ROW_ID, name: 'Alpha', tableName: 'entry_table' }],
      });
      const ref = { tableId: TABLE_ID, entryId: ROW_ID };
      for (const body of [
        {},
        { refs: ref },
        { refs: [] },
        { refs: [ref, 'x'] },
        { refs: [{ tableId: TABLE_ID }] },
        { refs: Array.from({ length: 201 }, () => ref) },
      ]) {
        const result = await resolve(body);
        expect({ body, status: result.status }).toEqual({ body, status: 400 });
      }
    });

    it('routes GET /entries/search ahead of /entries/:entryId and parses its query', async () => {
      await seed();
      const search = (query: string) =>
        request(app()).get(`/api/tables/${TABLE_ID}/entries/search${query}`);
      const found = await search('?q=alp&limit=5');
      expect(found.status).toBe(200);
      expect(found.body.data).toEqual({
        results: [
          { id: ROW_ID, name: 'Alpha', preview: '' },
          { id: THIRD_ID, name: 'Alphabet', preview: '' },
        ],
        hasMore: false,
      });
      expect((await search('')).body.data.results).toHaveLength(3);
      // Comma-separated and repeated `exclude` both parse; `offset` pages what is left.
      const excluded = await search(`?q=alp&exclude=${ROW_ID}`);
      expect(excluded.body.data.results.map((r: { id: string }) => r.id)).toEqual([THIRD_ID]);
      const paged = await search(`?limit=1&offset=1&exclude=${ROW_ID},&exclude=${THIRD_ID}`);
      expect(paged.status).toBe(200);
      expect(paged.body.data).toMatchObject({ results: [], hasMore: false });
      expect((await search('?limit=1')).body.data.hasMore).toBe(true);
      for (const query of [
        '?limit=0',
        '?limit=51',
        '?limit=x',
        '?q=a&q=b',
        `?q=${'x'.repeat(201)}`,
        '?offset=-1',
        '?offset=1.5',
        '?exclude=nope',
      ])
        expect({ query, status: (await search(query)).status }).toEqual({ query, status: 400 });
      expect(
        (await request(app()).get('/api/tables/table-builtin-docs/entries/search')).status
      ).toBe(403);
      expect(
        (await request(app()).get('/api/tables/table-1111111111111-missing/entries/search')).status
      ).toBe(404);
    });

    it('lists the page holding focusEntryId, ignoring page, with related entry names', async () => {
      await seed();
      const list = (query: string) =>
        request(app()).get(`/api/tables/${TABLE_ID}/entries?${query}`);
      const focused = await list(`focusEntryId=${THIRD_ID}&pageSize=2&page=1`);
      expect(focused.status).toBe(200);
      expect(focused.body.data).toMatchObject({ page: 2, pageSize: 2, relatedEntries: {} });
      expect(focused.body.data.entries.map((entry: { id: string }) => entry.id)).toEqual([
        THIRD_ID,
      ]);
      expect((await list('focusEntryId=bad')).status).toBe(400);
      expect(
        (await list('focusEntryId=99999999-9999-4999-8999-999999999999')).body.error.message
      ).toBe('Entry not found');
      const single = await request(app()).get(`/api/tables/${TABLE_ID}/entries/${ROW_ID}`);
      expect(single.body.data).toMatchObject({ entry: { id: ROW_ID }, relatedEntries: {} });
    });
  });

  it('writes and names a list of links over HTTP, refusing non-string lists', async () => {
    const TITLE_ID = `field-title-${TABLE_ID}`;
    const { field: links } = await createTableField(TABLE_ID, {
      id: 'field-1111111111111-ddddddddd',
      name: 'links',
      description: null,
      type: 'relation',
      nullable: true,
      defaultValue: null,
      referenceTableId: TABLE_ID,
      multiple: true,
    });
    const version = (await listTableEntries(TABLE_ID)).schemaVersion;
    await createTableEntry(TABLE_ID, {
      id: OTHER_ID,
      values: { [TITLE_ID]: 'Other' },
      schemaVersion: version,
    });
    const post = (values: Record<string, unknown>) =>
      request(app())
        .post(`/api/tables/${TABLE_ID}/entries`)
        .send({ id: ROW_ID, values, schemaVersion: version });
    expect((await post({ [links.id]: [OTHER_ID, 5] })).status).toBe(400);
    const created = await post({ [links.id]: [OTHER_ID] });
    expect(created.status).toBe(201);
    expect(created.body.data.entry.values[links.id]).toEqual([OTHER_ID]);
    expect(created.body.data.relatedEntries).toEqual({
      [TABLE_ID]: { [OTHER_ID]: { name: 'Other' } },
    });
  });
});
