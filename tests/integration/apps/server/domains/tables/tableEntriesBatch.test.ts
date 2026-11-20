/**
 * Batch entry create (`POST /api/tables/:id/entries/batch`, the grid's paste)
 * against real PostgreSQL: rows land in request order right after the anchor
 * or at the end, all or nothing, as one undo step, idempotent on their ids,
 * with one realtime change and a create hook event per new row.
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
import { hooks, type HookEventMap } from '@server/services/HookService';
import {
  DOC_A,
  cleanReferenceFixtures,
  seedReferenceFixtures,
} from '../../../../../support/tableReferenceFixtures';

const emitEntries = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: (...args: unknown[]) => emitEntries(...args),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableHistoryChanged: jest.fn(),
}));
import { createTable } from '@server/domains/tables/tableCatalog';
import { createTableField } from '@server/domains/tables/tableFields';
import { createTableEntry, listTableEntries } from '@server/domains/tables/tableEntries';
import { listTableHistory, stepTableHistory } from '@server/domains/tables/tableHistory';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const TABLE_ID = 'table-1111111111111-batchaaaa';
const NAME = `field-title-${TABLE_ID}`;
const DOC_FIELD = 'field-1111111111111-docaaaaa';
const LINKS_FIELD = 'field-1111111111111-linksaaa';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const NEW_1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const NEW_2 = 'aaaaaaaa-2222-4222-8222-222222222222';
const NEW_3 = 'aaaaaaaa-3333-4333-8333-333333333333';

type Created = HookEventMap['table_entry:create'];
const created: Created[] = [];
const onCreate = (event: Created) => void created.push(event);

function app(): express.Application {
  const result = express();
  result.use(express.json());
  result.use('/api/tables', tablesRouter);
  result.use(errorHandler);
  return result;
}

const post = (body: unknown) =>
  request(app()).post(`/api/tables/${TABLE_ID}/entries/batch`).send(body);

async function schemaVersion(): Promise<string> {
  return (await listTableEntries(TABLE_ID)).schemaVersion;
}

/** Names in row order. */
async function names(): Promise<unknown[]> {
  const page = await listTableEntries(TABLE_ID, { pageSize: '100' });
  return page.entries.map((entry) => entry.values[NAME]);
}

async function rowCount(): Promise<number> {
  return (await listTableEntries(TABLE_ID)).totalCount;
}

describe('batch entry create (real DB)', () => {
  beforeAll(() => {
    hooks.on('table_entry:create', onCreate);
  });

  beforeEach(async () => {
    await cleanReferenceFixtures();
    await seedReferenceFixtures();
    await createTable({ id: TABLE_ID, name: 'batch_table' });
    await createTableField(TABLE_ID, {
      id: DOC_FIELD,
      name: 'doc',
      description: null,
      type: 'relation',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
      referenceKind: 'doc',
    });
    await createTableField(TABLE_ID, {
      id: LINKS_FIELD,
      name: 'links',
      description: null,
      type: 'relation',
      nullable: false,
      defaultValue: [],
      referenceTableId: TABLE_ID,
      multiple: true,
    });
    const version = await schemaVersion();
    for (const [id, name] of [
      [A, 'a'],
      [B, 'b'],
      [C, 'c'],
    ] as const)
      await createTableEntry(TABLE_ID, { id, values: { [NAME]: name }, schemaVersion: version });
    emitEntries.mockClear();
    created.length = 0;
  });

  afterEach(() => {
    created.length = 0;
  });

  afterAll(async () => {
    hooks.off('table_entry:create', onCreate);
    await cleanReferenceFixtures();
  });

  it('places the rows in order right after the anchor, as one undo step', async () => {
    const response = await post({
      entries: [
        { id: NEW_1, values: { [NAME]: 'a copy', [LINKS_FIELD]: [C, B] } },
        { id: NEW_2, values: { [NAME]: 'b copy', [DOC_FIELD]: DOC_A } },
      ],
      schemaVersion: await schemaVersion(),
      afterEntryId: A,
    });
    expect(response.status).toBe(201);
    expect(response.body.data).not.toHaveProperty('created');
    expect(response.body.data).not.toHaveProperty('createdIds');
    expect(response.body.data.entries.map((entry: { id: string }) => entry.id)).toEqual([
      NEW_1,
      NEW_2,
    ]);
    expect(response.body.data.entries[0].values[LINKS_FIELD]).toEqual([C, B]);
    expect(response.body.data.relatedEntries[TABLE_ID]).toMatchObject({
      [B]: { name: 'b' },
      [C]: { name: 'c' },
    });
    expect(await names()).toEqual(['a', 'a copy', 'b copy', 'b', 'c']);
    expect(emitEntries).toHaveBeenCalledTimes(1);
    expect(emitEntries).toHaveBeenCalledWith(TABLE_ID, [NEW_1, NEW_2]);
    expect(created).toEqual([
      { tableId: TABLE_ID, entryId: NEW_1 },
      { tableId: TABLE_ID, entryId: NEW_2 },
    ]);

    const history = await listTableHistory();
    expect(history.undo).toMatchObject({
      kind: 'entry.write',
      label: 'Add 2 entries in batch_table',
      state: 'done',
    });
    await stepTableHistory('undo', { stepId: history.undo?.id });
    expect(await names()).toEqual(['a', 'b', 'c']);
    await stepTableHistory('redo', {});
    expect(await names()).toEqual(['a', 'a copy', 'b copy', 'b', 'c']);
  });

  it('appends after the last row, or at the end without an anchor', async () => {
    const version = await schemaVersion();
    const afterLast = await post({
      entries: [{ id: NEW_1, values: { [NAME]: 'after c' } }],
      schemaVersion: version,
      afterEntryId: C,
    });
    expect(afterLast.status).toBe(201);
    const appended = await post({
      entries: [
        { id: NEW_2, values: { [NAME]: 'end 1' } },
        { id: NEW_3, values: { [NAME]: 'end 2' } },
      ],
      schemaVersion: version,
    });
    expect(appended.status).toBe(201);
    expect(await names()).toEqual(['a', 'b', 'c', 'after c', 'end 1', 'end 2']);
  });

  it('replays the same batch without writing, emitting or recording again', async () => {
    const body = {
      entries: [
        { id: NEW_1, values: { [NAME]: 'one' } },
        { id: NEW_2, values: { [NAME]: 'two' } },
      ],
      schemaVersion: await schemaVersion(),
      afterEntryId: A,
    };
    const first = await post(body);
    expect(first.status).toBe(201);
    const step = (await listTableHistory()).undo;
    emitEntries.mockClear();
    created.length = 0;
    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await names()).toEqual(['a', 'one', 'two', 'b', 'c']);
    expect(emitEntries).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect((await listTableHistory()).undo?.id).toBe(step?.id);
  });

  it('writes nothing when any row is refused, naming that row', async () => {
    const version = await schemaVersion();
    const bad = await post({
      entries: [
        { id: NEW_1, values: { [NAME]: 'fine' } },
        { id: NEW_2, values: { [LINKS_FIELD]: ['not-an-entry'] } },
      ],
      schemaVersion: version,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/^entries\[1\]: /);
    expect(await rowCount()).toBe(3);
    expect(emitEntries).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    const taken = await post({
      entries: [{ id: A, values: { [NAME]: 'not a' } }],
      schemaVersion: version,
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toMatch(/^entries\[0\]: /);
    expect(await names()).toEqual(['a', 'b', 'c']);
  });

  it('refuses malformed batches, a gone anchor and a stale schema', async () => {
    const version = await schemaVersion();
    const one = [{ id: NEW_1, values: {} }];
    const cases: Array<[unknown, number, RegExp]> = [
      [{ entries: [], schemaVersion: version }, 400, /entries must list 1 to 100/],
      [
        {
          entries: Array.from({ length: 101 }, (_, index) => ({
            id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`,
            values: {},
          })),
          schemaVersion: version,
        },
        400,
        /entries must list 1 to 100/,
      ],
      [{ entries: 'rows', schemaVersion: version }, 400, /entries must list/],
      [{ entries: [{ id: 'nope', values: {} }], schemaVersion: version }, 400, /UUID/],
      [
        {
          entries: [
            { id: NEW_1, values: {} },
            { id: NEW_1.toUpperCase(), values: {} },
          ],
          schemaVersion: version,
        },
        400,
        /entries\[1\]: Entry ids must not repeat/,
      ],
      [{ entries: one, schemaVersion: version, afterEntryId: 'nope' }, 400, /afterEntryId/],
      [{ entries: one, schemaVersion: version, afterEntryId: NEW_3 }, 400, /insert after/],
      [{ entries: one, schemaVersion: 'a'.repeat(64) }, 409, /./],
    ];
    for (const [body, status, message] of cases) {
      const response = await post(body);
      expect({ status: response.status, message: response.body.error?.message }).toEqual({
        status,
        message: expect.stringMatching(message),
      });
    }
    expect(await rowCount()).toBe(3);
    expect(emitEntries).not.toHaveBeenCalled();
  });
});
