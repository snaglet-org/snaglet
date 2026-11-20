/**
 * Select and multi-select fields through the agent table tools' domain:
 * create with plain labels, write by label and alter options by name.
 * Filtering by label in agent SQL is covered in tableAgentQuery.test.ts,
 * which owns a reader connection.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';

jest.mock('@server/realtime/surfaces/tables', () => ({
  emitTableHistoryChanged: jest.fn(),
  emitTableRemoved: jest.fn(),
  emitTableRestored: jest.fn(),
  emitTableCreated: jest.fn(),
  emitTableUpdated: jest.fn(),
  emitTableFieldsChanged: jest.fn(),
  emitTableEntriesChanged: jest.fn(),
}));
import {
  applyAgentSchema,
  describeAgentTable,
  listAgentTables,
  writeAgentEntries,
  type AgentTableSummary,
} from '@server/domains/tables/tableAgent';
import {
  renderTableDetail,
  renderTableList,
} from '@server/services/ToolService/tools/database/_shared/render';

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

async function column(name: string): Promise<unknown[]> {
  const { rows } = await getDb().query<{ value: unknown }>(
    `SELECT ${quoteIdentifier(name)} AS value FROM user_tables.agent_tasks ORDER BY position, id`
  );
  return rows.map((row) => row.value);
}

function fieldNamed(summary: AgentTableSummary, name: string) {
  const field = summary.fields.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`missing field ${name}`);
  return field;
}

async function seed(): Promise<AgentTableSummary> {
  const { table } = await applyAgentSchema('agent_tasks', {
    fields: [
      { name: 'status', type: 'select', options: ['todo', 'doing', 'done'], default: 'todo' },
      { name: 'tags', type: 'select', multiple: true, options: ['urgent', 'later', 'x|y'] },
    ],
  });
  await writeAgentEntries('agent_tasks', {
    insert: [
      { id: ROW_A, values: { name: 'first', status: 'doing', tags: ['urgent', 'later'] } },
      { id: ROW_B, values: { name: 'second' } },
      { id: ROW_C, values: { name: 'third', status: 'done', tags: ['later'] } },
    ],
  });
  return table;
}

describe('agent select fields (real DB)', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('creates selects from plain labels and shows their options to agents', async () => {
    const table = await seed();
    expect(fieldNamed(table, 'status')).toMatchObject({
      type: 'select',
      multiple: false,
      nullable: true,
      defaultValue: 'todo',
    });
    expect(fieldNamed(table, 'status').options?.map((option) => option.label)).toEqual([
      'todo',
      'doing',
      'done',
    ]);
    expect(fieldNamed(table, 'tags')).toMatchObject({
      multiple: true,
      nullable: false,
      defaultValue: [],
    });
    const detail = renderTableDetail(await describeAgentTable('agent_tasks'));
    expect(detail).toContain('\nstatus select(todo|doing|done)? = "todo"\n');
    expect(detail).toContain('\ntags select[](urgent|later|"x|y")\n');
    expect(detail).toContain('"status":"todo"');
    expect(detail).toContain('"tags":["urgent"]');
    expect(renderTableList(await listAgentTables())).toContain(
      'agent_tasks (3): name* text, status select(todo|doing|done)?, tags select[](urgent|later|"x|y")'
    );
    expect(await column('status')).toEqual(['doing', 'todo', 'done']);
    expect(await column('tags')).toEqual([['urgent', 'later'], [], ['later']]);
  });

  it('refuses an unknown label with the allowed ones and writes nothing', async () => {
    await seed();
    await expect(
      writeAgentEntries('agent_tasks', {
        insert: [{ values: { name: 'x', status: 'blocked' } }],
        update: [{ id: ROW_A, values: { status: 'done' } }],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'insert[0]: "blocked" is not an option of status. Options: todo, doing, done.',
    });
    await expect(
      writeAgentEntries('agent_tasks', {
        update: [{ id: ROW_A, values: { tags: ['later', 'later'] } }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await column('status')).toEqual(['doing', 'todo', 'done']);
  });

  it('renames with {from,to}, removes unlisted options and lets the default follow', async () => {
    const seeded = await seed();
    const { table } = await applyAgentSchema('agent_tasks', {
      ops: [
        {
          op: 'update_field',
          name: 'status',
          set: { options: [{ from: 'todo', to: 'backlog' }, 'doing', 'blocked'] },
        },
        {
          op: 'update_field',
          name: 'tags',
          set: { options: ['later', { label: 'soon', color: 'red' }] },
        },
      ],
    });
    const status = fieldNamed(table, 'status');
    expect(status.options?.map((option) => option.label)).toEqual(['backlog', 'doing', 'blocked']);
    expect(status.defaultValue).toBe('backlog');
    expect(await column('status')).toEqual(['doing', 'backlog', null]);
    const tags = fieldNamed(table, 'tags');
    expect(tags.options?.map((option) => [option.label, option.color])).toEqual([
      ['later', fieldNamed(seeded, 'tags').options?.[1]?.color],
      ['soon', 'red'],
    ]);
    expect(await column('tags')).toEqual([['later'], [], ['later']]);

    await expect(
      applyAgentSchema('agent_tasks', {
        ops: [
          { op: 'update_field', name: 'status', set: { options: [{ from: 'nope', to: 'x' }] } },
        ],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(
        'No option "nope" to rename. Options: backlog, doing, blocked.'
      ),
    });
  });

  it('turns a list into one value and back, carrying the default', async () => {
    await applyAgentSchema('agent_tasks', {
      fields: [
        { name: 'stage', type: 'select', options: ['a', 'b'], default: 'a', nullable: false },
      ],
    });
    await writeAgentEntries('agent_tasks', { insert: [{ id: ROW_A, values: { stage: 'b' } }] });
    let { table } = await applyAgentSchema('agent_tasks', {
      ops: [{ op: 'update_field', name: 'stage', set: { multiple: true } }],
    });
    expect(fieldNamed(table, 'stage')).toMatchObject({ multiple: true, defaultValue: ['a'] });
    expect(await column('stage')).toEqual([['b']]);
    ({ table } = await applyAgentSchema('agent_tasks', {
      ops: [{ op: 'update_field', name: 'stage', set: { multiple: false } }],
    }));
    expect(fieldNamed(table, 'stage')).toMatchObject({
      multiple: false,
      nullable: true,
      defaultValue: 'a',
    });
    expect(await column('stage')).toEqual(['b']);
  });

  it('turns a text field into a select whose options are its values', async () => {
    await applyAgentSchema('agent_tasks', { fields: [{ name: 'phase', type: 'text' }] });
    await writeAgentEntries('agent_tasks', {
      insert: [
        { values: { phase: 'plan' } },
        { values: { phase: 'build' } },
        { values: { phase: 'plan' } },
        { values: {} },
      ],
    });
    const { table } = await applyAgentSchema('agent_tasks', {
      ops: [{ op: 'update_field', name: 'phase', set: { type: 'select', options: ['ship'] } }],
    });
    expect(fieldNamed(table, 'phase').options?.map((option) => option.label)).toEqual([
      'ship',
      'plan',
      'build',
    ]);
    expect(await column('phase')).toEqual(['plan', 'build', 'plan', null]);
  });

  it('refuses renames on a new field', async () => {
    await expect(
      applyAgentSchema('agent_tasks', {
        fields: [{ name: 'status', type: 'select', options: [{ from: 'a', to: 'b' }] }],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await TableCatalog.findByName('agent_tasks')).toBeNull();
  });
});
