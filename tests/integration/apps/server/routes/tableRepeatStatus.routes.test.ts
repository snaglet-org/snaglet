/**
 * Completion by status end to end over the paths the table
 * views and agents use, against real PostgreSQL: the entry PATCH route (grid
 * cell, row window, Board drop) and the agent `table` tool's write. Setting a
 * repeating row's status to a done option advances its date exactly one
 * occurrence and resets the status, as one undo step with one entries event.
 * The model's rules themselves are covered in
 * domains/tables/tableEntryRepeats.test.ts; this checks the wiring.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { TableEntry, TableField, TableFieldRecurrence } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';

const mockEntriesChanged = jest.fn();
const mockHistoryChanged = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: () => undefined,
  emitTableUpdated: () => undefined,
  emitTableFieldsChanged: () => undefined,
  emitTableEntriesChanged: (...args: unknown[]) => mockEntriesChanged(...args),
  emitTableRemoved: () => undefined,
  emitTableRestored: () => undefined,
  emitTableHistoryChanged: (...args: unknown[]) => mockHistoryChanged(...args),
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  updateTableField,
} from '@server/domains/tables/tableFields';
import { createTableEntry, listTableEntries } from '@server/domains/tables/tableEntries';
import { listTableHistory, stepTableHistory } from '@server/domains/tables/tableHistory';
import { hooks } from '@server/services/HookService';
import tableWrite from '@server/services/ToolService/handlers/tables/tableWrite';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const USER: Actor = {
  actorKind: 'user',
  actorId: 'test-user-repeat-status',
  actorName: 'Test User',
};
const TABLE = 'table-1111111111111-repeatst';
const TABLE_NAME = 'repeat_status_table';
const E1 = '44444444-4444-4444-8444-444444444444';
const E2 = '55555555-5555-4555-8555-555555555555';
const DUE = 'field-1111111111111-stdue';
const STATUS = 'field-1111111111111-ststatus';
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

function app(): express.Application {
  const value = express();
  value.use(express.json());
  value.use((_req, _res, next) => runWithActor(USER, () => next()));
  value.use('/api/tables', tablesRouter);
  value.use(errorHandler);
  return value;
}

async function clean(): Promise<void> {
  const { rows } = await getDb().query<{ table_name: string }>(
    'SELECT table_name FROM public.table_catalog WHERE id = $1',
    [TABLE]
  );
  for (const row of rows)
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(row.table_name)} CASCADE`
    );
  for (const table of ['table_entry_occurrences', 'table_entry_repeats', 'table_fields'])
    await getDb().query(`DELETE FROM public.${table} WHERE table_id = $1`, [TABLE]);
  await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [TABLE]);
  await getDb().query('DELETE FROM public.table_history WHERE actor_id = $1', [USER.actorId]);
}

async function field(id: string): Promise<TableField> {
  const found = (await listTableFields(TABLE)).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing field ${id}`);
  return found;
}

const base = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: null,
  type,
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  ...extra,
});

/** Option ids of Status by label. */
let option: Record<'To do' | 'Doing' | 'Done' | 'Skipped', string>;

async function setRecurrence(patch: Partial<TableFieldRecurrence>): Promise<void> {
  const due = await field(DUE);
  await as(() =>
    updateTableField(TABLE, DUE, {
      name: due.name,
      description: due.description,
      type: due.type,
      nullable: due.nullable,
      defaultValue: due.defaultValue,
      referenceTableId: due.referenceTableId,
      expectedRevision: due.revision,
      recurrence: {
        statusFieldId: STATUS,
        doneOptionIds: [option.Done],
        resetOptionId: option['To do'],
        ...patch,
      },
    })
  );
}

const entryPath = (id: string) => `/api/tables/${TABLE}/entries/${id}`;

async function read(id: string): Promise<{ entry: TableEntry; schemaVersion: string }> {
  const res = await request(app()).get(entryPath(id)).expect(200);
  return res.body.data;
}

async function repeats(id: string) {
  const res = await request(app())
    .get(`${entryPath(id)}/repeats`)
    .expect(200);
  return res.body.data as {
    repeats: Record<string, { current: string } | undefined>;
    log: Array<{ occurrence: string; kind: string }>;
  };
}

async function setWeekly(id: string): Promise<void> {
  const { entry, schemaVersion } = await read(id);
  await request(app())
    .put(`${entryPath(id)}/repeats/${DUE}`)
    .send({ rrule: 'FREQ=WEEKLY;BYDAY=MO', expectedRevision: entry.revision, schemaVersion })
    .expect(200);
}

/** The grid's write: PATCH one cell with the loaded revision. */
function patchStatus(
  id: string,
  status: string | null,
  loaded: { entry: TableEntry; schemaVersion: string }
) {
  return request(app())
    .patch(entryPath(id))
    .send({
      values: { [STATUS]: status },
      expectedRevision: loaded.entry.revision,
      schemaVersion: loaded.schemaVersion,
    });
}

const stepCount = async () => (await as(() => listTableHistory({ limit: 100 }))).steps.length;

const updateHooks = (emit: jest.SpiedFunction<typeof hooks.emit>) =>
  emit.mock.calls.filter(([event]) => event === 'table_entry:update').map(([, payload]) => payload);

describe('repeat completion by status: routes and the agent tool (real DB)', () => {
  let emit: jest.SpiedFunction<typeof hooks.emit>;

  beforeEach(async () => {
    await clean();
    await as(() => createTable({ id: TABLE, name: TABLE_NAME }));
    await as(() => createTableField(TABLE, base(DUE, 'due', 'date')));
    await as(() =>
      createTableField(
        TABLE,
        base(STATUS, 'status', 'select', {
          options: [
            { label: 'To do' },
            { label: 'Doing' },
            { label: 'Done' },
            { label: 'Skipped' },
          ],
        })
      )
    );
    option = Object.fromEntries(
      ((await field(STATUS)).options ?? []).map((o) => [o.label, o.id])
    ) as typeof option;
    await setRecurrence({});
    const { schemaVersion } = await listTableEntries(TABLE);
    for (const id of [E1, E2])
      await as(() =>
        createTableEntry(TABLE, {
          id,
          values: { [DUE]: '2026-10-05', [STATUS]: 'To do' },
          schemaVersion,
        })
      );
    await setWeekly(E1);
    mockEntriesChanged.mockClear();
    mockHistoryChanged.mockClear();
    emit = jest.spyOn(hooks, 'emit');
  });

  afterEach(() => emit?.mockRestore());
  afterAll(clean);

  it('PATCH Done advances Due exactly one week and resets Status: one step, one event, one undo', async () => {
    const before = await stepCount();
    const res = await patchStatus(E1, 'Done', await read(E1)).expect(200);
    expect(res.body.data.entry.values).toMatchObject({ [DUE]: '2026-10-12', [STATUS]: 'To do' });
    const view = await repeats(E1);
    expect(view.repeats[DUE]?.current).toBe('2026-10-12');
    expect(view.log.map((row) => [row.occurrence, row.kind])).toEqual([['2026-10-05', 'done']]);
    expect(await stepCount()).toBe(before + 1);

    expect(mockEntriesChanged).toHaveBeenCalledTimes(1);
    expect(mockEntriesChanged).toHaveBeenCalledWith(TABLE, E1);
    expect(mockHistoryChanged).toHaveBeenCalledTimes(1);
    // The hook sees the row as it ends up: Due moved, Status back where it was.
    const updates = updateHooks(emit);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      tableId: TABLE,
      entryId: E1,
      changes: [{ field: DUE, from: '2026-10-05', to: '2026-10-12' }],
    });

    await as(() => stepTableHistory('undo', {}));
    expect((await read(E1)).entry.values).toMatchObject({ [DUE]: '2026-10-05', [STATUS]: 'To do' });
    expect((await repeats(E1)).repeats[DUE]?.current).toBe('2026-10-05');
    expect((await repeats(E1)).log).toEqual([]);
  });

  it('every done option advances; a status that is not done does not', async () => {
    await setRecurrence({ doneOptionIds: [option.Done, option.Skipped] });
    await patchStatus(E1, 'Doing', await read(E1)).expect(200);
    expect((await read(E1)).entry.values[DUE]).toBe('2026-10-05');
    const skipped = await patchStatus(E1, 'Skipped', await read(E1)).expect(200);
    expect(skipped.body.data.entry.values).toMatchObject({
      [DUE]: '2026-10-12',
      [STATUS]: 'To do',
    });
    const done = await patchStatus(E1, 'Done', await read(E1)).expect(200);
    expect(done.body.data.entry.values).toMatchObject({ [DUE]: '2026-10-19', [STATUS]: 'To do' });
    expect((await repeats(E1)).log.map((row) => row.occurrence).sort()).toEqual([
      '2026-10-05',
      '2026-10-12',
    ]);
  });

  it('a reset to none clears the status', async () => {
    await setRecurrence({ resetOptionId: null });
    const res = await patchStatus(E1, 'Done', await read(E1)).expect(200);
    expect(res.body.data.entry.values[DUE]).toBe('2026-10-12');
    expect(res.body.data.entry.values[STATUS] ?? null).toBeNull();
  });

  it('a row that does not repeat just keeps Done', async () => {
    const before = await stepCount();
    const res = await patchStatus(E2, 'Done', await read(E2)).expect(200);
    expect(res.body.data.entry.values).toMatchObject({ [DUE]: '2026-10-05', [STATUS]: 'Done' });
    expect((await repeats(E2)).log).toEqual([]);
    expect(await stepCount()).toBe(before + 1);
    expect(mockEntriesChanged).toHaveBeenCalledTimes(1);
  });

  it('Done twice at once with one revision: one advances, the other is a 409 that changes nothing', async () => {
    const loaded = await read(E1);
    const results = await Promise.all([
      patchStatus(E1, 'Done', loaded),
      patchStatus(E1, 'Done', loaded),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const conflict = results.find((res) => res.status === 409)!;
    expect(conflict.body.error.details.entry.values).toMatchObject({
      [DUE]: '2026-10-12',
      [STATUS]: 'To do',
    });
    expect((await read(E1)).entry.values[DUE]).toBe('2026-10-12');
    const view = await repeats(E1);
    expect(view.repeats[DUE]?.current).toBe('2026-10-12');
    expect(view.log).toHaveLength(1);
    expect(mockEntriesChanged).toHaveBeenCalledTimes(1);
  });

  it('the agent table tool: write update Status Done advances the same way', async () => {
    const before = await stepCount();
    const text = await as(() =>
      tableWrite({ table: TABLE_NAME, update: [{ id: E1, values: { status: 'Done' } }] }, {})
    );
    expect(String(text)).toContain(E1);
    expect((await read(E1)).entry.values).toMatchObject({ [DUE]: '2026-10-12', [STATUS]: 'To do' });
    expect((await repeats(E1)).log.map((row) => [row.occurrence, row.kind])).toEqual([
      ['2026-10-05', 'done'],
    ]);
    expect(await stepCount()).toBe(before + 1);
    expect(mockEntriesChanged).toHaveBeenCalledTimes(1);
    expect(mockEntriesChanged).toHaveBeenCalledWith(TABLE, [E1]);
    expect(updateHooks(emit)).toHaveLength(1);
  });
});
