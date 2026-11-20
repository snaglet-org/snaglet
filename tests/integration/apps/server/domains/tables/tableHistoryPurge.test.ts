/**
 * History steps that could never apply again, against real PostgreSQL: every
 * permanent drop of a table or field (Delete forever, its relation fields,
 * the sweep, and a deleted item leaving the history) removes the steps that
 * needed it, for every actor and in either state, while a deleted table that
 * undo can still restore keeps its steps. Undo and redo discard a step that
 * meets something dropped outside Snaglet (409 `discarded`) instead of blocking
 * the stack.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { Actor } from '@snaglet/shared/types/workspace-events';
import type { TableEntryValues, TableHistoryStep } from '@snaglet/shared/types';

const emitted: Array<{ type: string; args: unknown[] }> = [];
const record =
  (type: string) =>
  (...args: unknown[]) =>
    emitted.push({ type, args });
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: (...args: unknown[]) => record('table.created')(...args),
  emitTableUpdated: (...args: unknown[]) => record('table.updated')(...args),
  emitTableFieldsChanged: (...args: unknown[]) => record('table.fields.changed')(...args),
  emitTableEntriesChanged: (...args: unknown[]) => record('table.entries.changed')(...args),
  emitTableRemoved: (...args: unknown[]) => record('table.removed')(...args),
  emitTableRestored: (...args: unknown[]) => record('table.restored')(...args),
  emitTableHistoryChanged: (...args: unknown[]) => record('table.history.changed')(...args),
}));
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeArchived: jest.fn(),
  emitTreeNodeRestored: jest.fn(),
  emitTreeNodeDeleted: jest.fn(),
  emitTreeNodeCreated: jest.fn(),
  emitTreeNodeUpdated: jest.fn(),
  snapshotFromContainer: jest.fn(),
  snapshotFromDoc: jest.fn(),
  snapshotFromThread: jest.fn(),
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  reorderTableFields,
} from '@server/domains/tables/tableFields';
import {
  createTableEntry,
  getTableEntry,
  listTableEntries,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import { listTableHistory, stepTableHistory } from '@server/domains/tables/tableHistory';
import { archiveTable, deleteTable } from '@server/domains/tables/tableLifecycle';
import tablesRouter from '@server/routes/tables';
import archiveRouter from '@server/routes/archive';
import { getPanelToken } from '@server/middleware/panelAuth';
import { errorHandler } from '@server/middleware/errorHandler';

const USER: Actor = { actorKind: 'user', actorId: 'test-user-a', actorName: 'Test User' };
const AGENT: Actor = { actorKind: 'agent', actorId: 'test-agent-a', actorName: 'test-agent-a' };
const GONE = 'table-1111111111111-purgaaaa';
const KEPT = 'table-1111111111111-purgbbbb';
const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const K1 = '33333333-3333-4333-8333-333333333333';

const as = <T>(actor: Actor, fn: () => Promise<T>): Promise<T> => runWithActor(actor, fn);
const stackOf = (actor: Actor) => ({ kind: actor.actorKind, id: actor.actorId });
const undo = (actor: Actor) => as(actor, () => stepTableHistory('undo', {}));
const redo = (actor: Actor) => as(actor, () => stepTableHistory('redo', {}));

function app(): express.Application {
  const result = express();
  result.use(express.json());
  result.use((_req, _res, next) => runWithActor(USER, () => next()));
  result.use('/api/tables', tablesRouter);
  result.use('/api/archive', archiveRouter);
  result.use(errorHandler);
  return result;
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

function def(id: string, name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id: `field-1111111111111-${id}`,
    name,
    description: null,
    type,
    nullable: true,
    defaultValue: null,
    referenceTableId: null,
    ...extra,
  };
}

async function insert(actor: Actor, tableId: string, id: string, values: TableEntryValues = {}) {
  const { schemaVersion } = await listTableEntries(tableId);
  return as(actor, () => createTableEntry(tableId, { id, values, schemaVersion }));
}

async function patch(actor: Actor, tableId: string, id: string, values: TableEntryValues) {
  const current = await getTableEntry(tableId, id);
  return as(actor, () =>
    updateTableEntry(tableId, id, {
      values,
      schemaVersion: current.schemaVersion,
      expectedRevision: current.entry.revision,
    })
  );
}

/** One stack's steps, newest first, as `state kind [tables]`. */
async function steps(actor: Actor): Promise<string[]> {
  const history = await as(actor, () => listTableHistory());
  return history.steps.map((step) => `${step.state} ${step.kind} [${step.tableIds.join(',')}]`);
}

function heardHistoryOf(actor: Actor): boolean {
  return emitted.some(
    (event) =>
      event.type === 'table.history.changed' &&
      JSON.stringify(event.args[0]) === JSON.stringify(stackOf(actor))
  );
}

async function caught(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a rejection');
}

/**
 * GONE, with steps of both actors (the agent's latest undone), and KEPT,
 * whose steps must survive whatever happens to GONE.
 */
async function twoTables(): Promise<void> {
  await as(USER, () => createTable({ id: KEPT, name: 'kept_table' }));
  await insert(USER, KEPT, K1, { [`field-title-${KEPT}`]: 'kept' });
  await as(USER, () => createTable({ id: GONE, name: 'gone_table' }));
  await as(USER, () => createTableField(GONE, def('notes', 'notes', 'text')));
  await insert(USER, GONE, E1, { [`field-title-${GONE}`]: 'first' });
  await insert(AGENT, GONE, E2, { [`field-title-${GONE}`]: 'agent row' });
  await patch(AGENT, GONE, E2, { [`field-title-${GONE}`]: 'agent edit' });
  await undo(AGENT);
  expect(await steps(AGENT)).toEqual([
    `undone entry.update [${GONE}]`,
    `done entry.create [${GONE}]`,
  ]);
}

const KEPT_STEPS = [`done entry.create [${KEPT}]`, `done table.create [${KEPT}]`];

describe('history steps of permanently deleted tables (real DB)', () => {
  beforeEach(async () => {
    await clean();
    emitted.length = 0;
  });
  afterAll(clean);

  it('Delete forever removes every step that needed the table, of every actor and state', async () => {
    await twoTables();
    await as(USER, () => archiveTable(GONE));
    emitted.length = 0;

    const response = await request(app()).delete(`/api/archive/${GONE}`);
    expect(response.status).toBe(200);

    expect(await steps(USER)).toEqual(KEPT_STEPS);
    expect(await steps(AGENT)).toEqual([]);
    expect(heardHistoryOf(USER)).toBe(true);
    expect(heardHistoryOf(AGENT)).toBe(true);
    // Nothing blocks the stack: undo reaches the kept table's step.
    const undone = await undo(USER);
    expect(undone.step.kind).toBe('entry.create');
    expect(undone.step.tableIds).toEqual([KEPT]);
  });

  it('removes the steps of the relation fields that go with it (clearReferences)', async () => {
    await as(USER, () => createTable({ id: GONE, name: 'gone_table' }));
    await as(USER, () => createTable({ id: KEPT, name: 'kept_table' }));
    await as(USER, () =>
      createTableField(KEPT, def('link', 'link', 'relation', { referenceTableId: GONE }))
    );
    await insert(USER, KEPT, K1, { [`field-title-${KEPT}`]: 'kept' });
    const order = (await listTableFields(KEPT)).map((field) => field.id);
    await as(AGENT, () => reorderTableFields(KEPT, { fieldIds: [...order].reverse() }));
    await as(USER, () => archiveTable(GONE));
    emitted.length = 0;

    const response = await request(app()).delete(`/api/archive/${GONE}?clearReferences=true`);
    expect(response.status).toBe(200);
    expect(response.body.data.deletedLinkedFields).toHaveLength(1);

    // The link field's create and the order that listed it are gone; the
    // kept table's own steps (its entry keeps no dropped field) stay.
    expect(await steps(USER)).toEqual([
      `done entry.create [${KEPT}]`,
      `done table.create [${KEPT}]`,
    ]);
    expect(await steps(AGENT)).toEqual([]);
    expect(heardHistoryOf(AGENT)).toBe(true);
  });

  it('the sweep removes the steps of every archived table it drops', async () => {
    await twoTables();
    await as(USER, () => archiveTable(GONE));

    const response = await request(app())
      .post('/api/archive/sweep-all')
      .set('X-Snaglet-Panel-Token', getPanelToken());
    expect(response.status).toBe(200);
    expect(response.body.data.result.deletedTables).toBe(1);

    expect(await steps(USER)).toEqual(KEPT_STEPS);
    expect(await steps(AGENT)).toEqual([]);
  });

  it('keeps the steps of a deleted table undo can still restore, until its tombstone is dropped', async () => {
    await twoTables();
    await as(USER, () => deleteTable(GONE, {}));
    const kept = await steps(USER);
    expect(kept[0]).toBe(`done table.delete [${GONE}]`);
    expect(await steps(AGENT)).toHaveLength(2);

    // Its history still works: undo brings it back with its entries.
    await undo(USER);
    expect((await listTableEntries(GONE)).totalCount).toBe(2);
    await redo(USER);

    // Undo the delete and the create too: the create step now holds the
    // tombstone. A new step discards that redo branch, the tombstone is
    // dropped for good, and every step that needed the table goes with it.
    for (let step = 0; step < 4; step++) await undo(USER);
    expect((await steps(USER)).filter((line) => line.startsWith('undone'))).toHaveLength(4);
    const { rows: tombstone } = await getDb().query<{ state: string }>(
      'SELECT state FROM public.table_catalog WHERE id = $1',
      [GONE]
    );
    expect(tombstone[0]?.state).toBe('deleted');
    expect(await steps(AGENT)).toHaveLength(2);
    emitted.length = 0;

    await insert(USER, KEPT, E1, { [`field-title-${KEPT}`]: 'new step' });

    const { rows: dropped } = await getDb().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.table_catalog WHERE id = $1',
      [GONE]
    );
    expect(dropped[0]?.n).toBe(0);
    expect(await steps(AGENT)).toEqual([]);
    expect(heardHistoryOf(AGENT)).toBe(true);
    expect(await steps(USER)).toEqual([`done entry.create [${KEPT}]`, ...KEPT_STEPS]);
  });

  it('undo discards a step whose table was dropped outside Snaglet, then reaches the one before it', async () => {
    await twoTables();
    // Dropped by raw SQL: Snaglet never saw it go, so its steps are still there.
    await getDb().query('DROP TABLE user_tables.gone_table CASCADE');
    await getDb().query('DELETE FROM public.table_catalog WHERE id = $1', [GONE]);
    const before = await steps(USER);
    emitted.length = 0;

    const refused = await caught(() => undo(USER));
    expect(refused.statusCode).toBe(409);
    expect(refused.message).toBe(
      "That step's table was permanently deleted, so it was removed from your history. Press Undo again for the step before it."
    );
    expect(refused.details).toMatchObject({ reason: 'discarded' });
    expect((refused.details?.step as TableHistoryStep).kind).toBe('entry.create');
    expect(await steps(USER)).toEqual(before.slice(1));
    expect(heardHistoryOf(USER)).toBe(true);

    // The steps below it that needed the table go the same way, one press each.
    for (let press = 0; press < 2; press++)
      expect((await caught(() => undo(USER))).details).toMatchObject({ reason: 'discarded' });
    const undone = await undo(USER);
    expect(undone.step.tableIds).toEqual([KEPT]);
    expect((await listTableEntries(KEPT)).totalCount).toBe(0);

    const redoRefused = await caught(() => redo(AGENT));
    expect(redoRefused.message).toBe(
      "That step's table was permanently deleted, so it was removed from your history. Press Redo again for the step after it."
    );
    expect(await steps(AGENT)).toEqual([`done entry.create [${GONE}]`]);
  });

  it('names a field when the step only needed a field that was dropped outside Snaglet', async () => {
    await as(USER, () => createTable({ id: KEPT, name: 'kept_table' }));
    await as(USER, () => createTableField(KEPT, def('extra', 'extra', 'text')));
    await getDb().query('ALTER TABLE user_tables.kept_table DROP COLUMN extra');
    await getDb().query('DELETE FROM public.table_fields WHERE id = $1', [
      'field-1111111111111-extra',
    ]);
    const refused = await caught(() => undo(USER));
    expect(refused.message).toBe(
      "That step's field was permanently deleted, so it was removed from your history. Press Undo again for the step before it."
    );
    expect(await steps(USER)).toEqual([`done table.create [${KEPT}]`]);
  });
});
