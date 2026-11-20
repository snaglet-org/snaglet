import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  getDb,
  transaction,
  TableCatalog,
  TableFields,
  TableEntries,
  quoteIdentifier,
} from '@snaglet/db';
import type {
  CreateTableFieldRequest,
  TableField,
  TableEntryValues,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';

const SOURCE = 'table-1111111111111-entrysource';
const TARGET = 'table-1111111111111-entrytarget';
// A custom table's name is its real physical name.
const SOURCE_NAME = 'entry_source';
const TARGET_NAME = 'entry_target';
const SOURCE_SQL = `user_tables.${quoteIdentifier(SOURCE_NAME)}`;
const TARGET_SQL = `user_tables.${quoteIdentifier(TARGET_NAME)}`;
const ROW_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
let serial = 0;
async function field(patch: Partial<CreateTableFieldRequest> = {}): Promise<TableField> {
  serial += 1;
  return (
    await TableFields.createField(SOURCE, {
      id: `field-1111111111111-${serial}`,
      name: `field_${serial}`,
      description: null,
      type: 'text',
      nullable: true,
      defaultValue: null,
      referenceTableId: null,
      ...patch,
    })
  ).field;
}
function edit(value: TableField, patch: Partial<UpdateTableFieldRequest>): UpdateTableFieldRequest {
  if (value.managed || value.type === 'uuid') throw new Error('Managed field');
  return {
    name: value.name,
    description: value.description,
    type: value.type,
    nullable: value.nullable,
    defaultValue: value.defaultValue,
    referenceTableId: value.referenceTableId,
    expectedRevision: value.revision,
    ...patch,
  };
}
async function clean(): Promise<void> {
  await getDb().query('DELETE FROM public.table_fields WHERE table_id=ANY($1::text[])', [
    [SOURCE, TARGET],
  ]);
  await getDb().query(`DROP TABLE IF EXISTS ${SOURCE_SQL}, ${TARGET_SQL} CASCADE`);
  await getDb().query('DELETE FROM public.table_catalog WHERE id=ANY($1::text[])', [
    [SOURCE, TARGET],
  ]);
}
async function create(values: TableEntryValues = {}, id = ROW_ID) {
  const { schemaVersion } = await TableEntries.listEntries(SOURCE);
  return TableEntries.createEntry(SOURCE, { id, values, schemaVersion });
}
async function waitForLock(query: string): Promise<void> {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const result = await getDb().query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1) AS waiting",
      [`%${query}%`]
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected database lock wait: ${query}`);
}
async function waitForAdvisoryWaiters(count: number): Promise<void> {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const result = await getDb().query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND wait_event='advisory'"
    );
    if ((result.rows[0]?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} waiters on an advisory lock`);
}
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

describe('custom table entries (real DB)', () => {
  beforeEach(async () => {
    await clean();
    await transaction(async (tx) => {
      for (const [id, tableName] of [
        [SOURCE, SOURCE_NAME],
        [TARGET, TARGET_NAME],
      ]) {
        await TableCatalog.createCustomPhysicalTable(tableName, id, tx);
        await TableCatalog.registerCustom({ id, tableName, name: tableName }, tx);
        await TableFields.registerInitialFields(id, tx);
      }
    });
  });
  afterAll(clean);

  it('lists an empty table and round-trips managed values with a stable revision', async () => {
    const empty = await TableEntries.listEntries(SOURCE);
    expect(empty).toMatchObject({ entries: [], totalCount: 0, page: 1, pageSize: 25 });
    const result = await create();
    expect(result.created).toBe(true);
    expect(result.entry.values).toEqual({
      // A new entry is unnamed until its Name is filled in.
      [`field-title-${SOURCE}`]: '',
      [`field-managed-${SOURCE}-id`]: ROW_ID,
      [`field-managed-${SOURCE}-created_at`]: result.entry.createdAt,
    });
    expect((await TableEntries.getEntry(SOURCE, ROW_ID)).entry).toEqual(result.entry);
    expect((await TableEntries.listEntries(SOURCE)).entries).toEqual([result.entry]);
  });

  it('preserves text chips, exact decimals, dates, booleans, defaults and explicit null', async () => {
    const text = await field({ defaultValue: 'default' });
    const number = await field({ type: 'number' });
    const date = await field({ type: 'date' });
    const check = await field({ type: 'checkbox', defaultValue: true });
    const decimal = '12345678901234567890.12345678901234567890';
    const chip = '[Test document](doc-1111111111111-aaaaaaaaa)';
    const values = {
      [text.id]: chip,
      [number.id]: decimal,
      [date.id]: '2024-02-29',
      [check.id]: false,
    };
    const created = await create(values);
    expect(created.entry.values).toMatchObject(values);
    const updated = await TableEntries.updateEntry(SOURCE, ROW_ID, {
      schemaVersion: created.schemaVersion,
      expectedRevision: created.entry.revision,
      values: { [text.id]: null },
    });
    expect(updated.entry.values).toMatchObject({ ...values, [text.id]: null });
    expect(updated.entry.revision).not.toBe(created.entry.revision);
    const defaults = await create({}, OTHER_ID);
    expect(defaults.entry.values).toMatchObject({
      [text.id]: 'default',
      [number.id]: null,
      [date.id]: null,
      [check.id]: true,
    });
  });

  it('enforces required fields and safe scalar types without partial writes', async () => {
    const required = await field({ nullable: false });
    const number = await field({ type: 'number' });
    const date = await field({ type: 'date' });
    const check = await field({ type: 'checkbox' });
    for (const values of [
      {},
      { [required.id]: null },
      { [required.id]: 'ok', [number.id]: 'NaN' },
      { [required.id]: 'ok', [date.id]: '2025-02-29' },
      { [required.id]: 'ok', [check.id]: 'false' },
    ]) {
      await expect(create(values)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect((await TableEntries.listEntries(SOURCE)).totalCount).toBe(0);
    const saved = await create({ [required.id]: 'ok' });
    await expect(
      TableEntries.updateEntry(SOURCE, ROW_ID, {
        schemaVersion: saved.schemaVersion,
        expectedRevision: saved.entry.revision,
        values: { [required.id]: null, [number.id]: '42' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await TableEntries.getEntry(SOURCE, ROW_ID)).entry).toEqual(saved.entry);
  });

  it('rejects unknown and managed keys and cannot write across table identities', async () => {
    const text = await field();
    for (const values of [
      { bad: 'x' },
      { [`field-managed-${SOURCE}-id`]: OTHER_ID },
      { [text.columnName]: 'x' },
    ]) {
      await expect(create(values)).rejects.toMatchObject({ statusCode: 400 });
    }
    const target = await TableEntries.listEntries(TARGET);
    await expect(
      TableEntries.createEntry(TARGET, {
        id: ROW_ID,
        schemaVersion: target.schemaVersion,
        values: { [text.id]: 'x' },
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('serializes concurrent identical creates and refuses replay after omitted values change', async () => {
    const text = await field({ defaultValue: 'default' });
    const schemaVersion = (await TableEntries.listEntries(SOURCE)).schemaVersion;
    const input = { id: ROW_ID, values: {}, schemaVersion };
    const results = await Promise.all([
      TableEntries.createEntry(SOURCE, input),
      TableEntries.createEntry(SOURCE, input),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].entry).toEqual(results[1].entry);
    expect((await TableEntries.listEntries(SOURCE)).totalCount).toBe(1);
    await TableEntries.updateEntry(SOURCE, ROW_ID, {
      schemaVersion,
      expectedRevision: results[0].entry.revision,
      values: { [text.id]: 'changed' },
    });
    await expect(TableEntries.createEntry(SOURCE, input)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('allows only one concurrent update and reports the current entry on a stale write', async () => {
    const text = await field();
    const saved = await create();
    const input = { schemaVersion: saved.schemaVersion, expectedRevision: saved.entry.revision };
    const results = await Promise.allSettled(
      ['first', 'second'].map((value) =>
        TableEntries.updateEntry(SOURCE, ROW_ID, { ...input, values: { [text.id]: value } })
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const latest = await TableEntries.getEntry(SOURCE, ROW_ID);
    expect(results.find((result) => result.status === 'fulfilled')).toMatchObject({
      value: { ...latest, updated: true },
    });
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409, details: latest },
    });
    const noop = await TableEntries.updateEntry(SOURCE, ROW_ID, {
      schemaVersion: latest.schemaVersion,
      expectedRevision: latest.entry.revision,
      values: {},
    });
    expect(noop).toEqual({ ...latest, updated: false, occurrences: [] });
  });

  it('detects raw writes that change row data, but not a row being moved', async () => {
    const text = await field();
    const saved = await create({ [text.id]: 'same' });
    // Moving the row (its position) or a no-op write loses nobody's edit.
    await getDb().query(`UPDATE ${SOURCE_SQL} SET position = position - 1 WHERE id=$1`, [ROW_ID]);
    await getDb().query(
      `UPDATE ${SOURCE_SQL} SET ${quoteIdentifier(text.columnName)}=${quoteIdentifier(text.columnName)} WHERE id=$1`,
      [ROW_ID]
    );
    expect((await TableEntries.getEntry(SOURCE, ROW_ID)).entry.revision).toBe(saved.entry.revision);
    await getDb().query(
      `UPDATE ${SOURCE_SQL} SET ${quoteIdentifier(text.columnName)}='changed elsewhere' WHERE id=$1`,
      [ROW_ID]
    );
    await expect(
      TableEntries.updateEntry(SOURCE, ROW_ID, {
        schemaVersion: saved.schemaVersion,
        expectedRevision: saved.entry.revision,
        values: { [text.id]: 'overwrite' },
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses entry access when the position column is missing', async () => {
    await getDb().query(`ALTER TABLE ${SOURCE_SQL} DROP COLUMN position`);
    await expect(TableEntries.listEntries(SOURCE)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('no longer matches its registered fields'),
    });
  });

  it('appends rows inserted without a position last, in insertion order', async () => {
    await getDb().query(`INSERT INTO ${SOURCE_SQL} (id) VALUES ($1)`, [ROW_ID]);
    await getDb().query(`INSERT INTO ${SOURCE_SQL} (id, created_at) VALUES ($1, '2000-01-01')`, [
      OTHER_ID,
    ]);
    expect((await TableEntries.listEntries(SOURCE)).entries.map((entry) => entry.id)).toEqual([
      ROW_ID,
      OTHER_ID,
    ]);
  });

  it('orders pages by position, then creation time and id, with exact out-of-range counts', async () => {
    await getDb().query(
      `INSERT INTO ${SOURCE_SQL} (id,created_at,position) SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, '2024-01-01'::timestamptz, 0 FROM generate_series(1,27) n ORDER BY n DESC`
    );
    const first = await TableEntries.listEntries(SOURCE, { pageSize: 10 });
    const second = await TableEntries.listEntries(SOURCE, { page: 2, pageSize: 10 });
    const third = await TableEntries.listEntries(SOURCE, { page: 3, pageSize: 10 });
    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([
      10, 10, 7,
    ]);
    expect(first.totalCount).toBe(27);
    expect(first.entries[0].id).toBe('00000000-0000-4000-8000-000000000001');
    expect(second.entries[0].id).toBe('00000000-0000-4000-8000-000000000011');
    expect(await TableEntries.listEntries(SOURCE, { page: 4, pageSize: 10 })).toMatchObject({
      totalCount: 27,
      entries: [],
      page: 4,
    });
  });

  it('uses one snapshot for count and page while rows arrive concurrently', async () => {
    await Promise.all([
      (async () => {
        for (let n = 0; n < 20; n += 1)
          await getDb().query(`INSERT INTO ${SOURCE_SQL} DEFAULT VALUES`);
      })(),
      (async () => {
        for (let n = 0; n < 10; n += 1) {
          const page = await TableEntries.listEntries(SOURCE, { pageSize: 100 });
          expect(page.entries).toHaveLength(page.totalCount);
        }
      })(),
    ]);
  });

  it('enforces nullable relation targets and detects foreign-key drift', async () => {
    const relation = await field({ type: 'relation', referenceTableId: TARGET });
    await expect(create({ [relation.id]: ROW_ID })).rejects.toMatchObject({ statusCode: 400 });
    await getDb().query(`INSERT INTO ${TARGET_SQL} (id) VALUES ($1)`, [OTHER_ID]);
    const saved = await create({ [relation.id]: OTHER_ID });
    expect(saved.entry.values[relation.id]).toBe(OTHER_ID);
    await getDb().query(`DELETE FROM ${TARGET_SQL} WHERE id=$1`, [OTHER_ID]);
    const cleared = await TableEntries.getEntry(SOURCE, ROW_ID);
    expect(cleared.entry.values[relation.id]).toBeNull();
    expect(cleared.entry.revision).not.toBe(saved.entry.revision);
    await getDb().query(
      `ALTER TABLE ${SOURCE_SQL} DROP CONSTRAINT ${quoteIdentifier(`fk_${relation.id.replace(/-/g, '_')}`)}`
    );
    await expect(TableEntries.listEntries(SOURCE)).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each(['extra column', 'type', 'default', 'managed column', 'primary key', 'row policy'])(
    'rejects external %s drift before reading or mutating entries',
    async (kind) => {
      const text = await field();
      const saved = await create();
      const changes: Record<string, string> = {
        'extra column': 'ADD COLUMN unregistered text',
        type: `ALTER COLUMN ${quoteIdentifier(text.columnName)} TYPE varchar(20)`,
        default: `ALTER COLUMN ${quoteIdentifier(text.columnName)} SET DEFAULT 'outside'`,
        'managed column': 'ALTER COLUMN created_at DROP NOT NULL',
        'primary key': `DROP CONSTRAINT ${quoteIdentifier(`${SOURCE.replace(/-/g, '_')}_pkey`)}`,
        'row policy': 'ENABLE ROW LEVEL SECURITY',
      };
      await getDb().query(`ALTER TABLE ${SOURCE_SQL} ${changes[kind]}`);
      await expect(TableEntries.listEntries(SOURCE)).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        TableEntries.updateEntry(SOURCE, ROW_ID, {
          schemaVersion: saved.schemaVersion,
          expectedRevision: saved.entry.revision,
          values: { [text.id]: 'not saved' },
        })
      ).rejects.toMatchObject({ statusCode: 409 });
      const result = await getDb().query<{ value: string | null }>(
        `SELECT ${quoteIdentifier(text.columnName)} AS value FROM ${SOURCE_SQL}`
      );
      expect(result.rows[0].value).toBeNull();
    }
  );

  it('rejects stale schema both before and after a catalog lock wait', async () => {
    const text = await field();
    const before = await TableEntries.listEntries(SOURCE);
    let release = () => {};
    let ready = () => {};
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = transaction(async (tx) => {
      await tx.query('SELECT id FROM public.table_catalog WHERE id=$1 FOR UPDATE', [SOURCE]);
      await tx.query(
        'UPDATE public.table_fields SET description=$2, revision=revision+1 WHERE id=$1',
        [text.id, 'New meaning']
      );
      ready();
      await gate;
    });
    await held;
    try {
      const createPromise = TableEntries.createEntry(SOURCE, {
        id: ROW_ID,
        schemaVersion: before.schemaVersion,
        values: {},
      });
      const assertion = expect(createPromise).rejects.toMatchObject({ statusCode: 409 });
      await waitForLock('WHERE id=$1 FOR SHARE');
      release();
      await lock;
      await assertion;
    } finally {
      release();
      await lock;
    }
    await expect(
      TableEntries.createEntry(SOURCE, {
        id: ROW_ID,
        schemaVersion: before.schemaVersion,
        values: {},
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await TableEntries.listEntries(SOURCE)).totalCount).toBe(0);
  });

  it('changes the schema version after an editor field update and refuses the old token', async () => {
    const text = await field();
    const saved = await create();
    await TableFields.updateField(SOURCE, text.id, edit(text, { name: 'new_name' }));
    const latest = await TableEntries.getEntry(SOURCE, ROW_ID);
    expect(latest.schemaVersion).not.toBe(saved.schemaVersion);
    await expect(
      TableEntries.updateEntry(SOURCE, ROW_ID, {
        schemaVersion: saved.schemaVersion,
        expectedRevision: saved.entry.revision,
        values: { [text.id]: 'not saved' },
      })
    ).rejects.toMatchObject({ statusCode: 409, details: { schemaVersion: latest.schemaVersion } });
  });

  it('checks trigger drift after acquiring the write lock, before a waiting insert can run', async () => {
    const text = await field();
    const schemaVersion = (await TableEntries.listEntries(SOURCE)).schemaVersion;
    await getDb().query(
      `CREATE FUNCTION user_tables.entry_trigger_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.${quoteIdentifier(text.columnName)} := 'rewritten'; RETURN NEW; END $$`
    );
    let release = () => {};
    let ready = () => {};
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const install = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = transaction(async (tx) => {
      await tx.query(`LOCK TABLE ONLY ${SOURCE_SQL} IN SHARE MODE`);
      ready();
      await install;
      await tx.query(
        `CREATE TRIGGER entry_trigger_test BEFORE INSERT ON ${SOURCE_SQL} FOR EACH ROW EXECUTE FUNCTION user_tables.entry_trigger_test()`
      );
    });
    await held;
    const writing = TableEntries.createEntry(SOURCE, {
      id: ROW_ID,
      schemaVersion,
      values: { [text.id]: 'submitted' },
    });
    const result = writing.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    try {
      await waitForLock(SOURCE_NAME);
      release();
      await gate;
      expect(await result).toMatchObject({ error: { statusCode: 409 } });
      const rows = await getDb().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${SOURCE_SQL}`
      );
      expect(rows.rows[0].count).toBe('0');
    } finally {
      release();
      await gate;
      await result;
      await getDb().query(`DROP TRIGGER IF EXISTS entry_trigger_test ON ${SOURCE_SQL}`);
      await getDb().query('DROP FUNCTION IF EXISTS user_tables.entry_trigger_test()');
    }
  });

  it('rejects builtins, missing entries, malformed IDs and invalid pages', async () => {
    for (const table of ['table-builtin-docs', 'table-builtin-credentials']) {
      await expect(TableEntries.listEntries(table)).rejects.toMatchObject({ statusCode: 403 });
      await expect(TableEntries.getEntry(table, ROW_ID)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        TableEntries.createEntry(table, { id: ROW_ID, values: {}, schemaVersion: 'a'.repeat(64) })
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(TableEntries.listEntries('missing')).rejects.toMatchObject({ statusCode: 404 });
    await expect(TableEntries.getEntry(SOURCE, ROW_ID)).rejects.toMatchObject({ statusCode: 404 });
    await expect(TableEntries.getEntry(SOURCE, 'bad')).rejects.toMatchObject({ statusCode: 400 });
    for (const query of [
      { page: 0 },
      { page: 1.5 },
      { pageSize: 0 },
      { pageSize: 101 },
      { page: Number.MAX_SAFE_INTEGER, pageSize: 100 },
    ]) {
      await expect(TableEntries.listEntries(SOURCE, query)).rejects.toMatchObject({
        statusCode: 400,
      });
    }
  });

  describe('display order', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    async function place(id: string, beforeEntryId?: string) {
      const { schemaVersion } = await TableEntries.listEntries(SOURCE);
      return TableEntries.createEntry(SOURCE, {
        id,
        values: {},
        schemaVersion,
        ...(beforeEntryId ? { beforeEntryId } : {}),
      });
    }
    async function order(): Promise<string[]> {
      return (await TableEntries.listEntries(SOURCE, { pageSize: 100 })).entries.map(
        (entry) => entry.id
      );
    }

    it('keeps creation order without positions and inserts before the first and middle rows', async () => {
      for (const n of [1, 2, 3]) await place(uuid(n));
      expect(await order()).toEqual([uuid(1), uuid(2), uuid(3)]);
      await place(uuid(4), uuid(1));
      await place(uuid(5), uuid(2));
      expect(await order()).toEqual([uuid(4), uuid(1), uuid(5), uuid(2), uuid(3)]);
      await place(uuid(6));
      expect((await order()).at(-1)).toBe(uuid(6));
    });

    it('rebalances a crowded gap without reordering and skips placement on replay', async () => {
      // Two rows sharing a created_at leave no room between their keys.
      await getDb().query(
        `INSERT INTO ${SOURCE_SQL} (id, created_at) VALUES ($1, '2024-01-01'), ($2, '2024-01-01')`,
        [uuid(1), uuid(2)]
      );
      const inserted: string[] = [];
      for (let n = 10; n < 70; n += 1) {
        await place(uuid(n), uuid(2));
        inserted.push(uuid(n));
      }
      expect(await order()).toEqual([uuid(1), ...inserted, uuid(2)]);
      const replay = await place(uuid(10), uuid(1));
      expect(replay.created).toBe(false);
      expect(await order()).toEqual([uuid(1), ...inserted, uuid(2)]);
      await place(uuid(99));
      expect((await order()).at(-1)).toBe(uuid(99));
    });

    it('rejects a missing or malformed beforeEntryId without creating the entry', async () => {
      await place(uuid(1));
      await expect(place(uuid(2), uuid(3))).rejects.toMatchObject({ statusCode: 400 });
      await expect(TableEntries.getEntry(SOURCE, uuid(2))).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(place(uuid(2), 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
      expect(await order()).toEqual([uuid(1)]);
    });

    it('keeps the schema version and entry revisions when fields are reordered', async () => {
      const text = await field();
      const saved = await create({ [text.id]: 'Kept' });
      const ids = (await TableFields.listFields(SOURCE)).map((item) => item.id);
      await TableFields.reorderFields(SOURCE, [...ids].reverse());
      const latest = await TableEntries.getEntry(SOURCE, ROW_ID);
      expect(latest.schemaVersion).toBe(saved.schemaVersion);
      expect(latest.entry.revision).toBe(saved.entry.revision);
      expect((await TableEntries.listEntries(SOURCE)).fields.map((item) => item.id)).toEqual(
        [...ids].reverse()
      );
    });
  });

  describe('deleting entries', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    async function add(tableId: string, id: string, values: TableEntryValues = {}) {
      const { schemaVersion } = await TableEntries.listEntries(tableId);
      return (await TableEntries.createEntry(tableId, { id, values, schemaVersion })).entry;
    }
    async function rows(): Promise<Array<{ id: string; position: number }>> {
      return (
        await getDb().query<{ id: string; position: number }>(
          `SELECT id::text, position FROM ${SOURCE_SQL} ORDER BY position, created_at, id`
        )
      ).rows;
    }
    const empty = { clearedReferences: [], unlinkedEntries: [] };

    it('deletes one and many entries, leaving the rest in place, and reports missing ids', async () => {
      for (let n = 1; n <= 5; n += 1) await add(SOURCE, uuid(n));
      const before = await rows();
      expect(await TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(2)] })).toEqual({
        deletedIds: [uuid(2)],
        alreadyDeleted: [],
        ...empty,
      });
      // Ids are case-insensitive UUIDs and come back in their canonical form.
      expect(
        await TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(4).toUpperCase(), uuid(1)] })
      ).toEqual({ deletedIds: [uuid(4), uuid(1)], alreadyDeleted: [], ...empty });
      expect(await rows()).toEqual(before.filter((_, index) => index === 2 || index === 4));
      expect(
        await TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(1), uuid(3), uuid(9)] })
      ).toEqual({ deletedIds: [uuid(3)], alreadyDeleted: [uuid(1), uuid(9)], ...empty });
      expect(await TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(1), uuid(2)] })).toEqual({
        deletedIds: [],
        alreadyDeleted: [uuid(1), uuid(2)],
        ...empty,
      });
      expect((await rows()).map((row) => row.id)).toEqual([uuid(5)]);
    });

    it('refuses the whole delete when an entry changed since the caller saw it', async () => {
      const text = await field();
      const first = await add(SOURCE, uuid(1), { [text.id]: 'Seen' });
      const second = await add(SOURCE, uuid(2));
      const { schemaVersion } = await TableEntries.listEntries(SOURCE);
      const edited = await TableEntries.updateEntry(SOURCE, uuid(1), {
        values: { [text.id]: 'Changed' },
        schemaVersion,
        expectedRevision: first.revision,
      });
      const expectedRevisions = { [uuid(1)]: first.revision, [uuid(2)]: second.revision };
      await expect(
        TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(1), uuid(2)], expectedRevisions })
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { entries: [edited.entry], schemaVersion },
      });
      expect((await rows()).map((row) => row.id)).toEqual([uuid(1), uuid(2)]);
      // A revision for an entry that is already gone is not a conflict.
      expect(
        await TableEntries.deleteEntries(SOURCE, {
          entryIds: [uuid(1), uuid(2), uuid(3)],
          expectedRevisions: {
            ...expectedRevisions,
            [uuid(1)]: edited.entry.revision,
            [uuid(3)]: first.revision,
          },
        })
      ).toEqual({ deletedIds: [uuid(1), uuid(2)], alreadyDeleted: [uuid(3)], ...empty });
    });

    it('refuses linked entries until the links are cleared, across tables and self-relations', async () => {
      const parent = await field({ type: 'relation', referenceTableId: SOURCE });
      const link = (
        await TableFields.createField(TARGET, {
          id: 'field-1111111111111-link',
          name: 'source_link',
          description: null,
          type: 'relation',
          nullable: true,
          defaultValue: null,
          referenceTableId: SOURCE,
        })
      ).field;
      await add(SOURCE, uuid(1));
      // uuid(2) links to uuid(1) but is deleted with it, so it does not count.
      await add(SOURCE, uuid(2), { [parent.id]: uuid(1) });
      await add(SOURCE, uuid(3), { [parent.id]: uuid(1) });
      await add(TARGET, uuid(11), { [link.id]: uuid(1) });
      await add(TARGET, uuid(12), { [link.id]: uuid(2) });
      await add(TARGET, uuid(13), { [link.id]: uuid(3) });
      const request = { entryIds: [uuid(1), uuid(2)] };

      await expect(TableEntries.deleteEntries(SOURCE, request)).rejects.toMatchObject({
        statusCode: 409,
        message:
          '3 links from other entries point to the selected entries. Confirm to remove those links.',
        details: {
          references: [
            {
              tableId: SOURCE,
              tableName: SOURCE_NAME,
              fieldId: parent.id,
              fieldName: parent.name,
              count: 1,
            },
            {
              tableId: TARGET,
              tableName: TARGET_NAME,
              fieldId: link.id,
              fieldName: 'source_link',
              count: 2,
            },
          ],
        },
      });
      expect((await rows()).map((row) => row.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
      expect((await TableEntries.getEntry(TARGET, uuid(11))).entry.values[link.id]).toBe(uuid(1));

      const result = await TableEntries.deleteEntries(SOURCE, {
        ...request,
        clearReferences: true,
      });
      expect({
        ...result,
        unlinkedEntries: result.unlinkedEntries.map((item) => ({
          ...item,
          entryIds: [...item.entryIds].sort(),
        })),
      }).toEqual({
        deletedIds: [uuid(1), uuid(2)],
        alreadyDeleted: [],
        clearedReferences: [
          { tableId: SOURCE, fieldId: parent.id, count: 1 },
          { tableId: TARGET, fieldId: link.id, count: 2 },
        ],
        unlinkedEntries: [{ tableId: TARGET, entryIds: [uuid(11), uuid(12)] }],
      });
      expect((await TableEntries.getEntry(SOURCE, uuid(3))).entry.values[parent.id]).toBeNull();
      const linked = await TableEntries.listEntries(TARGET);
      expect(linked.entries.map((entry) => [entry.id, entry.values[link.id]])).toEqual([
        [uuid(11), null],
        [uuid(12), null],
        [uuid(13), uuid(3)],
      ]);
    });

    it('never deadlocks a placed create that links to an entry being deleted', async () => {
      const parent = await field({ type: 'relation', referenceTableId: SOURCE });
      await add(SOURCE, uuid(1));
      await add(SOURCE, uuid(2));
      const { schemaVersion } = await TableEntries.listEntries(SOURCE);
      let release = () => {};
      let ready = () => {};
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Hold the order lock so the delete queues on it first and the placed
      // create second. Taking the order lock after the INSERT (which locks its
      // relation target, uuid(1)) would deadlock with the delete's FOR UPDATE.
      const blocker = transaction(async (tx) => {
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('snaglet.table_entry_order:' || $1, 0))",
          [SOURCE]
        );
        ready();
        await gate;
      });
      await held;
      try {
        const deletion = settle(
          TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(1)], clearReferences: true })
        );
        await waitForAdvisoryWaiters(1);
        const creation = settle(
          TableEntries.createEntry(SOURCE, {
            id: uuid(3),
            values: { [parent.id]: uuid(1) },
            schemaVersion,
            beforeEntryId: uuid(2),
          })
        );
        await waitForAdvisoryWaiters(2);
        release();
        await blocker;
        const [deleted, created] = await Promise.all([deletion, creation]);
        expect(deleted).toEqual({
          ok: true,
          value: {
            deletedIds: [uuid(1)],
            alreadyDeleted: [],
            clearedReferences: [],
            unlinkedEntries: [],
          },
        });
        // The link target is gone by the time the create runs: a plain 400,
        // not a deadlock (40P01) or "table is busy" 409.
        expect(created).toMatchObject({
          ok: false,
          error: {
            statusCode: 400,
            message: 'The related entry does not exist in the selected table.',
          },
        });
      } finally {
        release();
        await blocker;
      }
      expect((await rows()).map((row) => row.id)).toEqual([uuid(2)]);
    });

    it('lets concurrent overlapping deletes both succeed without double-counting', async () => {
      for (let n = 1; n <= 3; n += 1) await add(SOURCE, uuid(n));
      const results = await Promise.all([
        TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(1), uuid(2)] }),
        TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(2), uuid(3)] }),
      ]);
      expect(results.flatMap((result) => result.deletedIds).sort()).toEqual([
        uuid(1),
        uuid(2),
        uuid(3),
      ]);
      expect(results.flatMap((result) => result.alreadyDeleted)).toEqual([uuid(2)]);
      expect(await rows()).toEqual([]);
    });

    it('rejects malformed requests, builtins and missing tables without deleting', async () => {
      await add(SOURCE, uuid(1));
      const revision = 'a'.repeat(64);
      for (const input of [
        { entryIds: [] },
        { entryIds: Array.from({ length: 501 }, (_, index) => uuid(index + 1)) },
        { entryIds: ['bad'] },
        { entryIds: [uuid(1), uuid(1).toUpperCase()] },
        { entryIds: [uuid(1)], expectedRevisions: { [uuid(1)]: 'stale' } },
        { entryIds: [uuid(1)], expectedRevisions: { [uuid(1)]: 5 as unknown as string } },
        { entryIds: [uuid(1)], expectedRevisions: [revision] as unknown as Record<string, string> },
        { entryIds: [uuid(1)], clearReferences: 'yes' as unknown as boolean },
      ]) {
        await expect(TableEntries.deleteEntries(SOURCE, input)).rejects.toMatchObject({
          statusCode: 400,
        });
      }
      for (const [tableId, statusCode] of [
        ['table-1111111111111-missing', 404],
        ['table-builtin-docs', 403],
      ] as const) {
        await expect(
          TableEntries.deleteEntries(tableId, { entryIds: [uuid(1)] })
        ).rejects.toMatchObject({ statusCode });
      }
      expect((await rows()).map((row) => row.id)).toEqual([uuid(1)]);
    });
  });

  describe('entry names, search and focus', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const SOURCE_TITLE = `field-title-${SOURCE}`;
    const TARGET_TITLE = `field-title-${TARGET}`;
    async function add(tableId: string, id: string, values: TableEntryValues = {}) {
      const { schemaVersion } = await TableEntries.listEntries(tableId);
      return (await TableEntries.createEntry(tableId, { id, values, schemaVersion })).entry;
    }
    const named = (tableId: string, id: string, name: string, values: TableEntryValues = {}) =>
      add(tableId, id, { [tableId === SOURCE ? SOURCE_TITLE : TARGET_TITLE]: name, ...values });

    it('resolves names across tables, keyed per table, leaving missing refs out', async () => {
      await named(SOURCE, uuid(1), 'Alpha');
      await add(SOURCE, uuid(2));
      // The same UUID in another table is a different entry.
      await named(TARGET, uuid(1), 'Target one');
      const result = await TableEntries.resolveEntries([
        { tableId: SOURCE, entryId: uuid(1) },
        { tableId: TARGET, entryId: uuid(1) },
        { tableId: SOURCE, entryId: uuid(2) },
        { tableId: SOURCE, entryId: uuid(9) },
        { tableId: 'table-builtin-docs', entryId: uuid(1) },
        { tableId: 'table-1111111111111-missing', entryId: uuid(1) },
        { tableId: SOURCE, entryId: uuid(1).toUpperCase() },
      ]);
      expect(result).toEqual({
        entries: [
          { tableId: SOURCE, entryId: uuid(1), name: 'Alpha', tableName: SOURCE_NAME },
          { tableId: TARGET, entryId: uuid(1), name: 'Target one', tableName: TARGET_NAME },
          { tableId: SOURCE, entryId: uuid(2), name: '', tableName: SOURCE_NAME },
        ],
      });
      // A table without a Name field still resolves its entries, unnamed.
      await getDb().query('UPDATE public.table_fields SET is_title = false WHERE table_id = $1', [
        TARGET,
      ]);
      expect(await TableEntries.resolveEntries([{ tableId: TARGET, entryId: uuid(1) }])).toEqual({
        entries: [{ tableId: TARGET, entryId: uuid(1), name: '', tableName: TARGET_NAME }],
      });
      const ref = { tableId: SOURCE, entryId: uuid(1) };
      for (const refs of [
        [],
        Array.from({ length: 201 }, () => ref),
        [{ tableId: 'nope', entryId: uuid(1) }],
        [{ tableId: SOURCE, entryId: 'bad' }],
      ]) {
        await expect(TableEntries.resolveEntries(refs)).rejects.toMatchObject({ statusCode: 400 });
      }
    });

    it('ranks Name prefix, then Name, then other text matches, with literal wildcards', async () => {
      const notes = await field();
      const amount = await field({ type: 'number' });
      const due = await field({ type: 'date' });
      const done = await field({ type: 'checkbox' });
      await named(SOURCE, uuid(1), 'Beta alpha', {
        [notes.id]: 'x',
        [amount.id]: '12.5',
        [due.id]: '2026-01-02',
        [done.id]: true,
      });
      await named(SOURCE, uuid(2), 'Gamma', { [notes.id]: 'Mentions ALPHA here' });
      await named(SOURCE, uuid(3), 'Alpha one', { [notes.id]: 'n'.repeat(100) });
      await named(SOURCE, uuid(4), 'alphabet');
      await named(SOURCE, uuid(5), 'Delta');
      await named(SOURCE, uuid(6), '100% sure');
      await named(SOURCE, uuid(7), '1000 things');
      await named(SOURCE, uuid(8), 'a_b');
      await named(SOURCE, uuid(9), 'axb');
      const search = async (q?: string, limit?: number) =>
        (await TableEntries.searchEntries(SOURCE, { q, limit })).results;

      const ranked = await search('  ALPHA ');
      expect(ranked.map((result) => result.id)).toEqual([uuid(3), uuid(4), uuid(1), uuid(2)]);
      expect(ranked[0]).toEqual({ id: uuid(3), name: 'Alpha one', preview: `${'n'.repeat(59)}…` });
      // Up to two other text, number or date values; checkboxes are skipped.
      expect(ranked[2]).toEqual({ id: uuid(1), name: 'Beta alpha', preview: 'x · 12.5' });
      expect((await search('100%')).map((result) => result.id)).toEqual([uuid(6)]);
      expect((await search('a_b')).map((result) => result.id)).toEqual([uuid(8)]);
      expect((await search('zzz')).map((result) => result.id)).toEqual([]);
      expect((await search('', 3)).map((result) => result.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
      expect(await search()).toHaveLength(9);
      expect(await search('a', 2)).toHaveLength(2);
      for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { q: 'x'.repeat(201) }]) {
        await expect(TableEntries.searchEntries(SOURCE, query)).rejects.toMatchObject({
          statusCode: 400,
        });
      }
      await expect(
        TableEntries.searchEntries('table-1111111111111-missing', {})
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(TableEntries.searchEntries('table-builtin-docs', {})).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('pages search results after leaving out excluded entries', async () => {
      for (let n = 1; n <= 6; n += 1) await named(SOURCE, uuid(n), `Item ${n}`);
      const ids = (response: { results: Array<{ id: string }> }) =>
        response.results.map((result) => result.id);

      // The excluded entries never take a slot, so each page is full of linkable ones.
      const first = await TableEntries.searchEntries(SOURCE, {
        limit: 2,
        exclude: [uuid(1), uuid(2), uuid(3)],
      });
      expect(ids(first)).toEqual([uuid(4), uuid(5)]);
      expect(first.hasMore).toBe(true);
      const second = await TableEntries.searchEntries(SOURCE, {
        limit: 2,
        offset: 2,
        exclude: [uuid(1), uuid(2), uuid(3)],
      });
      expect(ids(second)).toEqual([uuid(6)]);
      expect(second.hasMore).toBe(false);

      const matched = await TableEntries.searchEntries(SOURCE, { q: 'item', exclude: [uuid(4)] });
      expect(ids(matched)).toEqual([uuid(1), uuid(2), uuid(3), uuid(5), uuid(6)]);
      expect(matched.hasMore).toBe(false);
      expect((await TableEntries.searchEntries(SOURCE, { limit: 6 })).hasMore).toBe(false);
      expect((await TableEntries.searchEntries(SOURCE, { limit: 5 })).hasMore).toBe(true);

      for (const query of [
        { offset: -1 },
        { offset: 10_001 },
        { offset: 0.5 },
        { exclude: ['not-a-uuid'] },
        { exclude: Array.from({ length: 101 }, (_, n) => uuid(n + 1)) },
      ]) {
        await expect(TableEntries.searchEntries(SOURCE, query)).rejects.toMatchObject({
          statusCode: 400,
        });
      }
    });

    it('returns the page holding a focused entry in row order', async () => {
      for (let n = 1; n <= 7; n += 1) await add(SOURCE, uuid(n));
      // Placed at the top, so every other entry moves one slot later.
      const { schemaVersion } = await TableEntries.listEntries(SOURCE);
      await TableEntries.createEntry(SOURCE, {
        id: uuid(8),
        values: {},
        schemaVersion,
        beforeEntryId: uuid(1),
      });
      const focus = async (id: string, page?: number) =>
        TableEntries.listEntries(SOURCE, { focusEntryId: id, pageSize: 3, page });
      for (const [id, page, ids] of [
        [uuid(8), 1, [uuid(8), uuid(1), uuid(2)]],
        [uuid(2), 1, [uuid(8), uuid(1), uuid(2)]],
        [uuid(3), 2, [uuid(3), uuid(4), uuid(5)]],
        [uuid(7), 3, [uuid(6), uuid(7)]],
      ] as const) {
        const result = await focus(id, 99);
        expect({ id, page: result.page, ids: result.entries.map((entry) => entry.id) }).toEqual({
          id,
          page,
          ids,
        });
        expect(result).toMatchObject({ totalCount: 8, pageSize: 3 });
      }
      await expect(focus(uuid(99))).rejects.toMatchObject({
        statusCode: 404,
        message: 'Entry not found',
      });
      await expect(focus('bad')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('names related entries per target table on reads and writes', async () => {
      const link = await field({ type: 'relation', referenceTableId: TARGET });
      const parent = await field({ type: 'relation', referenceTableId: SOURCE });
      await named(TARGET, uuid(1), 'Target one');
      await named(SOURCE, uuid(1), 'Source one');
      const created = await TableEntries.createEntry(SOURCE, {
        id: uuid(2),
        values: { [link.id]: uuid(1), [parent.id]: uuid(1) },
        schemaVersion: (await TableEntries.listEntries(SOURCE)).schemaVersion,
      });
      const related = {
        [SOURCE]: { [uuid(1)]: { name: 'Source one' } },
        [TARGET]: { [uuid(1)]: { name: 'Target one' } },
      };
      expect(created.relatedEntries).toEqual(related);
      expect((await TableEntries.getEntry(SOURCE, uuid(2))).relatedEntries).toEqual(related);
      expect((await TableEntries.listEntries(SOURCE)).relatedEntries).toEqual(related);

      const updated = await TableEntries.updateEntry(SOURCE, uuid(2), {
        values: { [link.id]: null },
        schemaVersion: created.schemaVersion,
        expectedRevision: created.entry.revision,
      });
      expect(updated.relatedEntries).toEqual({ [SOURCE]: related[SOURCE] });
      // Deleting the target clears the link, so nothing is left to name.
      await getDb().query(`DELETE FROM ${SOURCE_SQL} WHERE id = $1`, [uuid(1)]);
      expect((await TableEntries.listEntries(SOURCE)).relatedEntries).toEqual({});
    });
  });

  describe('multiple relations', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const TARGET_TITLE = `field-title-${TARGET}`;
    async function write(tableId: string, id: string, values: TableEntryValues = {}) {
      const { schemaVersion } = await TableEntries.listEntries(tableId);
      return TableEntries.createEntry(tableId, { id, values, schemaVersion });
    }
    async function edit(tableId: string, id: string, values: TableEntryValues) {
      const { entry, schemaVersion } = await TableEntries.getEntry(tableId, id);
      return TableEntries.updateEntry(tableId, id, {
        values,
        schemaVersion,
        expectedRevision: entry.revision,
      });
    }
    const links = () => field({ type: 'relation', referenceTableId: TARGET, multiple: true });
    async function stored(fieldId: string, id: string) {
      return (await TableEntries.getEntry(SOURCE, id)).entry.values[fieldId];
    }
    function hold() {
      let release = () => {};
      let ready = () => {};
      const held = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { held, gate, ready, release: () => release() };
    }

    it('writes, reads and reorders lists of links; null stores the empty list', async () => {
      const link = await links();
      for (let n = 1; n <= 3; n += 1)
        await write(TARGET, uuid(10 + n), { [TARGET_TITLE]: `Target ${n}` });
      const created = await write(SOURCE, uuid(1), { [link.id]: [uuid(12), uuid(11)] });
      expect(created.entry.values[link.id]).toEqual([uuid(12), uuid(11)]);
      expect(created.relatedEntries).toEqual({
        [TARGET]: { [uuid(11)]: { name: 'Target 1' }, [uuid(12)]: { name: 'Target 2' } },
      });
      expect((await write(SOURCE, uuid(2))).entry.values[link.id]).toEqual([]);
      const reordered = await edit(SOURCE, uuid(1), { [link.id]: [uuid(13), uuid(11), uuid(12)] });
      expect(reordered.entry.values[link.id]).toEqual([uuid(13), uuid(11), uuid(12)]);
      expect(await stored(link.id, uuid(1))).toEqual([uuid(13), uuid(11), uuid(12)]);
      expect((await edit(SOURCE, uuid(1), { [link.id]: null })).entry.values[link.id]).toEqual([]);
      const listed = await TableEntries.listEntries(SOURCE);
      expect(listed.entries.map((entry) => entry.values[link.id])).toEqual([[], []]);
    });

    it('refuses duplicate, excess, malformed, unknown and wrong-table links without writing', async () => {
      const link = await links();
      await write(TARGET, uuid(11));
      await write(SOURCE, uuid(1));
      for (const value of [
        [uuid(11), uuid(11)],
        Array.from({ length: 101 }, (_, n) => uuid(100 + n)),
        ['bad'],
        uuid(11),
        [uuid(99)],
        // An entry of this table, not the relation's target table.
        [uuid(1)],
      ])
        await expect(write(SOURCE, uuid(2), { [link.id]: value })).rejects.toMatchObject({
          statusCode: 400,
        });
      await expect(
        write(SOURCE, uuid(2), { [link.id]: [uuid(11), uuid(99)] })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'The related entry does not exist in the selected table.',
      });
      await expect(TableEntries.getEntry(SOURCE, uuid(2))).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('links entries of the same table, the entry itself included', async () => {
      const children = await field({ type: 'relation', referenceTableId: SOURCE, multiple: true });
      await write(SOURCE, uuid(1));
      const own = await write(SOURCE, uuid(2), { [children.id]: [uuid(2), uuid(1)] });
      expect(own.entry.values[children.id]).toEqual([uuid(2), uuid(1)]);
      expect(own.relatedEntries).toEqual({
        [SOURCE]: { [uuid(1)]: { name: '' }, [uuid(2)]: { name: '' } },
      });
    });

    it('counts list links on delete, then clears them keeping the surviving order', async () => {
      const link = await links();
      const children = await field({ type: 'relation', referenceTableId: SOURCE, multiple: true });
      for (let n = 1; n <= 3; n += 1) await write(TARGET, uuid(10 + n));
      await write(SOURCE, uuid(1), { [link.id]: [uuid(11), uuid(12), uuid(13)] });
      await write(SOURCE, uuid(2), { [link.id]: [uuid(12)] });
      const deleting = { entryIds: [uuid(12), uuid(13)] };
      await expect(TableEntries.deleteEntries(TARGET, deleting)).rejects.toMatchObject({
        statusCode: 409,
        message:
          '3 links from other entries point to the selected entries. Confirm to remove those links.',
        details: {
          references: [
            {
              tableId: SOURCE,
              tableName: SOURCE_NAME,
              fieldId: link.id,
              fieldName: link.name,
              count: 3,
            },
          ],
        },
      });
      expect((await TableEntries.listEntries(TARGET)).totalCount).toBe(3);
      const cleared = await TableEntries.deleteEntries(TARGET, {
        ...deleting,
        clearReferences: true,
      });
      expect(cleared).toMatchObject({
        deletedIds: [uuid(12), uuid(13)],
        clearedReferences: [{ tableId: SOURCE, fieldId: link.id, count: 3 }],
      });
      expect(cleared.unlinkedEntries.map((item) => [...item.entryIds].sort())).toEqual([
        [uuid(1), uuid(2)],
      ]);
      expect(await stored(link.id, uuid(1))).toEqual([uuid(11)]);
      expect(await stored(link.id, uuid(2))).toEqual([]);

      // Self-links: a linking entry that is deleted too does not count.
      for (let n = 4; n <= 7; n += 1) await write(SOURCE, uuid(n));
      await write(SOURCE, uuid(8), { [children.id]: [uuid(6), uuid(4), uuid(7), uuid(5)] });
      await edit(SOURCE, uuid(5), { [children.id]: [uuid(4)] });
      await expect(
        TableEntries.deleteEntries(SOURCE, { entryIds: [uuid(4), uuid(5)] })
      ).rejects.toMatchObject({ details: { references: [{ fieldId: children.id, count: 2 }] } });
      expect(
        await TableEntries.deleteEntries(SOURCE, {
          entryIds: [uuid(4), uuid(5)],
          clearReferences: true,
        })
      ).toMatchObject({ clearedReferences: [{ tableId: SOURCE, fieldId: children.id, count: 2 }] });
      expect(await stored(children.id, uuid(8))).toEqual([uuid(6), uuid(7)]);
    });

    it('serializes a linker and a delete of its target in either order', async () => {
      const link = await links();
      await write(TARGET, uuid(11));
      await write(TARGET, uuid(12));
      await write(SOURCE, uuid(1));
      const column = quoteIdentifier(link.columnName);

      // 1. A linker already holds FOR KEY SHARE on the target (as lockLinks
      //    does): the delete waits for it and then counts its committed link.
      const linker = hold();
      const linking = transaction(async (tx) => {
        await tx.query(`UPDATE ${SOURCE_SQL} SET ${column} = $2 WHERE id = $1`, [
          uuid(1),
          [uuid(11)],
        ]);
        await tx.query(`SELECT id FROM ${TARGET_SQL} WHERE id = ANY($1::uuid[]) FOR KEY SHARE`, [
          [uuid(11)],
        ]);
        linker.ready();
        await linker.gate;
      });
      await linker.held;
      try {
        const deletion = settle(TableEntries.deleteEntries(TARGET, { entryIds: [uuid(11)] }));
        await waitForLock('ORDER BY id FOR UPDATE');
        linker.release();
        await linking;
        expect(await deletion).toMatchObject({
          ok: false,
          error: { statusCode: 409, details: { references: [{ fieldId: link.id, count: 1 }] } },
        });
      } finally {
        linker.release();
        await linking;
      }
      expect(await stored(link.id, uuid(1))).toEqual([uuid(11)]);

      // 2. A delete already holds FOR UPDATE on the target: the linker waits
      //    for it, then finds the entry gone and writes nothing.
      const deleter = hold();
      const deleting = transaction(async (tx) => {
        await tx.query(`SELECT id FROM ${TARGET_SQL} WHERE id = $1 FOR UPDATE`, [uuid(12)]);
        await tx.query(`DELETE FROM ${TARGET_SQL} WHERE id = $1`, [uuid(12)]);
        deleter.ready();
        await deleter.gate;
      });
      await deleter.held;
      try {
        const relink = settle(edit(SOURCE, uuid(1), { [link.id]: [uuid(11), uuid(12)] }));
        await waitForLock('ORDER BY id FOR KEY SHARE');
        deleter.release();
        await deleting;
        expect(await relink).toMatchObject({
          ok: false,
          error: {
            statusCode: 400,
            message: 'The related entry does not exist in the selected table.',
          },
        });
      } finally {
        deleter.release();
        await deleting;
      }
      // No dangling id: the list still holds only the surviving link.
      expect(await stored(link.id, uuid(1))).toEqual([uuid(11)]);
    });

    it('keeps schema versions of tables without list relations and detects list drift', async () => {
      await field({ type: 'relation', referenceTableId: TARGET });
      const byId = (a: { id: string }, b: { id: string }) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      const formulaBeforeMultiple = async () => {
        const { rows: metadata } = await getDb().query<{ id: string }>(
          'SELECT id, default_expression FROM public.table_fields WHERE table_id=$1 ORDER BY position, id',
          [SOURCE]
        );
        const shape = (await TableFields.listFields(SOURCE))
          .map(
            ({
              collapsed: _c,
              isTitle: _t,
              multiple: _m,
              range: _r,
              options: _o,
              referenceKind: _k,
              ...rest
            }) => ({
              ...rest,
              position: 0,
            })
          )
          .sort(byId);
        return createHash('sha256')
          .update(JSON.stringify([SOURCE, SOURCE_NAME, shape, [...metadata].sort(byId)]))
          .digest('hex');
      };
      expect((await TableEntries.listEntries(SOURCE)).schemaVersion).toBe(
        await formulaBeforeMultiple()
      );
      // `multiple` is schema, so a list relation does change the version.
      const link = await links();
      expect((await TableEntries.listEntries(SOURCE)).schemaVersion).not.toBe(
        await formulaBeforeMultiple()
      );
      await getDb().query(
        `ALTER TABLE ${SOURCE_SQL} ALTER COLUMN ${quoteIdentifier(link.columnName)} DROP NOT NULL`
      );
      await expect(TableEntries.listEntries(SOURCE)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('date and time values', () => {
    /** The user's zone for these tests: neither UTC nor the machine running them. */
    const ZONE = 'Pacific/Auckland';
    beforeEach(() => {
      const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
      jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
        this: Intl.DateTimeFormat
      ) {
        return { ...resolved.call(this), timeZone: ZONE };
      });
    });
    afterEach(() => jest.restoreAllMocks());

    it('stores ISO 8601 as UTC, reading offset-less values in the user zone', async () => {
      const due = await field({ type: 'datetime' });
      const created = await create({ [due.id]: '2026-10-01T15:30' });
      // Auckland is +13:00 on 1 October.
      expect(created.entry.values[due.id]).toBe('2026-10-01T02:30:00.000000Z');
      expect((await TableEntries.getEntry(SOURCE, ROW_ID)).entry).toEqual(created.entry);
      const { rows } = await getDb().query<{ same: boolean }>(
        `SELECT ${quoteIdentifier(due.columnName)} = '2026-10-01T02:30:00Z'::timestamptz AS same FROM ${SOURCE_SQL}`
      );
      expect(rows).toEqual([{ same: true }]);
      // The same instant spelled another way is no change.
      const same = await TableEntries.updateEntry(SOURCE, ROW_ID, {
        schemaVersion: created.schemaVersion,
        expectedRevision: created.entry.revision,
        values: { [due.id]: '2026-10-01T04:30:00.000+02:00' },
      });
      expect(same.updated).toBe(false);
      for (const [input, stored] of [
        ['2026-10-01T22:30:00Z', '2026-10-01T22:30:00.000000Z'],
        ['2026-10-01T15:30:00.25-07:00', '2026-10-01T22:30:00.250000Z'],
        ['2026-10-01', '2026-09-30T11:00:00.000000Z'],
      ] as const) {
        const current = (await TableEntries.getEntry(SOURCE, ROW_ID)).entry;
        const updated = await TableEntries.updateEntry(SOURCE, ROW_ID, {
          schemaVersion: created.schemaVersion,
          expectedRevision: current.revision,
          values: { [due.id]: input },
        });
        expect(updated.entry.values[due.id]).toBe(stored);
      }
    });

    it('refuses values that are not ISO 8601 with a 400 naming the format', async () => {
      const due = await field({ type: 'datetime' });
      for (const value of ['Oct 1, 2026 3:30 PM', '2026-10-01T15:30 PST', '2026-02-30T10:00', true])
        await expect(create({ [due.id]: value })).rejects.toMatchObject({
          statusCode: 400,
          message:
            'Enter a valid date and time in ISO 8601 format, like 2026-10-01T15:30 or 2026-10-01T22:30:00Z.',
        });
      await expect(create({ [due.id]: '0001-01-01T00:00' })).rejects.toMatchObject({
        statusCode: 400,
        message: `${due.name}: enter a date and time within the years 1 to 9999.`,
      });
      await expect(
        create({ [`field-managed-${SOURCE}-created_at`]: '2026-10-01T15:30' })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect((await TableEntries.listEntries(SOURCE)).totalCount).toBe(0);
    });

    it('applies defaults, replays creates exactly and previews in the user zone', async () => {
      const due = await field({ type: 'datetime', defaultValue: '2026-12-25T09:00' });
      const required = await field({
        type: 'datetime',
        nullable: false,
        defaultValue: '2026-01-01T00:00:00Z',
      });
      const input = { [`field-title-${SOURCE}`]: 'Launch' };
      const created = await create(input);
      expect(created.entry.values).toMatchObject({
        [due.id]: '2026-12-24T20:00:00.000000Z',
        [required.id]: '2026-01-01T00:00:00.000000Z',
      });
      const replay = await create(input);
      expect(replay).toMatchObject({ created: false, entry: created.entry });
      const { results } = await TableEntries.searchEntries(SOURCE, { q: 'launch' });
      expect(results).toEqual([
        { id: ROW_ID, name: 'Launch', preview: '2026-12-25 09:00 · 2026-01-01 13:00' },
      ]);
    });
  });

  describe('date range values', () => {
    /** The user's zone for these tests: neither UTC nor the machine running them. */
    const ZONE = 'Pacific/Auckland';
    beforeEach(() => {
      const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
      jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
        this: Intl.DateTimeFormat
      ) {
        return { ...resolved.call(this), timeZone: ZONE };
      });
    });
    afterEach(() => jest.restoreAllMocks());

    async function patch(id: string, values: TableEntryValues) {
      const { entry, schemaVersion } = await TableEntries.getEntry(SOURCE, id);
      return TableEntries.updateEntry(SOURCE, id, {
        schemaVersion,
        expectedRevision: entry.revision,
        values,
      });
    }
    /** The stored column as PostgreSQL range text, read in UTC. */
    async function stored(column: string): Promise<unknown> {
      const { rows } = await transaction(async (tx) => {
        await tx.query("SET LOCAL TIME ZONE 'UTC'");
        return tx.query<{ value: string | null }>(
          `SELECT ${quoteIdentifier(column)}::text AS value FROM ${SOURCE_SQL} WHERE id = $1`,
          [ROW_ID]
        );
      });
      return rows[0]?.value;
    }

    it('writes spans and single days or instants, and reads them back canonically', async () => {
      const stay = await field({ type: 'date', range: true });
      const slot = await field({ type: 'datetime', range: true });
      const created = await create({
        [stay.id]: '2026-10-12/2026-10-15',
        // No offset: wall-clock time in the user's zone (+13:00 in October).
        [slot.id]: '2026-10-12T09:00/2026-10-12T10:30',
      });
      expect(created.entry.values).toMatchObject({
        [stay.id]: '2026-10-12/2026-10-15',
        [slot.id]: '2026-10-11T20:00:00.000000Z/2026-10-11T21:30:00.000000Z',
      });
      // A date range's end day is included: it is stored up to the day after.
      expect(await stored(stay.columnName)).toBe('[2026-10-12,2026-10-16)');
      expect(await stored(slot.columnName)).toBe(
        '["2026-10-11 20:00:00+00","2026-10-11 21:30:00+00")'
      );
      // Reads agree with the write, revision included, however they are made.
      const read = (await TableEntries.getEntry(SOURCE, ROW_ID)).entry;
      expect(read).toEqual(created.entry);
      expect((await TableEntries.listEntries(SOURCE)).entries).toEqual([created.entry]);
      expect((await TableEntries.getEntry(SOURCE, ROW_ID)).entry.revision).toBe(
        created.entry.revision
      );

      // One day, or the same day twice, reads back without a slash; so does one instant.
      for (const [day, instant, readDay, readInstant] of [
        ['2026-10-12', '2026-10-12T09:00:00Z', '2026-10-12', '2026-10-12T09:00:00.000000Z'],
        [
          '2026-10-13/2026-10-13',
          '2026-10-12T09:00:00Z/2026-10-12T22:00:00+13:00',
          '2026-10-13',
          '2026-10-12T09:00:00.000000Z',
        ],
      ] as const) {
        const updated = await patch(ROW_ID, { [stay.id]: day, [slot.id]: instant });
        expect(updated.entry.values).toMatchObject({
          [stay.id]: readDay,
          [slot.id]: readInstant,
        });
      }
      expect(await stored(slot.columnName)).toBe(
        '["2026-10-12 09:00:00+00","2026-10-12 09:00:00+00"]'
      );
      // The same range spelled another way is no change.
      const same = await patch(ROW_ID, {
        [stay.id]: ' 2026-10-13 ',
        [slot.id]: '2026-10-12T22:00',
      });
      expect(same.updated).toBe(false);
      // Null clears both, and stays SQL NULL (not an unbounded range).
      const cleared = await patch(ROW_ID, { [stay.id]: null, [slot.id]: null });
      expect(cleared.entry.values).toMatchObject({ [stay.id]: null, [slot.id]: null });
      expect(await stored(stay.columnName)).toBeNull();
      expect(await stored(slot.columnName)).toBeNull();
    });

    it('refuses reversed, malformed and non-text values with the right form, writing nothing', async () => {
      const stay = await field({ type: 'date', range: true });
      const slot = await field({ type: 'datetime', range: true, nullable: false });
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { [stay.id]: '2026-10-15/2026-10-12', [slot.id]: '2026-10-12T09:00' },
          'The end is before the start. Write a date range as start/end, like 2026-10-12/2026-10-15 (both days included), or as one date.',
        ],
        [
          { [slot.id]: '2026-10-12T09:00/10:30' },
          "The range's end must be a date and time like 2026-10-12T09:00. Write a date and time range as start/end, like 2026-10-12T09:00/2026-10-12T10:30, or as one date and time.",
        ],
        [
          { [slot.id]: '2026-10-12T09:00/PT1H' },
          "The range's end must be a date and time like 2026-10-12T09:00. Write a date and time range as start/end, like 2026-10-12T09:00/2026-10-12T10:30, or as one date and time.",
        ],
        [
          { [stay.id]: ['2026-10-12', '2026-10-15'], [slot.id]: '2026-10-12T09:00' },
          'Write a date range as start/end, like 2026-10-12/2026-10-15 (both days included), or as one date.',
        ],
        [{ [slot.id]: null }, `${slot.name} is required.`],
      ];
      for (const [values, message] of cases)
        await expect(create(values as TableEntryValues)).rejects.toMatchObject({
          statusCode: 400,
          message,
        });
      expect((await TableEntries.listEntries(SOURCE)).totalCount).toBe(0);
    });

    it('replays a create with the same range exactly and refuses different values', async () => {
      const stay = await field({ type: 'date', range: true });
      const values = { [stay.id]: '2026-10-12/2026-10-14' };
      const created = await create(values);
      const replay = await create({ [stay.id]: '2026-10-12 / 2026-10-14' });
      expect(replay).toMatchObject({ created: false, entry: created.entry });
      await expect(create({ [stay.id]: '2026-10-12/2026-10-15' })).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it('writes ranges in a batch by field name, inserts and updates together', async () => {
      const stay = await field({ type: 'date', range: true, name: 'stay' });
      const slot = await field({ type: 'datetime', range: true, name: 'slot' });
      const first = await TableEntries.writeBatch(SOURCE, {
        inserts: [
          { id: ROW_ID, values: { stay: '2026-10-12/2026-10-15', slot: '2026-10-12T09:00' } },
          { id: OTHER_ID, values: { stay: null } },
        ],
        updates: [],
      });
      expect(first.inserted.map((entry) => entry.values)).toEqual([
        expect.objectContaining({
          [stay.id]: '2026-10-12/2026-10-15',
          [slot.id]: '2026-10-11T20:00:00.000000Z',
        }),
        expect.objectContaining({ [stay.id]: null, [slot.id]: null }),
      ]);
      const second = await TableEntries.writeBatch(SOURCE, {
        inserts: [
          { id: ROW_ID, values: { stay: '2026-10-12/2026-10-15', slot: '2026-10-12T09:00' } },
        ],
        updates: [
          { id: OTHER_ID, values: { slot: '2026-10-12T09:00/2026-10-12T17:00' } },
          { id: ROW_ID, values: { stay: '2026-10-12/2026-10-15' } },
        ],
      });
      expect(second.existing.map((entry) => entry.id)).toEqual([ROW_ID]);
      expect(second.updated.map((entry) => entry.values[slot.id])).toEqual([
        '2026-10-11T20:00:00.000000Z/2026-10-12T04:00:00.000000Z',
      ]);
      expect(second.unchanged.map((entry) => entry.id)).toEqual([ROW_ID]);
      await expect(
        TableEntries.writeBatch(SOURCE, {
          inserts: [],
          updates: [{ id: OTHER_ID, values: { stay: '2026-10-12/2026-10-11' } }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(
          /^update\[0\] .*The end is before the start\. Write a date range/
        ),
      });
    });

    it('hashes a field without an end with the range-less formula, and one with an end differently', async () => {
      const day = await field({ type: 'date' });
      const byId = (a: { id: string }, b: { id: string }) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      const formulaBeforeRanges = async () => {
        const { rows: metadata } = await getDb().query<{ id: string }>(
          'SELECT id, default_expression FROM public.table_fields WHERE table_id=$1 ORDER BY position, id',
          [SOURCE]
        );
        const shape = (await TableFields.listFields(SOURCE))
          .map(
            ({
              collapsed: _c,
              isTitle: _t,
              multiple: _m,
              range: _r,
              options: _o,
              referenceKind: _k,
              ...rest
            }) => ({ ...rest, position: 0 })
          )
          .sort(byId);
        return createHash('sha256')
          .update(JSON.stringify([SOURCE, SOURCE_NAME, shape, [...metadata].sort(byId)]))
          .digest('hex');
      };
      expect((await TableEntries.listEntries(SOURCE)).schemaVersion).toBe(
        await formulaBeforeRanges()
      );
      // `range` is schema: a value becomes a start and an end.
      const range = await TableFields.updateField(SOURCE, day.id, edit(day, { range: true }));
      expect((await TableEntries.listEntries(SOURCE)).schemaVersion).not.toBe(
        await formulaBeforeRanges()
      );
      await TableFields.updateField(SOURCE, day.id, edit(range, { range: false }));
      expect((await TableEntries.listEntries(SOURCE)).schemaVersion).toBe(
        await formulaBeforeRanges()
      );
    });
  });
});
