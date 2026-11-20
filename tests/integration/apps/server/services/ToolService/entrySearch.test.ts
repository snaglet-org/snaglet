/**
 * search(kinds:["entry"]) over a real database: ranking by the table's title
 * field (here `summary`, not `name`), recency, filters, table resolution and
 * refusals, and the scan cap.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { TableFields } from '@snaglet/db/tables/table_fields';
import { searchEntries } from '@snaglet/db/tables/table_entries';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
}));
import { applyAgentSchema, writeAgentEntries } from '@server/domains/tables/tableAgent';
import entrySearch from '@server/services/ToolService/handlers/search/entrySearch';

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

interface Result {
  entries: Array<{
    id: string;
    ref: string;
    title: string;
    table: string;
    snippet?: string;
    created_at: string;
  }>;
  tables_searched: number;
  tables_omitted?: number;
  table_match?: {
    chosen: Array<{ table: string; why: string[] }>;
    also_matched?: string[];
    searched_for?: string;
    widened?: boolean;
    note: string;
  };
}

async function search(input: Record<string, unknown>): Promise<Result> {
  return JSON.parse(
    (await entrySearch({ kinds: ['entry'], ...input }, {}, undefined)) as string
  ) as Result;
}

const ID = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

/** A `tasks` table whose title field is `summary` (the default `name` is just another text field). */
async function seedTasks(): Promise<void> {
  await applyAgentSchema('tasks', {
    fields: [
      { name: 'summary', type: 'text' },
      { name: 'notes', type: 'text' },
      { name: 'status', type: 'select', options: ['todo', 'doing', 'done'] },
    ],
    ops: [{ op: 'set_title_field', name: 'summary' }],
  });
  const rows: Array<Record<string, string>> = [
    { summary: 'Fix memories cleanup', notes: 'prune old rows', status: 'doing' },
    { summary: 'Memories', notes: 'the epic', status: 'todo' },
    { summary: 'Embedding tables', notes: 'vectors for the table rows', status: 'todo' },
    {
      summary: 'Ship the release',
      notes: 'blocked on memories review of the long note',
      status: 'done',
    },
    { summary: 'Memories index', notes: '', status: 'doing' },
  ];
  // One write per row so each has its own created_at, oldest first.
  for (const [index, values] of rows.entries())
    await writeAgentEntries('tasks', { insert: [{ id: ID(index + 1), values }] });
}

describe('search kinds:["entry"] (real DB)', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('ranks the title field: exact, then prefix, then other matches', async () => {
    await seedTasks();
    const { entries } = await search({ query: 'memories', table: 'tasks' });
    expect(entries.map((entry) => entry.title)).toEqual([
      'Memories',
      'Memories index',
      'Fix memories cleanup',
      'Ship the release',
    ]);
    expect(entries[0]).toMatchObject({
      table: 'tasks',
      ref: expect.stringMatching(/^entry:table-.+\/2{8}-/),
    });
  });

  it('finds the embedding task and carries a short snippet from a non-title text field', async () => {
    await seedTasks();
    const { entries } = await search({ query: 'embedding' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('Embedding tables');
    const release = (await search({ query: 'memories review' })).entries[0]!;
    expect(release.title).toBe('Ship the release');
    expect(release.snippet).toContain('memories');
    expect(release.snippet!.length).toBeLessThanOrEqual(150);
  });

  it('sort:"recent" orders by creation time, newest first, and an empty query lists the newest', async () => {
    await seedTasks();
    const recent = await search({ query: 'memories', table: 'tasks', sort: 'recent' });
    expect(recent.entries.map((entry) => entry.title)).toEqual([
      'Memories index',
      'Ship the release',
      'Memories',
      'Fix memories cleanup',
    ]);
    const newest = await search({ table: 'tasks', limit: 2 });
    expect(newest.entries.map((entry) => entry.title)).toEqual([
      'Memories index',
      'Ship the release',
    ]);
  });

  it('filters by a field of the named table, and refuses unknown fields and a missing table', async () => {
    await seedTasks();
    const doing = await search({
      query: 'memories',
      table: 'tasks',
      filters: [{ field: 'status', operator: 'is', value: 'doing' }],
    });
    expect(doing.entries.map((entry) => entry.title).sort()).toEqual([
      'Fix memories cleanup',
      'Memories index',
    ]);
    await expect(
      search({ table: 'tasks', filters: [{ field: 'nope', operator: 'is', value: 'x' }] })
    ).rejects.toThrow(/unknown field: nope\. Valid names: .*status/);
    await expect(
      search({ query: 'memories', filters: [{ field: 'status', operator: 'is', value: 'doing' }] })
    ).rejects.toThrow('filters apply to one table: pass table too.');
  });

  it('refuses tables the caller cannot read: archived, Snaglet built-in and unknown', async () => {
    await seedTasks();
    await applyAgentSchema('old_tasks', { fields: [{ name: 'summary', type: 'text' }] });
    await applyAgentSchema('old_tasks', { ops: [{ op: 'archive_table' }] });
    await expect(search({ query: 'x', table: 'old_tasks' })).rejects.toThrow(/archived/);
    await expect(search({ query: 'x', table: 'no_such_table' })).rejects.toThrow(/No table named/);
    const { rows } = await getDb().query<{ name: string }>(
      "SELECT name FROM public.table_catalog WHERE origin = 'builtin' LIMIT 1"
    );
    if (rows[0])
      await expect(search({ query: 'x', table: rows[0].name })).rejects.toThrow(/Snaglet table/);
    // Without `table`, an archived table's rows are never read.
    expect((await search({ query: 'summary' })).tables_searched).toBe(1);
  });

  it('refuses an ambiguous table name rather than guessing', async () => {
    await applyAgentSchema('task_log', { fields: [{ name: 'summary', type: 'text' }] });
    await applyAgentSchema('task_list', { fields: [{ name: 'summary', type: 'text' }] });
    await expect(search({ query: 'x', table: 'task_l' })).rejects.toThrow(/More than one table/);
  });

  it('caps the tables read when none is named and says how many were left out', async () => {
    for (const name of ['aaa_one', 'bbb_two', 'ccc_three']) {
      await applyAgentSchema(name, { fields: [{ name: 'summary', type: 'text' }] });
      await writeAgentEntries(name, { insert: [{ values: { summary: `${name} memories` } }] });
    }
    const capped = await searchEntries({ q: 'memories', limit: 10, maxTables: 2 });
    expect(capped).toMatchObject({ tablesSearched: 2, tablesOmitted: 1 });
    expect(capped.hits).toHaveLength(2);
    // A one-table filter needs a table.
    await expect(
      searchEntries({ q: 'x', limit: 5, where: [{ fieldId: 'f', operator: 'is' }] })
    ).rejects.toThrow(/Field filters apply to one table/);
  });

  it('uses the configured title field, not a column called name', async () => {
    await seedTasks();
    // `name` still holds text but is not the title: a row matched only
    // through it ranks below a title match.
    await writeAgentEntries('tasks', {
      insert: [
        { id: ID(9), values: { name: 'memories in the old name column', summary: 'Unrelated' } },
      ],
    });
    const { entries } = await search({ query: 'memories', table: 'tasks' });
    expect(entries[0]!.title).toBe('Memories');
    expect(entries.map((entry) => entry.title)).toContain('Unrelated');
    const fields = await TableFields.listFields(
      (await TableCatalog.listTables({ origin: 'custom' }))[0]!.id
    );
    expect(fields.find((field) => field.isTitle)?.name).toBe('summary');
  });
});

describe('table-level matching before the row search (real DB)', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('routes "task" to the tasks table by name, then ranks rows by the title field `summary`', async () => {
    await seedTasks();
    // Another table holds a row that also says "memories": routing must not read it.
    await applyAgentSchema('journal', { fields: [{ name: 'summary', type: 'text' }] });
    await writeAgentEntries('journal', {
      insert: [{ values: { summary: 'memories of last week' } }],
    });
    const reply = await search({ query: 'task memories' });
    expect(reply.table_match).toMatchObject({
      chosen: [{ table: 'tasks', why: ['name has "task"'] }],
      searched_for: 'memories',
    });
    expect(reply.tables_searched).toBe(1);
    expect(reply.entries.map((entry) => entry.title)).toEqual([
      'Memories',
      'Memories index',
      'Fix memories cleanup',
      'Ship the release',
    ]);
    expect(reply.entries.every((entry) => entry.table === 'tasks')).toBe(true);
    // "latest task memories": the agent turns "latest" into the sort and drops the word.
    const latest = await search({ query: 'task memories', sort: 'recent', limit: 1 });
    expect(latest.entries.map((entry) => entry.title)).toEqual(['Memories index']);
  });

  it('finds "embedding tables task" in the tasks table by title', async () => {
    await seedTasks();
    await applyAgentSchema('contacts', { fields: [{ name: 'company', type: 'text' }] });
    const reply = await search({ query: 'embedding tables task' });
    expect(reply.table_match?.chosen[0]?.table).toBe('tasks');
    expect(reply.entries.map((entry) => entry.title)).toEqual(['Embedding tables']);
  });

  it('matches through a select option and a field name', async () => {
    await seedTasks();
    await applyAgentSchema('contacts', { fields: [{ name: 'company', type: 'text' }] });
    const byOption = await search({ query: 'doing' });
    expect(byOption.table_match?.chosen[0]).toEqual({
      table: 'tasks',
      why: ['field "status" option "doing"'],
    });
    expect(byOption.entries.map((entry) => entry.title).sort()).toEqual([
      'Fix memories cleanup',
      'Memories index',
    ]);
    expect((await search({ query: 'company' })).table_match?.chosen[0]?.table).toBe('contacts');
  });

  it('searches only the best three tables and names the rest', async () => {
    for (const name of ['task_a', 'task_b', 'task_c', 'task_d', 'task_e']) {
      await applyAgentSchema(name, { fields: [{ name: 'summary', type: 'text' }] });
      await writeAgentEntries(name, { insert: [{ values: { summary: `row in ${name}` } }] });
    }
    const reply = await search({ query: 'task' });
    expect(reply.table_match?.chosen).toHaveLength(3);
    expect(reply.table_match?.also_matched).toHaveLength(2);
    expect(reply.tables_searched).toBe(3);
    expect(reply.entries).toHaveLength(3);
    // match_tables:false reads all five.
    expect((await search({ query: 'task', match_tables: false })).tables_searched).toBe(5);
  });

  it('breaks a score tie toward the table edited most recently', async () => {
    for (const name of ['task_old', 'task_new']) {
      await applyAgentSchema(name, { fields: [{ name: 'summary', type: 'text' }] });
      await writeAgentEntries(name, { insert: [{ values: { summary: name } }] });
    }
    await getDb().query(
      `INSERT INTO public.table_history (id, actor_kind, actor_id, seq, state, kind, label, table_ids, ops)
       SELECT 'h-' || name, 'user', 'test-user', row_number() OVER (), 'done', 'edit', 'edit',
              ARRAY[id], '[]'::jsonb FROM public.table_catalog WHERE name IN ('task_old', 'task_new')`
    );
    await getDb().query(
      `UPDATE public.table_history SET updated_at = now() + interval '1 hour' WHERE id = 'h-task_new'`
    );
    const reply = await search({ query: 'task' });
    expect(reply.table_match?.chosen.map((match) => match.table)).toEqual(['task_new', 'task_old']);
  });

  it('searches up to the cap, saying so, when no table answers to the words', async () => {
    await seedTasks();
    const reply = await search({ query: 'memories' });
    expect(reply.table_match).toMatchObject({
      chosen: [],
      note: expect.stringMatching(/No table name, field name or select option matched/),
    });
    expect(reply.entries.length).toBeGreaterThan(0);
  });

  it('widens to every table for the remaining words when the matched tables hold none', async () => {
    await seedTasks();
    await applyAgentSchema('notes', { fields: [{ name: 'summary', type: 'text' }] });
    await writeAgentEntries('notes', { insert: [{ values: { summary: 'zebra migration plan' } }] });
    const reply = await search({ query: 'task zebra' });
    expect(reply.table_match).toMatchObject({
      chosen: [{ table: 'tasks' }],
      widened: true,
      note: expect.stringMatching(/every table was searched for "zebra"/),
    });
    expect(reply.entries.map((entry) => entry.table)).toEqual(['notes']);
  });

  it('skips matching with an explicit table, and never routes to archived tables', async () => {
    await seedTasks();
    await applyAgentSchema('task_old', { fields: [{ name: 'summary', type: 'text' }] });
    await applyAgentSchema('task_old', { ops: [{ op: 'archive_table' }] });
    const explicit = await search({ query: 'memories', table: 'tasks' });
    expect(explicit.table_match).toBeUndefined();
    const routed = await search({ query: 'task' });
    expect(routed.table_match?.chosen.map((match) => match.table)).toEqual(['tasks']);
  });
});
