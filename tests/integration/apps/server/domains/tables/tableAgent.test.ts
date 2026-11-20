import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb, quoteIdentifier } from '@snaglet/db';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { TableEntries } from '@snaglet/db/tables/table_entries';

const emitCreated = jest.fn();
const emitUpdated = jest.fn();
const emitFields = jest.fn();
const emitEntries = jest.fn();
jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: (...args: unknown[]) => emitCreated(...args),
  emitTableUpdated: (...args: unknown[]) => emitUpdated(...args),
  emitTableFieldsChanged: (...args: unknown[]) => emitFields(...args),
  emitTableEntriesChanged: (...args: unknown[]) => emitEntries(...args),
}));
import {
  applyAgentSchema,
  deleteAgentEntries,
  describeAgentTable,
  listAgentTables,
  queryAgentTables,
  readAgentEntries,
  writeAgentEntries,
  type AgentTableSummary,
} from '@server/domains/tables/tableAgent';

const ROW_A = '11111111-1111-4111-8111-111111111111';
const ROW_B = '22222222-2222-4222-8222-222222222222';
const ROW_C = '33333333-3333-4333-8333-333333333333';
const ROW_D = '44444444-4444-4444-8444-444444444444';
const MISSING = '99999999-9999-4999-8999-999999999999';
const MISSING_TABLE = 'table-1111111111111-zzzzzzzzz';
const LIVE_DOC = 'doc-1111111111111-bbbbbbbbb';
const ARCHIVED_DOC = 'doc-1111111111111-ccccccccc';
const ABSENT_DOC = 'doc-1111111111111-aaaaaaaaa';

async function cleanup(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' }))
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
  await getDb().query('DELETE FROM public.nodes WHERE id = ANY($1::text[])', [
    [LIVE_DOC, ARCHIVED_DOC],
  ]);
}

async function rowCount(table: string): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_tables.${quoteIdentifier(table)}`
  );
  return rows[0]?.n ?? -1;
}

async function valueOf(table: string, column: string, id: string): Promise<unknown> {
  const { rows } = await getDb().query<{ value: unknown }>(
    `SELECT ${quoteIdentifier(column)} AS value FROM user_tables.${quoteIdentifier(table)} WHERE id = $1`,
    [id]
  );
  return rows[0]?.value;
}

function fieldNamed(summary: AgentTableSummary, name: string) {
  const field = summary.fields.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`missing field ${name}`);
  return field;
}

/** agent_items (text notes, number amount) and agent_links relating to it and itself. */
async function seedTables(): Promise<{ items: AgentTableSummary; links: AgentTableSummary }> {
  const items = (
    await applyAgentSchema('agent_items', {
      fields: [
        { name: 'notes', type: 'text', description: 'Free text' },
        { name: 'amount', type: 'number' },
      ],
    })
  ).table;
  const links = (
    await applyAgentSchema('agent_links', {
      fields: [
        { name: 'item', type: 'relation', ref: 'agent_items' },
        { name: 'items', type: 'relation', ref: 'AGENT_ITEMS', multiple: true },
        { name: 'parent', type: 'relation', ref: 'agent_links' },
      ],
    })
  ).table;
  for (const mock of [emitCreated, emitUpdated, emitFields, emitEntries]) mock.mockClear();
  return { items, links };
}

describe('agent table tools domain (real DB)', () => {
  let items: AgentTableSummary;
  let links: AgentTableSummary;

  beforeEach(async () => {
    await cleanup();
    ({ items, links } = await seedTables());
  });
  afterAll(cleanup);

  describe('addressing and reads', () => {
    it('addresses a custom table by name (any case) or catalog id', async () => {
      expect((await describeAgentTable('AGENT_ITEMS')).id).toBe(items.id);
      expect((await describeAgentTable(items.id)).name).toBe('agent_items');
    });

    it('refuses built-in tables with 403 and unknown ones with 404', async () => {
      await expect(describeAgentTable('docs')).rejects.toMatchObject({ statusCode: 403 });
      await expect(describeAgentTable('table-builtin-docs')).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(writeAgentEntries('docs', { insert: [{ values: {} }] })).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(
        applyAgentSchema('docs', { ops: [{ op: 'rename_table', name: 'x_docs' }] })
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(describeAgentTable('no_such_table')).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        deleteAgentEntries(MISSING_TABLE, { ids: [ROW_A], clearLinks: false })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('describes fields in display order with title, relation targets and multiple', async () => {
      expect(items.fields.map((field) => field.name)).toEqual([
        'name',
        'id',
        'created_at',
        'notes',
        'amount',
      ]);
      expect(fieldNamed(items, 'name')).toMatchObject({ isTitle: true, managed: false });
      expect(fieldNamed(items, 'id')).toMatchObject({ managed: true, isTitle: false });
      expect(fieldNamed(items, 'notes')).toMatchObject({
        description: 'Free text',
        nullable: true,
      });
      expect(fieldNamed(links, 'item')).toMatchObject({
        type: 'relation',
        referenceTableId: items.id,
        refName: 'agent_items',
        multiple: false,
      });
      expect(fieldNamed(links, 'items')).toMatchObject({
        referenceTableId: items.id,
        refName: 'agent_items',
        multiple: true,
        defaultValue: [],
      });
      expect(fieldNamed(links, 'parent')).toMatchObject({
        referenceTableId: links.id,
        refName: 'agent_links',
      });
      expect(fieldNamed(items, 'notes')).not.toHaveProperty('refName');
    });

    it('counts rows exactly up to 10000 and caps beyond it', async () => {
      await getDb().query(
        "INSERT INTO user_tables.agent_items (name) SELECT 'row ' || g FROM generate_series(1, 10001) AS g"
      );
      await writeAgentEntries('agent_links', { insert: [{ values: {} }, { values: {} }] });
      expect(await describeAgentTable('agent_items')).toMatchObject({
        rows: 10000,
        rowsCapped: true,
      });
      const listed = await listAgentTables();
      expect(listed.map((table) => [table.name, table.rows, table.rowsCapped])).toEqual([
        ['agent_items', 10000, true],
        ['agent_links', 2, false],
      ]);
      expect(fieldNamed(listed[1] as AgentTableSummary, 'items').refName).toBe('agent_items');
      await getDb().query(
        'DELETE FROM user_tables.agent_items WHERE id = (SELECT id FROM user_tables.agent_items LIMIT 1)'
      );
      expect(await describeAgentTable('agent_items')).toMatchObject({
        rows: 10000,
        rowsCapped: false,
      });
    });

    it('refuses non-SELECT SQL with 400 and reports no reader connection as 503', async () => {
      await expect(
        queryAgentTables('DELETE FROM agent_items', { limit: 10, maxCell: 100 })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('SELECT') });
      await expect(queryAgentTables('SELECT 1', { limit: 10, maxCell: 100 })).rejects.toMatchObject(
        {
          statusCode: 503,
          message:
            'SQL mode is unavailable on this database (no snaglet_tables_reader connection); use table {op: "read", table} or database_query.',
        }
      );
    });
  });

  describe('readAgentEntries (rev on read)', () => {
    it('returns values by field name with the same rev prefix a write returns', async () => {
      const { inserted } = await writeAgentEntries('agent_items', {
        insert: [{ id: ROW_A, values: { notes: 'a', amount: '1' } }],
      });
      const read = await readAgentEntries('AGENT_ITEMS', [ROW_A.toUpperCase(), ROW_A, MISSING]);
      expect(read).toEqual({
        table: 'agent_items',
        tableId: expect.stringMatching(/^table-/),
        entries: [
          { id: ROW_A, rev: inserted[0]?.rev, values: { name: '', notes: 'a', amount: '1' } },
        ],
        missing: [MISSING],
      });
      expect(read.entries[0]?.rev).toMatch(/^[0-9a-f]{8}$/);
    });

    it('guards a first edit: a stale read rev is a 409, the current one writes', async () => {
      await writeAgentEntries('agent_items', { insert: [{ id: ROW_A, values: { notes: 'a' } }] });
      const before = (await readAgentEntries('agent_items', [ROW_A])).entries[0]?.rev ?? '';
      // Another writer changes the row after our read.
      await writeAgentEntries('agent_items', { update: [{ id: ROW_A, values: { notes: 'b' } }] });
      const current = (await readAgentEntries('agent_items', [ROW_A])).entries[0]?.rev ?? '';
      expect(current).not.toBe(before);
      await expect(
        writeAgentEntries('agent_items', {
          update: [{ id: ROW_A, values: { notes: 'mine' }, rev: before }],
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { entry: expect.objectContaining({ id: ROW_A, rev: current }) },
      });
      expect(await valueOf('agent_items', 'notes', ROW_A)).toBe('b');
      const ok = await writeAgentEntries('agent_items', {
        update: [{ id: ROW_A, values: { notes: 'mine' }, rev: current }],
      });
      expect(ok.updated.map((entry) => entry.id)).toEqual([ROW_A]);
      expect(await valueOf('agent_items', 'notes', ROW_A)).toBe('mine');
    });

    it('rejects bad ids, too many ids, and Snaglet tables', async () => {
      await expect(readAgentEntries('agent_items', [])).rejects.toMatchObject({ statusCode: 400 });
      await expect(readAgentEntries('agent_items', ['nope'])).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('ids[0]'),
      });
      await expect(
        readAgentEntries(
          'agent_items',
          Array.from({ length: 51 }, () => ROW_A)
        )
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(readAgentEntries(MISSING_TABLE, [ROW_A])).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe('writeAgentEntries', () => {
    it('inserts by field name with minted or given ids and short revs, emitting once', async () => {
      const result = await writeAgentEntries('agent_items', {
        insert: [
          { id: ROW_A, values: { name: 'First', notes: 'a', amount: 5 as unknown as string } },
          { values: { name: 'Second' } },
        ],
      });
      expect(result.inserted).toHaveLength(2);
      expect(result.inserted[0]).toEqual({
        id: ROW_A,
        rev: expect.stringMatching(/^[0-9a-f]{8}$/),
      });
      expect(result.inserted[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result).toMatchObject({ existing: [], updated: [], unchanged: [] });
      expect(await valueOf('agent_items', 'amount', ROW_A)).toBe('5');
      expect(emitEntries).toHaveBeenCalledTimes(1);
      expect(emitEntries).toHaveBeenCalledWith(items.id, [ROW_A, result.inserted[1]?.id]);
    });

    it('rolls the whole batch back when any row fails, naming the row', async () => {
      await expect(
        writeAgentEntries('agent_items', {
          insert: [
            { values: { notes: 'a' } },
            { values: { notes: 'b' } },
            { values: { amount: 'lots' } },
          ],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/^insert\[2\]: /),
      });
      await expect(
        writeAgentEntries('agent_items', { insert: [{ values: { nope: 'x' } }] })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('Unknown field "nope"'),
      });
      expect(await rowCount('agent_items')).toBe(0);
      expect(emitEntries).not.toHaveBeenCalled();
    });

    it('treats an insert replay as existing and a different row with that id as a 409', async () => {
      const first = await writeAgentEntries('agent_items', {
        insert: [{ id: ROW_A, values: { notes: 'a', amount: '5' } }],
      });
      emitEntries.mockClear();
      const replay = await writeAgentEntries('agent_items', {
        insert: [{ id: ROW_A.toUpperCase(), values: { notes: 'a', amount: '5' } }],
      });
      expect(replay).toEqual({
        tableId: expect.stringMatching(/^table-/),
        inserted: [],
        existing: first.inserted,
        updated: [],
        unchanged: [],
      });
      expect(emitEntries).not.toHaveBeenCalled();
      // Omitted fields are compared with their defaults.
      await expect(
        writeAgentEntries('agent_items', { insert: [{ id: ROW_A, values: { notes: 'a' } }] })
      ).rejects.toMatchObject({ statusCode: 409 });
      const conflict = await writeAgentEntries('agent_items', {
        insert: [{ values: { notes: 'new' } }, { id: ROW_A, values: { notes: 'b', amount: '5' } }],
      }).catch((error: unknown) => error);
      expect(conflict).toMatchObject({
        statusCode: 409,
        message: expect.stringMatching(/^insert\[1\]: /),
        details: {
          entry: { id: ROW_A, rev: first.inserted[0]?.rev, values: { notes: 'a', amount: '5' } },
        },
      });
      expect(await rowCount('agent_items')).toBe(1);
    });

    it('fails the batch on an unknown update id', async () => {
      await expect(
        writeAgentEntries('agent_items', {
          insert: [{ values: { notes: 'x' } }],
          update: [{ id: MISSING, values: { notes: 'y' } }],
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining(`update[0] ${MISSING}`),
      });
      expect(await rowCount('agent_items')).toBe(0);
    });

    it('patches sparsely, checks a rev prefix and reports unchanged patches', async () => {
      const { inserted } = await writeAgentEntries('agent_items', {
        insert: [{ id: ROW_A, values: { notes: 'a', amount: '1' } }],
      });
      const rev = inserted[0]?.rev ?? '';
      const stale = `${rev[0] === 'a' ? 'b' : 'a'}${rev.slice(1)}`;
      await expect(
        writeAgentEntries('agent_items', {
          update: [{ id: ROW_A, values: { notes: 'z' }, rev: stale }],
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { entry: { id: ROW_A, rev, values: { notes: 'a', amount: '1' } } },
      });
      const updated = await writeAgentEntries('agent_items', {
        update: [{ id: ROW_A, values: { notes: 'b' }, rev: rev.toUpperCase() }],
      });
      expect(updated.updated).toEqual([{ id: ROW_A, rev: expect.not.stringMatching(rev) }]);
      expect(await valueOf('agent_items', 'amount', ROW_A)).toBe('1');
      const same = await writeAgentEntries('agent_items', {
        update: [{ id: ROW_A, values: { notes: 'b' } }],
      });
      expect(same).toEqual({
        tableId: expect.stringMatching(/^table-/),
        inserted: [],
        existing: [],
        updated: [],
        unchanged: [ROW_A],
      });
      await expect(
        writeAgentEntries('agent_items', { update: [{ id: ROW_A, values: {}, rev: 'abc' }] })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuses repeated ids, oversized and empty batches', async () => {
      await expect(
        writeAgentEntries('agent_items', {
          insert: [
            { id: ROW_A, values: {} },
            { id: ROW_A, values: {} },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('insert[1]') });
      await expect(
        writeAgentEntries('agent_items', {
          insert: [{ id: ROW_A, values: {} }],
          update: [{ id: ROW_A, values: {} }],
        })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('update[0]') });
      await expect(
        writeAgentEntries('agent_items', {
          insert: Array.from({ length: 201 }, () => ({ values: {} })),
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(writeAgentEntries('agent_items', {})).rejects.toMatchObject({ statusCode: 400 });
    });

    it('links to entries inserted earlier in the batch and places rows before others', async () => {
      await writeAgentEntries('agent_items', {
        insert: [
          { id: ROW_A, values: {} },
          { id: ROW_B, values: {} },
        ],
      });
      const result = await writeAgentEntries('agent_links', {
        insert: [
          { id: ROW_C, values: { item: ROW_A, items: [ROW_B, ROW_A] } },
          { id: ROW_D, values: { parent: ROW_C }, before: ROW_C },
        ],
      });
      expect(result.inserted.map((row) => row.id)).toEqual([ROW_C, ROW_D]);
      expect(await valueOf('agent_links', 'items', ROW_C)).toEqual([ROW_B, ROW_A]);
      expect(await valueOf('agent_links', 'parent', ROW_D)).toBe(ROW_C);
      const page = await TableEntries.listEntries(links.id);
      expect(page.entries.map((entry) => entry.id)).toEqual([ROW_D, ROW_C]);

      // A link to a row inserted later in the batch does not exist yet.
      await expect(
        writeAgentEntries('agent_links', {
          insert: [{ values: { parent: MISSING } }, { id: MISSING, values: {} }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/^insert\[0\]: /),
      });
    });

    it('validates multiple relation lists', async () => {
      await writeAgentEntries('agent_items', { insert: [{ id: ROW_A, values: {} }] });
      await expect(
        writeAgentEntries('agent_links', { insert: [{ values: { items: [ROW_A, MISSING] } }] })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('related entry does not exist'),
      });
      await expect(
        writeAgentEntries('agent_links', { insert: [{ values: { items: [ROW_A, ROW_A] } }] })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('only once') });
      const cleared = await writeAgentEntries('agent_links', {
        insert: [{ id: ROW_C, values: { items: null } }],
      });
      expect(cleared.inserted).toHaveLength(1);
      expect(await valueOf('agent_links', 'items', ROW_C)).toEqual([]);
    });

    it('refuses values carrying the table read cut marker', async () => {
      await expect(
        writeAgentEntries('agent_items', { insert: [{ values: { notes: 'abc…[+12 chars]' } }] })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('value looks cut by a table read'),
      });
    });

    it('validates entry, table and node chips in text inside the transaction', async () => {
      await getDb().query("INSERT INTO public.nodes (id, type) VALUES ($1, 'doc'), ($2, 'doc')", [
        LIVE_DOC,
        ARCHIVED_DOC,
      ]);
      await getDb().query(
        'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
        [ARCHIVED_DOC]
      );
      const ok = await writeAgentEntries('agent_items', {
        insert: [
          {
            id: ROW_A,
            values: {
              notes: `See [B](entry:${items.id}/${ROW_B}), [T](table:${links.id}), [D](${LIVE_DOC}), [D2](doc:${LIVE_DOC}) and \`[x](${ABSENT_DOC})\``,
            },
          },
          { id: ROW_B, values: {} },
        ],
      });
      expect(ok.inserted).toHaveLength(2);

      const refused = async (notes: string, fragment: string) => {
        await expect(
          writeAgentEntries('agent_items', { insert: [{ values: { notes } }] })
        ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(fragment) });
      };
      await refused(`[x](entry:${items.id}/${MISSING})`, `entry:${items.id}/${MISSING}`);
      await refused(`[x](entry:${MISSING_TABLE}/${ROW_A})`, 'no such custom table');
      await refused(`[x](entry:table-builtin-docs/${ROW_A})`, 'no such custom table');
      await refused('[x](entry:nope)', 'entry:nope');
      await refused(`[x](table:${MISSING_TABLE})`, `table:${MISSING_TABLE}`);
      await refused(`[Doc](${ABSENT_DOC})`, ABSENT_DOC);
      await refused(`[Doc](${ARCHIVED_DOC})`, 'archived');
      await refused(`[Doc](container:${LIVE_DOC})`, 'not a container');
      expect(await rowCount('agent_items')).toBe(2);
    });

    it('refuses a write addressed by a name the table no longer has', async () => {
      await expect(
        TableEntries.writeBatch(items.id, { inserts: [], updates: [], expectedName: 'old_items' })
      ).rejects.toMatchObject({ statusCode: 409, details: { table: { name: 'agent_items' } } });
    });
  });

  describe('applyAgentSchema', () => {
    it('creates a table with fields in one call and emits once', async () => {
      const result = await applyAgentSchema('agent_new', {
        fields: [
          { name: 'done', type: 'checkbox', nullable: false, default: false },
          { name: 'due', type: 'date', before: 'name' },
        ],
      });
      expect(result.created).toBe(true);
      expect(result.table).toMatchObject({ name: 'agent_new', rows: 0, rowsCapped: false });
      expect(result.table.fields.map((field) => field.name)).toEqual([
        'due',
        'name',
        'id',
        'created_at',
        'done',
      ]);
      expect(emitCreated).toHaveBeenCalledTimes(1);
      expect(emitCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent_new' }));
      expect(emitFields).toHaveBeenCalledTimes(1);
    });

    it('rolls back a create when a later op fails, leaving nothing', async () => {
      await expect(
        applyAgentSchema('agent_rollback', {
          fields: [{ name: 'notes', type: 'text' }],
          ops: [{ op: 'add_field', field: { name: 'bad', type: 'nope' as 'text' } }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringMatching(/^ops\[0\] add_field: /),
      });
      expect(await TableCatalog.findByName('agent_rollback')).toBeNull();
      const { rows } = await getDb().query<{ exists: boolean }>(
        "SELECT to_regclass('user_tables.agent_rollback') IS NOT NULL AS exists"
      );
      expect(rows[0]?.exists).toBe(false);
      expect(emitCreated).not.toHaveBeenCalled();
    });

    it('rolls back every op of an alter when one fails', async () => {
      await expect(
        applyAgentSchema('agent_items', {
          ops: [
            { op: 'add_field', field: { name: 'extra', type: 'text' } },
            { op: 'update_field', name: 'missing_field', set: { name: 'other' } },
          ],
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('ops[1] update_field: No field named "missing_field"'),
      });
      expect(
        (await describeAgentTable('agent_items')).fields.map((field) => field.name)
      ).not.toContain('extra');
      expect(emitFields).not.toHaveBeenCalled();
    });

    it('refuses to create a name that exists, with that table summary', async () => {
      await expect(
        applyAgentSchema('Agent_Items', { fields: [{ name: 'notes', type: 'text' }] })
      ).rejects.toMatchObject({
        statusCode: 409,
        details: { table: { id: items.id, name: 'agent_items', rows: 0 } },
      });
      await expect(applyAgentSchema('docs', { fields: [] })).rejects.toMatchObject({
        statusCode: 409,
        details: { table: { id: 'table-builtin-docs' } },
      });
    });

    it('renames a field through update_field and keeps its values', async () => {
      await writeAgentEntries('agent_items', {
        insert: [{ id: ROW_A, values: { notes: 'kept' } }],
      });
      const before = fieldNamed(items, 'notes');
      const { created, table } = await applyAgentSchema('agent_items', {
        ops: [
          {
            op: 'update_field',
            name: 'notes',
            set: { name: 'remarks', description: 'Renamed', before: 'name' },
          },
        ],
      });
      expect(created).toBe(false);
      const remarks = fieldNamed(table, 'remarks');
      expect(remarks).toMatchObject({ id: before.id, description: 'Renamed', type: 'text' });
      expect(remarks.revision).toBe(before.revision + 1);
      expect(table.fields[0]?.name).toBe('remarks');
      expect(await valueOf('agent_items', 'remarks', ROW_A)).toBe('kept');
      expect(emitFields).toHaveBeenCalledTimes(1);
      expect(emitFields).toHaveBeenCalledWith(items.id);
    });

    it('changes a field type, dropping a default that no longer fits', async () => {
      await applyAgentSchema('agent_items', {
        ops: [{ op: 'update_field', name: 'notes', set: { default: 'n/a' } }],
      });
      const { table } = await applyAgentSchema('agent_items', {
        ops: [{ op: 'update_field', name: 'notes', set: { type: 'number' } }],
      });
      expect(fieldNamed(table, 'notes')).toMatchObject({ type: 'number', defaultValue: null });
      await expect(
        applyAgentSchema('agent_items', {
          ops: [{ op: 'update_field', name: 'name', set: { type: 'number' } }],
        })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Name field') });
      await expect(
        applyAgentSchema('agent_items', {
          ops: [{ op: 'update_field', name: 'id', set: { description: 'x' } }],
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('reorders the listed fields while managed fields keep their slots', async () => {
      const { table } = await applyAgentSchema('agent_items', {
        ops: [{ op: 'reorder_fields', names: ['amount', 'notes', 'name'] }],
      });
      expect(table.fields.map((field) => field.name)).toEqual([
        'amount',
        'id',
        'created_at',
        'notes',
        'name',
      ]);
      await expect(
        applyAgentSchema('agent_items', {
          ops: [{ op: 'reorder_fields', names: ['amount', 'notes'] }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('missing: name'),
      });
      await expect(
        applyAgentSchema('agent_items', {
          ops: [{ op: 'reorder_fields', names: ['amount', 'amount', 'notes', 'name'] }],
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('renames the table and keeps altering it in the same call', async () => {
      const { table } = await applyAgentSchema('agent_items', {
        ops: [
          { op: 'rename_table', name: 'agent_things' },
          { op: 'add_field', field: { name: 'extra', type: 'checkbox' } },
          { op: 'update_field', name: 'notes', set: { name: 'details' } },
        ],
      });
      expect(table).toMatchObject({ id: items.id, name: 'agent_things' });
      expect(table.fields.map((field) => field.name)).toEqual(
        expect.arrayContaining(['extra', 'details'])
      );
      // Checkboxes default to two-state: required, unchecked.
      expect(fieldNamed(table, 'extra')).toMatchObject({ nullable: false, defaultValue: false });
      expect(emitUpdated).toHaveBeenCalledTimes(1);
      expect(emitUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: 'agent_things' }));
      expect(emitFields).toHaveBeenCalledTimes(1);
      await expect(describeAgentTable('agent_items')).rejects.toMatchObject({ statusCode: 404 });
      expect(fieldNamed(await describeAgentTable('agent_links'), 'item').refName).toBe(
        'agent_things'
      );
    });

    it('adds relations by table name, including multiple and self links', async () => {
      const { table } = await applyAgentSchema('agent_items', {
        ops: [
          { op: 'add_field', field: { name: 'link', type: 'relation', ref: 'agent_links' } },
          {
            op: 'add_field',
            field: { name: 'peers', type: 'relation', ref: 'agent_items', multiple: true },
          },
        ],
      });
      expect(fieldNamed(table, 'link')).toMatchObject({
        referenceTableId: links.id,
        refName: 'agent_links',
        multiple: false,
        nullable: true,
      });
      expect(fieldNamed(table, 'peers')).toMatchObject({
        referenceTableId: items.id,
        multiple: true,
        defaultValue: [],
      });
      await expect(
        applyAgentSchema('agent_items', {
          ops: [{ op: 'add_field', field: { name: 'bad', type: 'relation', ref: 'docs' } }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('custom tables'),
      });
      await expect(
        applyAgentSchema('agent_items', {
          ops: [{ op: 'add_field', field: { name: 'bad', type: 'relation', ref: 'no_table' } }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('no such table'),
      });
    });

    it('turns a single relation into a list and back through update_field', async () => {
      await writeAgentEntries('agent_items', { insert: [{ id: ROW_A, values: {} }] });
      await writeAgentEntries('agent_links', { insert: [{ id: ROW_C, values: { item: ROW_A } }] });
      const list = await applyAgentSchema('agent_links', {
        ops: [{ op: 'update_field', name: 'item', set: { multiple: true } }],
      });
      expect(fieldNamed(list.table, 'item')).toMatchObject({ multiple: true, nullable: false });
      expect(await valueOf('agent_links', 'item', ROW_C)).toEqual([ROW_A]);
      const single = await applyAgentSchema('agent_links', {
        ops: [{ op: 'update_field', name: 'item', set: { multiple: false } }],
      });
      expect(fieldNamed(single.table, 'item')).toMatchObject({ multiple: false, nullable: true });
      expect(await valueOf('agent_links', 'item', ROW_C)).toBe(ROW_A);
    });
  });

  describe('date and time fields', () => {
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

    it('adds a datetime field and writes offset-less values in the user zone', async () => {
      const { table } = await applyAgentSchema('agent_items', {
        ops: [
          {
            op: 'add_field',
            field: { name: 'due_at', type: 'datetime', default: '2026-12-25T09:00' },
          },
        ],
      });
      expect(fieldNamed(table, 'due_at')).toMatchObject({
        type: 'datetime',
        nullable: true,
        managed: false,
        defaultValue: '2026-12-24T20:00:00.000000Z',
      });
      await writeAgentEntries('agent_items', {
        insert: [
          { id: ROW_A, values: { due_at: '2026-10-01T15:30' } },
          { id: ROW_B, values: { due_at: '2026-10-01T22:30:00Z' } },
          { id: ROW_C, values: {} },
        ],
      });
      const instants = async () => {
        const { rows } = await getDb().query<{ id: string; due: string }>(
          `SELECT id::text AS id, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS due
             FROM user_tables.agent_items ORDER BY id`
        );
        return rows.map((row) => row.due);
      };
      expect(await instants()).toEqual([
        '2026-10-01T02:30Z',
        '2026-10-01T22:30Z',
        '2026-12-24T20:00Z',
      ]);
      const unchanged = await writeAgentEntries('agent_items', {
        update: [{ id: ROW_A, values: { due_at: '2026-10-01T02:30:00Z' } }],
      });
      expect(unchanged.unchanged).toEqual([ROW_A]);
      await expect(
        writeAgentEntries('agent_items', {
          update: [{ id: ROW_B, values: { due_at: 'tomorrow 3pm' } }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('ISO 8601'),
      });
    });

    it('drops and restores the time, keeping each date and the default date', async () => {
      await applyAgentSchema('agent_items', {
        ops: [{ op: 'add_field', field: { name: 'due_at', type: 'date', default: '2026-01-31' } }],
      });
      await writeAgentEntries('agent_items', {
        insert: [{ id: ROW_A, values: { due_at: '2026-10-01' } }],
      });
      const withTime = await applyAgentSchema('agent_items', {
        ops: [{ op: 'update_field', name: 'due_at', set: { type: 'datetime' } }],
      });
      expect(fieldNamed(withTime.table, 'due_at')).toMatchObject({
        type: 'datetime',
        defaultValue: '2026-01-30T11:00:00.000000Z',
      });
      await writeAgentEntries('agent_items', {
        update: [{ id: ROW_A, values: { due_at: '2026-10-01T23:30' } }],
      });
      const dateOnly = await applyAgentSchema('agent_items', {
        ops: [{ op: 'update_field', name: 'due_at', set: { type: 'date' } }],
      });
      expect(fieldNamed(dateOnly.table, 'due_at')).toMatchObject({
        type: 'date',
        defaultValue: '2026-01-31',
      });
      const { rows } = await getDb().query<{ due: string }>(
        `SELECT due_at::text AS due FROM user_tables.agent_items WHERE id = $1`,
        [ROW_A]
      );
      expect(rows).toEqual([{ due: '2026-10-01' }]);
    });

    it('turns an end date on and keeps it through Include time, writing ranges by name', async () => {
      await applyAgentSchema('agent_items', {
        ops: [{ op: 'add_field', field: { name: 'stay', type: 'date', default: '2026-01-31' } }],
      });
      await writeAgentEntries('agent_items', {
        insert: [
          { id: ROW_A, values: { stay: '2026-10-12' } },
          { id: ROW_B, values: { stay: null } },
        ],
      });
      // Gaining an end drops the default: a range has none.
      const ranged = await applyAgentSchema('agent_items', {
        ops: [{ op: 'update_field', name: 'stay', set: { range: true } }],
      });
      expect(fieldNamed(ranged.table, 'stay')).toMatchObject({
        type: 'date',
        range: true,
        defaultValue: null,
      });
      await writeAgentEntries('agent_items', {
        update: [{ id: ROW_A, values: { stay: '2026-10-12/2026-10-14' } }],
      });
      // Left out, the end date stays while the time is turned on.
      const timed = await applyAgentSchema('agent_items', {
        ops: [{ op: 'update_field', name: 'stay', set: { type: 'datetime' } }],
      });
      expect(fieldNamed(timed.table, 'stay')).toMatchObject({ type: 'datetime', range: true });
      const read = await readAgentEntries('agent_items', [ROW_A, ROW_B]);
      expect(read.entries.map((entry) => entry.values.stay)).toEqual([
        // Local midnight of the 12th to the midnight after the 14th.
        '2026-10-11T11:00:00.000000Z/2026-10-14T11:00:00.000000Z',
        null,
      ]);
      // A shortened end is refused with the full form to copy.
      await expect(
        writeAgentEntries('agent_items', {
          update: [{ id: ROW_A, values: { stay: '2026-10-12T09:00/10:30' } }],
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('like 2026-10-12T09:00/2026-10-12T10:30'),
      });
      const plain = await applyAgentSchema('agent_items', {
        ops: [{ op: 'update_field', name: 'stay', set: { range: false } }],
      });
      expect(fieldNamed(plain.table, 'stay')).toMatchObject({ type: 'datetime', range: false });
      expect((await readAgentEntries('agent_items', [ROW_A])).entries[0]?.values.stay).toBe(
        '2026-10-11T11:00:00.000000Z'
      );
    });

    it('keeps created_at managed', async () => {
      await expect(
        applyAgentSchema('agent_items', {
          ops: [{ op: 'update_field', name: 'created_at', set: { type: 'date' } }],
        })
      ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('managed') });
    });
  });

  describe('deleteAgentEntries', () => {
    it('deletes entries and reports ids already gone', async () => {
      await writeAgentEntries('agent_items', {
        insert: [
          { id: ROW_A, values: {} },
          { id: ROW_B, values: {} },
        ],
      });
      expect(
        await deleteAgentEntries('agent_items', { ids: [ROW_A, MISSING], clearLinks: false })
      ).toEqual({ deletedIds: [ROW_A], alreadyDeleted: [MISSING], clearedReferences: [] });
      expect(await rowCount('agent_items')).toBe(1);
    });

    it('summarizes links as a 409, then clears them with clearLinks', async () => {
      await writeAgentEntries('agent_items', { insert: [{ id: ROW_A, values: {} }] });
      await writeAgentEntries('agent_links', {
        insert: [{ id: ROW_C, values: { item: ROW_A, items: [ROW_A] } }],
      });
      const refused = await deleteAgentEntries('agent_items', {
        ids: [ROW_A],
        clearLinks: false,
      }).catch((error: unknown) => error);
      expect(refused).toMatchObject({ statusCode: 409 });
      expect((refused as { details: unknown }).details).toEqual({
        references: [
          { tableName: 'agent_links', fieldName: 'item', count: 1 },
          { tableName: 'agent_links', fieldName: 'items', count: 1 },
        ],
      });
      expect(await rowCount('agent_items')).toBe(1);
      const deleted = await deleteAgentEntries('agent_items', { ids: [ROW_A], clearLinks: true });
      expect(deleted.deletedIds).toEqual([ROW_A]);
      expect(deleted.clearedReferences).toHaveLength(2);
      expect(await valueOf('agent_links', 'item', ROW_C)).toBeNull();
      expect(await valueOf('agent_links', 'items', ROW_C)).toEqual([]);
    });
  });
});
