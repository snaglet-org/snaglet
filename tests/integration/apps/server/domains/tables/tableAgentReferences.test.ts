/**
 * Agent table tools with relations to Snaglet items, against real PostgreSQL:
 * `ref: "snaglet:<kind>"` creates them, writes take ids, a chip or an exact title,
 * reads name the target as `snaglet:<kind>`, SQL returns ids with a titles line,
 * and a relation can convert to chip text and back.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, getDbClient } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import {
  applyAgentSchema,
  describeAgentTable,
  queryAgentTables,
  writeAgentEntries,
} from '@server/domains/tables/tableAgent';
import { loadTestClusterHandoff } from '../../../../../support/pgTestCluster';
import {
  AGENT_A,
  AGENT_B,
  DOC_A,
  DOC_ARCHIVED,
  DOC_B,
  TITLES,
  cleanReferenceFixtures,
  seedReferenceFixtures,
} from '../../../../../support/tableReferenceFixtures';

const handoff = loadTestClusterHandoff();
const database = process.env.SNAGLET_PG_TEST_DATABASE;
if (!database) throw new Error('Missing SNAGLET_PG_TEST_DATABASE');
const readerPassword = createHash('sha256')
  .update(`${TABLES_READER_ROLE}:${handoff.runToken}`)
  .digest('base64url');
{
  const url = new URL('postgresql://localhost');
  url.username = TABLES_READER_ROLE;
  url.password = readerPassword;
  url.pathname = `/${database}`;
  url.searchParams.set('host', handoff.host);
  url.port = String(handoff.port);
  url.searchParams.set('sslmode', 'disable');
  process.env.SNAGLET_TABLES_READER_URL = url.toString();
}

const ROW_A = '11111111-1111-4111-8111-111111111111';
const ROW_B = '22222222-2222-4222-8222-222222222222';

async function valueOf(column: string, id: string): Promise<unknown> {
  const { rows } = await getDb().query<{ value: unknown }>(
    `SELECT ${quoteIdentifier(column)} AS value FROM user_tables.reading_log WHERE id = $1`,
    [id]
  );
  return rows[0]?.value;
}

async function reject(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { statusCode?: number; message: string };
  }
  throw new Error('expected a rejection');
}

describe('agent table tools with Snaglet item relations (real DB)', () => {
  beforeAll(async () => {
    await provisionTablesReaderRole(await getDbClient(), {
      password: readerPassword,
      database,
      revokePublic: true,
    });
  }, 30_000);
  beforeEach(async () => {
    await cleanReferenceFixtures();
    await seedReferenceFixtures();
    await applyAgentSchema('reading_log', {
      fields: [
        { name: 'brief', type: 'relation', ref: 'snaglet:doc' },
        { name: 'owners', type: 'relation', ref: 'Snaglet:Agent', multiple: true },
      ],
    });
  });
  afterAll(cleanReferenceFixtures);

  it('creates snaglet: relations and names their kind in reads', async () => {
    const table = await describeAgentTable('reading_log');
    expect(table.fields.find((field) => field.name === 'brief')).toMatchObject({
      type: 'relation',
      referenceKind: 'doc',
      referenceTableId: null,
      refName: 'snaglet:doc',
    });
    expect(table.fields.find((field) => field.name === 'owners')).toMatchObject({
      referenceKind: 'agent',
      multiple: true,
      refName: 'snaglet:agent',
    });
    const unknown = await reject(() =>
      applyAgentSchema('reading_log', {
        ops: [
          { op: 'add_field', field: { name: 'keys', type: 'relation', ref: 'snaglet:credential' } },
        ],
      })
    );
    expect(unknown).toMatchObject({ statusCode: 400 });
    expect(unknown.message).toContain('snaglet:doc, snaglet:project');
    const builtin = await reject(() =>
      applyAgentSchema('reading_log', {
        ops: [
          { op: 'add_field', field: { name: 'secrets', type: 'relation', ref: 'credentials' } },
        ],
      })
    );
    expect(builtin.message).toContain('custom tables or Snaglet items');
  });

  it('writes ids, a chip or an exact title, and refuses ambiguous titles', async () => {
    const written = await writeAgentEntries('reading_log', {
      insert: [
        {
          id: ROW_A,
          values: {
            name: 'first',
            brief: `[Launch brief](${DOC_A})`,
            owners: ['test agent a', AGENT_B],
          },
        },
        { id: ROW_B, values: { name: 'second', brief: TITLES[DOC_B] ?? '' } },
      ],
    });
    expect(written.inserted.map((row) => row.id)).toEqual([ROW_A, ROW_B]);
    expect(await valueOf('brief', ROW_A)).toBe(DOC_A);
    expect(await valueOf('owners', ROW_A)).toEqual([AGENT_A, AGENT_B]);
    expect(await valueOf('brief', ROW_B)).toBe(DOC_B);

    // Two live docs with one title: the agent must say which.
    await getDb().query('UPDATE public.docs SET title = $2 WHERE id = $1', [DOC_B, TITLES[DOC_A]]);
    const ambiguous = await reject(() =>
      writeAgentEntries('reading_log', {
        update: [{ id: ROW_B, values: { brief: TITLES[DOC_A] ?? '' } }],
      })
    );
    expect(ambiguous).toMatchObject({ statusCode: 400 });
    expect(ambiguous.message).toContain('2 docs are titled "Launch brief"; give an id');
    const archived = await reject(() =>
      writeAgentEntries('reading_log', { update: [{ id: ROW_B, values: { brief: DOC_ARCHIVED } }] })
    );
    expect(archived.message).toContain('is archived. Restore it before linking.');
    expect(await valueOf('brief', ROW_B)).toBe(DOC_B);
  });

  it('returns raw ids from SQL with a titles line for item columns', async () => {
    await writeAgentEntries('reading_log', {
      insert: [{ id: ROW_A, values: { name: 'first', brief: DOC_A, owners: [AGENT_A, AGENT_B] } }],
    });
    const result = await queryAgentTables('select name, brief, owners from reading_log', {
      limit: 10,
      maxCell: 200,
    });
    expect(result.rows).toEqual([['first', DOC_A, JSON.stringify([AGENT_A, AGENT_B])]]);
    expect(result.itemTitles).toEqual([
      { id: DOC_A, title: TITLES[DOC_A], archived: false },
      { id: AGENT_A, title: TITLES[AGENT_A], archived: false },
      { id: AGENT_B, title: TITLES[AGENT_B], archived: false },
    ]);
    const plain = await queryAgentTables('select name from reading_log', {
      limit: 10,
      maxCell: 200,
    });
    expect(plain).not.toHaveProperty('itemTitles');
  });

  it('converts a relation to chip text and back through update_field', async () => {
    await writeAgentEntries('reading_log', {
      insert: [{ id: ROW_A, values: { name: 'first', brief: DOC_A } }],
    });
    await applyAgentSchema('reading_log', {
      ops: [{ op: 'update_field', name: 'brief', set: { type: 'text' } }],
    });
    expect(await valueOf('brief', ROW_A)).toBe(`[Launch brief](${DOC_A})`);
    const back = await applyAgentSchema('reading_log', {
      ops: [{ op: 'update_field', name: 'brief', set: { type: 'relation', ref: 'snaglet:doc' } }],
    });
    expect(back.table.fields.find((field) => field.name === 'brief')?.refName).toBe('snaglet:doc');
    expect(await valueOf('brief', ROW_A)).toBe(DOC_A);
  });
});
