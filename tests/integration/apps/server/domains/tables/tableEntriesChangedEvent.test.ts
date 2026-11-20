/**
 * `table.entries.changed` as the wire carries it, from real batch writes
 * against PostgreSQL: one event per batch, naming every entry it wrote in
 * `entryIds` (the first also as `entryId`), and `allEntries` instead of the
 * list past 500 entries.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb, quoteIdentifier } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';

const emitWorkspaceEvent = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (...args: unknown[]) => emitWorkspaceEvent(...args),
}));

import {
  applyAgentSchema,
  deleteAgentEntries,
  writeAgentEntries,
} from '@server/domains/tables/tableAgent';

const ROW_A = '11111111-1111-4111-8111-111111111111';
const ROW_B = '22222222-2222-4222-8222-222222222222';
const ROW_C = '33333333-3333-4333-8333-333333333333';

async function cleanup(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' }))
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
}

/** The `table.entries.changed` events emitted so far, for one table. */
function entriesChanged(tableId: string): Array<Record<string, unknown>> {
  return emitWorkspaceEvent.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event.type === 'table.entries.changed' && event.tableId === tableId);
}

describe('table.entries.changed from batch writes (real DB)', () => {
  let itemsId: string;
  let linksId: string;

  beforeEach(async () => {
    await cleanup();
    itemsId = (await applyAgentSchema('event_items', { fields: [{ name: 'notes', type: 'text' }] }))
      .table.id;
    linksId = (
      await applyAgentSchema('event_links', {
        fields: [{ name: 'item', type: 'relation', ref: 'event_items' }],
      })
    ).table.id;
    emitWorkspaceEvent.mockClear();
  });
  afterAll(cleanup);

  it('an agent batch write of [A, B, C] emits one event naming all three, A first', async () => {
    await writeAgentEntries('event_items', {
      insert: [
        { id: ROW_A, values: {} },
        { id: ROW_B, values: {} },
        { id: ROW_C, values: {} },
      ],
    });
    expect(entriesChanged(itemsId)).toEqual([
      expect.objectContaining({ entryId: ROW_A, entryIds: [ROW_A, ROW_B, ROW_C] }),
    ]);

    emitWorkspaceEvent.mockClear();
    await writeAgentEntries('event_items', {
      update: [
        { id: ROW_A, values: { notes: 'a' } },
        { id: ROW_B, values: { notes: 'b' } },
        { id: ROW_C, values: { notes: 'c' } },
      ],
    });
    const [event, ...rest] = entriesChanged(itemsId);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ entryId: ROW_A, entryIds: [ROW_A, ROW_B, ROW_C] });
    expect(event).not.toHaveProperty('allEntries');
  });

  it('a delete touching more than 500 rows says allEntries, with no list; the first id stays', async () => {
    await writeAgentEntries('event_items', { insert: [{ id: ROW_A, values: {} }] });
    // 501 rows linking A: deleting A with clearLinks rewrites every one of them.
    await getDb().query(
      `INSERT INTO user_tables.event_links (name, item)
         SELECT 'link ' || g, $1::uuid FROM generate_series(1, 501) AS g`,
      [ROW_A]
    );
    emitWorkspaceEvent.mockClear();

    const deleted = await deleteAgentEntries('event_items', { ids: [ROW_A], clearLinks: true });

    expect(deleted.deletedIds).toEqual([ROW_A]);
    expect(entriesChanged(itemsId)).toEqual([
      expect.objectContaining({ entryId: ROW_A, entryIds: [ROW_A] }),
    ]);
    const [links, ...rest] = entriesChanged(linksId);
    expect(rest).toEqual([]);
    expect(links).toMatchObject({ allEntries: true, entryId: expect.any(String) });
    expect(links).not.toHaveProperty('entryIds');
  });
});
