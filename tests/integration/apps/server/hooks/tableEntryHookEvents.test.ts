/**
 * Table entry hook events (integration, real DB). A task is a row in a
 * Database table, so `table_entry:create|update|delete` are the lifecycle
 * events a "status changed" hook listens to. They fire from the table write
 * path itself — the REST domain functions and the agent `table_write` batch —
 * so UI edits, agent calls and routes all emit, with `changes` carrying the
 * field key and the wire value before/after.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { getDb, quoteIdentifier } from '@snaglet/db';
import type { TableField } from '@snaglet/shared/types';
import { hooks, type HookEventMap } from '@server/services/HookService';

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
  tableEntryChanges,
  updateTableEntry,
} from '@server/domains/tables/tableEntries';
import { writeAgentEntries } from '@server/domains/tables/tableAgent';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const TABLE_NAME = 'hook_tasks';
const NAME_FIELD = `field-title-${TABLE_ID}`;
const STATUS_FIELD = 'field-1111111111111-bbbbbbbbb';
const ENTRY_1 = '00000000-0000-4000-8000-000000000001';
const ENTRY_2 = '00000000-0000-4000-8000-000000000002';
const ENTRY_3 = '00000000-0000-4000-8000-000000000003';

type Created = HookEventMap['table_entry:create'];
type Updated = HookEventMap['table_entry:update'];
type Deleted = HookEventMap['table_entry:delete'];

const created: Created[] = [];
const updated: Updated[] = [];
const deleted: Deleted[] = [];
const onCreate = (event: Created) => void created.push(event);
const onUpdate = (event: Updated) => void updated.push(event);
const onDelete = (event: Deleted) => void deleted.push(event);

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

async function schemaVersion(): Promise<string> {
  return (await listTableEntries(TABLE_ID)).schemaVersion;
}

describe('table entry hook events (real DB)', () => {
  let statusField: TableField;

  beforeAll(async () => {
    await clean();
    await createTable({ id: TABLE_ID, name: TABLE_NAME });
    statusField = (
      await createTableField(TABLE_ID, {
        id: STATUS_FIELD,
        name: 'status',
        description: null,
        type: 'text',
        nullable: true,
        defaultValue: null,
        referenceTableId: null,
      })
    ).field;
    hooks.on('table_entry:create', onCreate);
    hooks.on('table_entry:update', onUpdate);
    hooks.on('table_entry:delete', onDelete);
  });

  afterEach(() => {
    created.length = 0;
    updated.length = 0;
    deleted.length = 0;
  });

  afterAll(async () => {
    hooks.off('table_entry:create', onCreate);
    hooks.off('table_entry:update', onUpdate);
    hooks.off('table_entry:delete', onDelete);
    await clean();
  });

  it('createTableEntry emits table_entry:create with the table and entry ids', async () => {
    const result = await createTableEntry(TABLE_ID, {
      id: ENTRY_1,
      values: { [NAME_FIELD]: 'Wire the callback', [statusField.id]: 'todo' },
      schemaVersion: await schemaVersion(),
    });
    expect(result.created).toBe(true);
    expect(created).toEqual([{ tableId: TABLE_ID, entryId: ENTRY_1 }]);
    expect(updated).toHaveLength(0);
  });

  it('replaying the same create emits nothing (no row was written)', async () => {
    const result = await createTableEntry(TABLE_ID, {
      id: ENTRY_1,
      values: { [NAME_FIELD]: 'Wire the callback', [statusField.id]: 'todo' },
      schemaVersion: await schemaVersion(),
    });
    expect(result.created).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('updateTableEntry emits table_entry:update listing only the changed fields with from/to', async () => {
    const before = await listTableEntries(TABLE_ID, { focusEntryId: ENTRY_1 });
    const entry = before.entries.find((candidate) => candidate.id === ENTRY_1)!;

    await updateTableEntry(TABLE_ID, ENTRY_1, {
      values: { [statusField.id]: 'done' },
      schemaVersion: before.schemaVersion,
      expectedRevision: entry.revision,
    });

    expect(updated).toEqual([
      {
        tableId: TABLE_ID,
        entryId: ENTRY_1,
        changes: [{ field: statusField.id, from: 'todo', to: 'done' }],
      },
    ]);
  });

  it('an update that changes nothing emits no event', async () => {
    const before = await listTableEntries(TABLE_ID, { focusEntryId: ENTRY_1 });
    const entry = before.entries.find((candidate) => candidate.id === ENTRY_1)!;

    await updateTableEntry(TABLE_ID, ENTRY_1, {
      values: { [statusField.id]: 'done' },
      schemaVersion: before.schemaVersion,
      expectedRevision: entry.revision,
    });

    expect(updated).toHaveLength(0);
  });

  it('the agent table_write batch emits create for inserts and update (with changes) for patches', async () => {
    const result = await writeAgentEntries(TABLE_NAME, {
      insert: [{ id: ENTRY_2, values: { name: 'Ship it', status: 'todo' } }],
      update: [{ id: ENTRY_1, values: { status: 'dropped' } }],
    });
    expect(result.inserted.map((row) => row.id)).toEqual([ENTRY_2]);
    expect(result.updated.map((row) => row.id)).toEqual([ENTRY_1]);

    expect(created).toEqual([{ tableId: TABLE_ID, entryId: ENTRY_2 }]);
    expect(updated).toEqual([
      {
        tableId: TABLE_ID,
        entryId: ENTRY_1,
        changes: [{ field: statusField.id, from: 'done', to: 'dropped' }],
      },
    ]);
  });

  it('deleteTableEntries emits one table_entry:delete naming every deleted id', async () => {
    await createTableEntry(TABLE_ID, {
      id: ENTRY_3,
      values: { [NAME_FIELD]: 'Third' },
      schemaVersion: await schemaVersion(),
    });
    created.length = 0;

    const result = await deleteTableEntries(TABLE_ID, { entryIds: [ENTRY_2, ENTRY_3] });
    expect(result.deletedIds.sort()).toEqual([ENTRY_2, ENTRY_3]);

    expect(deleted).toHaveLength(1);
    expect(deleted[0].tableId).toBe(TABLE_ID);
    expect([...deleted[0].entryIds].sort()).toEqual([ENTRY_2, ENTRY_3]);
  });

  it('deleting ids that are already gone emits nothing', async () => {
    const result = await deleteTableEntries(TABLE_ID, { entryIds: [ENTRY_2] });
    expect(result.deletedIds).toEqual([]);
    expect(deleted).toHaveLength(0);
  });

  it('tableEntryChanges diffs wire values and treats a missing previous row as all-null', () => {
    expect(
      tableEntryChanges(
        { a: 'x', b: ['1', '2'], c: null, d: true },
        { a: 'x', b: ['1', '3'], c: 'set', d: true }
      )
    ).toEqual([
      { field: 'b', from: ['1', '2'], to: ['1', '3'] },
      { field: 'c', from: null, to: 'set' },
    ]);
    expect(tableEntryChanges(undefined, { a: 'x', c: null })).toEqual([
      { field: 'a', from: null, to: 'x' },
    ]);
  });
});
