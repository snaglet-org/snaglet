/**
 * Search by meaning on by default, against a real database: a new table is on
 * from its creation (over HTTP and through the agent's schema tool); the
 * once-per-install boot default for older tables turns it on up to 10,000
 * rows, leaves a bigger table off (asking for confirmation) and a table a
 * person turned off off, includes archived tables, records its marker so a
 * second boot does nothing, and records nothing when it fails so the next
 * boot retries; a person's "off" is recorded (dropping entries of tables that
 * are gone) and forgotten when the table is turned on again.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { TableSemantic } from '@snaglet/db/tables/table_semantic';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
  emitTableEntriesDeleted: jest.fn(),
}));
import { applyAgentSchema } from '@server/domains/tables/tableAgent';
import { errorHandler } from '@server/middleware/errorHandler';
import tablesRouter from '@server/routes/tables';
import { enableExistingTablesOnce } from '@server/services/tableSemantic/defaultOn';
import {
  getSemanticStatus,
  setSemanticSearch,
} from '@server/services/tableSemantic/TableSemanticService';
import { resetTable } from '@server/services/tableSemantic/sweepState';

const SETTING_KEYS = ['table_semantic_off', 'table_semantic_default_on'];

async function cleanup(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' })) {
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
    resetTable(table.id);
  }
  for (const table of await TableCatalog.listTables({ origin: 'custom', state: 'archived' }))
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
  await getDb().query('DELETE FROM public.table_semantic_search');
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await getDb().query(
    "DELETE FROM public.settings WHERE category = 'search' AND key = ANY($1::text[])",
    [SETTING_KEYS]
  );
}

async function setting<T>(key: string): Promise<T | undefined> {
  const { rows } = await getDb().query<{ value: T }>(
    "SELECT value FROM public.settings WHERE category = 'search' AND key = $1",
    [key]
  );
  return rows[0]?.value;
}

async function makeTable(name: string): Promise<string> {
  const { table } = await applyAgentSchema(name, { fields: [{ name: 'notes', type: 'text' }] });
  return table.id;
}

async function addRows(tableId: string, count: number): Promise<void> {
  const table = await TableCatalog.findById(tableId);
  await getDb().query(
    `INSERT INTO user_tables.${quoteIdentifier(table!.tableName)} (id, name)
     SELECT gen_random_uuid(), 'row ' || g FROM generate_series(1, $1::int) g`,
    [count]
  );
}

/** Make these tables look as they did before the default: no setting at all. */
async function forgetSettings(tableIds: readonly string[]): Promise<void> {
  await getDb().query('DELETE FROM public.table_semantic_search WHERE table_id = ANY($1::text[])', [
    [...tableIds],
  ]);
}

function app(): express.Application {
  const server = express();
  server.use(express.json());
  server.use('/api/tables', tablesRouter);
  server.use(errorHandler);
  return server;
}

describe('search by meaning on by default (real DB)', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('a table created over HTTP is on, without a confirmation, and the routes read and switch it', async () => {
    const id = 'table-5555555555555-aaaaaaaaa';
    const created = await request(app()).post('/api/tables').send({ id, name: 'reading_list' });
    expect(created.status).toBe(201);
    expect(await TableSemantic.getSettings(id)).toMatchObject({ confirmedRows: null });

    const status = await request(app()).get(`/api/tables/${id}/semantic-search`);
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({
      enabled: true,
      rows: 0,
      needsConfirmation: false,
      rowCap: 10000,
    });

    const off = await request(app()).put(`/api/tables/${id}/semantic-search`).send({
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ enabled: false, state: 'off' });

    const overview = await request(app()).get('/api/tables/semantic-search');
    expect(overview.status).toBe(200);
    expect(overview.body.data.tables).toEqual([
      expect.objectContaining({ tableId: id, tableName: 'reading_list', enabled: false }),
    ]);

    const bad = await request(app()).put(`/api/tables/${id}/semantic-search`).send({});
    expect(bad.status).toBe(400);
  });

  it('a table the agent creates is on too', async () => {
    const tableId = await makeTable('agent_made');
    expect(await getSemanticStatus(tableId)).toMatchObject({ enabled: true, state: 'indexing' });
  });

  it('the boot default turns on older tables up to the cap, leaves bigger ones and turned-off ones off, and runs once', async () => {
    const small = await makeTable('small_notes');
    const big = await makeTable('big_log');
    const declined = await makeTable('private_notes');
    const archived = await makeTable('old_notes');
    const confirmed = await makeTable('confirmed_big');
    await addRows(small, 5);
    await addRows(big, 10_001);
    await addRows(confirmed, 10_001);
    await setSemanticSearch(declined, { enabled: false });
    await setSemanticSearch(confirmed, { enabled: true, confirm: true });
    await applyAgentSchema('old_notes', { ops: [{ op: 'archive_table' }] });
    // From before the default: no setting for these.
    await forgetSettings([small, big, archived]);

    expect(await enableExistingTablesOnce()).toEqual({ enabled: 2, overCap: 1, keptOff: 1 });

    expect(await getSemanticStatus(small)).toMatchObject({ enabled: true, rows: 5 });
    expect(await TableSemantic.getSettings(archived)).not.toBeNull();
    expect(await getSemanticStatus(big)).toMatchObject({
      enabled: false,
      state: 'off',
      rows: 10_001,
      needsConfirmation: true,
    });
    expect(await getSemanticStatus(declined)).toMatchObject({ enabled: false });
    // A person's confirmation over the cap is left as it was.
    expect(await TableSemantic.getSettings(confirmed)).toMatchObject({ confirmedRows: 10_001 });
    expect(await setting<{ done: string }>('table_semantic_default_on')).toEqual({
      done: expect.any(String),
    });

    // Once per install: a table with no setting after that stays as it is.
    await forgetSettings([small]);
    expect(await enableExistingTablesOnce()).toBeNull();
    expect(await TableSemantic.getSettings(small)).toBeNull();
  });

  it('records nothing when it fails, so the next boot retries; a table turned off meanwhile stays off', async () => {
    const first = await makeTable('first_notes');
    const second = await makeTable('second_notes');
    await forgetSettings([first, second]);
    const count = jest
      .spyOn(TableCatalog, 'boundedRowCount')
      .mockRejectedValueOnce(new Error('connection lost'));
    try {
      await expect(enableExistingTablesOnce()).rejects.toThrow('connection lost');
    } finally {
      count.mockRestore();
    }
    expect(await setting('table_semantic_default_on')).toBeUndefined();

    // Between the boots a person turns one table off.
    await setSemanticSearch(second, { enabled: false });
    expect(await enableExistingTablesOnce()).toEqual({ enabled: 1, overCap: 0, keptOff: 1 });
    expect(await TableSemantic.getSettings(first)).not.toBeNull();
    expect(await TableSemantic.getSettings(second)).toBeNull();
  });

  it("a person's off is recorded, entries of tables that are gone are dropped, and turning on forgets it", async () => {
    const tableId = await makeTable('kept_notes');
    await getDb().query(
      `INSERT INTO public.settings (category, key, value)
       VALUES ('search', 'table_semantic_off', $1::jsonb)`,
      [JSON.stringify({ 'table-1700000000000-gonetable': '2026-01-01T00:00:00.000Z' })]
    );
    await setSemanticSearch(tableId, { enabled: false });
    expect(
      Object.keys((await setting<Record<string, string>>('table_semantic_off')) ?? {})
    ).toEqual([tableId]);
    await setSemanticSearch(tableId, { enabled: true });
    expect(await setting('table_semantic_off')).toEqual({});
  });

  it('pruning keeps the off of an archived table: only ids gone from the catalog are dropped', async () => {
    const archived = await makeTable('archived_notes');
    const other = await makeTable('other_notes');
    await setSemanticSearch(archived, { enabled: false });
    await applyAgentSchema('archived_notes', { ops: [{ op: 'archive_table' }] });

    // Turning another table off prunes the map: the archived table's entry stays.
    await setSemanticSearch(other, { enabled: false });
    expect(
      Object.keys((await setting<Record<string, string>>('table_semantic_off')) ?? {}).sort()
    ).toEqual([archived, other].sort());

    // So the boot default leaves it off when it runs.
    await forgetSettings([archived]);
    expect(await enableExistingTablesOnce()).toEqual({ enabled: 0, overCap: 0, keptOff: 2 });
    expect(await TableSemantic.getSettings(archived)).toBeNull();
  });
});
