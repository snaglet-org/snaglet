/**
 * The per-row repeat routes over HTTP against real
 * PostgreSQL: read, set, complete, undo of a logged occurrence, a stale
 * revision and an unknown action. The actions themselves are covered in
 * domains/tables/tableEntryRepeats.test.ts; this checks the wiring.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { TableField, TableFieldRecurrence } from '@snaglet/shared/types';
import type { Actor } from '@snaglet/shared/types/workspace-events';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableCreated: () => undefined,
  emitTableUpdated: () => undefined,
  emitTableFieldsChanged: () => undefined,
  emitTableEntriesChanged: () => undefined,
  emitTableRemoved: () => undefined,
  emitTableRestored: () => undefined,
  emitTableHistoryChanged: () => undefined,
}));

import { runWithActor } from '@server/realtime/actorContext';
import { createTable } from '@server/domains/tables/tableCatalog';
import {
  createTableField,
  listTableFields,
  updateTableField,
} from '@server/domains/tables/tableFields';
import { createTableEntry, listTableEntries } from '@server/domains/tables/tableEntries';
import tablesRouter from '@server/routes/tables';
import { errorHandler } from '@server/middleware/errorHandler';

const USER: Actor = {
  actorKind: 'user',
  actorId: 'test-user-repeat-routes',
  actorName: 'Test User',
};
const TABLE = 'table-1111111111111-repeatrt';
const ENTRY = '33333333-3333-4333-8333-333333333333';
const DAY = 'field-1111111111111-rtday';
const STATUS = 'field-1111111111111-rtstatus';
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithActor(USER, fn);

function app(): express.Application {
  const value = express();
  value.use(express.json());
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

const path = `/api/tables/${TABLE}/entries/${ENTRY}`;
let schemaVersion = '';

describe('per-row repeat routes (real DB)', () => {
  beforeAll(async () => {
    await clean();
    await as(() => createTable({ id: TABLE, name: 'repeat_routes_table' }));
    await as(() => createTableField(TABLE, base(DAY, 'day', 'date')));
    await as(() =>
      createTableField(
        TABLE,
        base(STATUS, 'status', 'select', { options: [{ label: 'todo' }, { label: 'done' }] })
      )
    );
    const options = new Map(((await field(STATUS)).options ?? []).map((o) => [o.label, o.id]));
    const recurrence: TableFieldRecurrence = {
      statusFieldId: STATUS,
      doneOptionIds: [options.get('done')!],
      resetOptionId: options.get('todo')!,
    };
    const day = await field(DAY);
    await as(() =>
      updateTableField(TABLE, DAY, {
        name: day.name,
        description: day.description,
        type: day.type,
        nullable: day.nullable,
        defaultValue: day.defaultValue,
        referenceTableId: day.referenceTableId,
        expectedRevision: day.revision,
        recurrence,
      })
    );
    schemaVersion = (await listTableEntries(TABLE)).schemaVersion;
    await as(() =>
      createTableEntry(TABLE, { id: ENTRY, values: { [DAY]: '2026-10-05' }, schemaVersion })
    );
  });

  afterAll(clean);

  let revision = '';
  let stale = '';

  it('reads a row with no repeats yet', async () => {
    const res = await request(app()).get(`${path}/repeats`).expect(200);
    expect(res.body.data).toMatchObject({ entryId: ENTRY, repeats: {}, log: [] });
    revision = res.body.data.revision;
  });

  it('sets a weekly repeat, completes it, and undoes the completion', async () => {
    const set = await request(app())
      .put(`${path}/repeats/${DAY}`)
      .send({ rrule: 'FREQ=WEEKLY;BYDAY=MO', expectedRevision: revision, schemaVersion })
      .expect(200);
    expect(set.body.data).toMatchObject({ fieldId: DAY, changed: true });
    expect(set.body.data.repeat).toMatchObject({
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      current: '2026-10-05',
    });

    const done = await request(app())
      .post(`${path}/repeats/${DAY}/complete`)
      .send({ expectedRevision: set.body.data.entry.revision, schemaVersion })
      .expect(200);
    expect(done.body.data.entry.values[DAY]).toBe('2026-10-12');
    // Revisions hash the values: after the undo below this one is stale.
    stale = done.body.data.entry.revision;
    expect(done.body.data.logged).toEqual([
      expect.objectContaining({ occurrence: '2026-10-05', kind: 'done' }),
    ]);

    const view = await request(app()).get(`${path}/repeats`).expect(200);
    expect(view.body.data.log).toHaveLength(1);

    const undone = await request(app())
      .post(`${path}/occurrences/${done.body.data.logged[0].id}/undo`)
      .send({ fieldId: DAY, expectedRevision: done.body.data.entry.revision, schemaVersion })
      .expect(200);
    expect(undone.body.data.entry.values[DAY]).toBe('2026-10-05');
    revision = undone.body.data.entry.revision;
  });

  it('refuses a stale revision with 409 and an unknown action with 404', async () => {
    await request(app())
      .post(`${path}/repeats/${DAY}/skip`)
      .send({ expectedRevision: stale, schemaVersion })
      .expect(409);
    await request(app())
      .post(`${path}/repeats/${DAY}/explode`)
      .send({ expectedRevision: revision, schemaVersion })
      .expect(404);
  });

  it('clears the repeat with the revision pair in the query string', async () => {
    const res = await request(app())
      .delete(`${path}/repeats/${DAY}`)
      .query({ expectedRevision: revision, schemaVersion })
      .expect(200);
    expect(res.body.data).toMatchObject({ repeat: null, changed: true });
    revision = res.body.data.entry.revision;
  });

  it('accepts and ignores within: null but rejects a non-null within', async () => {
    // A client may send `within: null` (no time-to-do-it window); the route
    // accepts and ignores it rather than answer 400.
    const okRes = await request(app())
      .put(`${path}/repeats/${DAY}`)
      .send({
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        within: null,
        expectedRevision: revision,
        schemaVersion,
      })
      .expect(200);
    expect(okRes.body.data).toMatchObject({ fieldId: DAY, changed: true });
    revision = okRes.body.data.entry.revision;

    // A non-null within is still rejected as unsupported.
    const bad = await request(app())
      .put(`${path}/repeats/${DAY}`)
      .send({
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
        within: 'P1D',
        expectedRevision: revision,
        schemaVersion,
      })
      .expect(400);
    expect(bad.body.error?.message ?? JSON.stringify(bad.body)).toMatch(/within/i);
  });
});
