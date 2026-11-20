/**
 * kind:"database" (databaseSearch) against the shared managed test cluster.
 *
 * The handler runs through TableQuery, i.e. as the read-only `snaglet_tables_reader`
 * role, which is granted the `user_tables` schema only. This proves the boundary
 * end to end on a real database: a custom Database table returns rows, while
 * every workspace table (`agents`, `memories`, `messages`, `settings`),
 * credential table, `pg_catalog` relation and unknown name is refused with the
 * same plain "no such table" message — never the app superuser's view.
 *
 * The reader URL must be set before the first `getDbClient()` opens the app
 * pool — same ordering as tableAgentQuery.test.ts.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, getDbClient } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  provisionTablesReaderRole,
  TABLES_READER_ROLE,
} from '@snaglet/db/runtime/postgres/runtime';
import { TableCatalog } from '@snaglet/db/tables/table_catalog';
import { applyAgentSchema, writeAgentEntries } from '@server/domains/tables/tableAgent';
import databaseSearch from '@server/services/ToolService/handlers/search/databaseSearch';
import { loadTestClusterHandoff } from '../../../../../support/pgTestCluster';

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

/** The single refusal message the handler uses for every non-custom table. */
const REFUSAL = 'reads custom Database tables only';

async function cleanupCustom(): Promise<void> {
  for (const table of await TableCatalog.listTables({ origin: 'custom' }))
    await getDb().query(
      `DROP TABLE IF EXISTS user_tables.${quoteIdentifier(table.tableName)} CASCADE`
    );
  await getDb().query(
    "DELETE FROM public.table_fields WHERE table_id IN (SELECT id FROM public.table_catalog WHERE origin = 'custom')"
  );
  await getDb().query("DELETE FROM public.table_catalog WHERE origin = 'custom'");
}

async function search(input: Record<string, unknown>): Promise<string> {
  const result = await databaseSearch(input, {}, {} as never);
  if (typeof result !== 'string') throw new Error('databaseSearch returns text');
  return result;
}

/** databaseSearch surfaces a refusal as a thrown Error; capture its message. */
async function failure(input: Record<string, unknown>): Promise<string> {
  try {
    return await search(input);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('kind:"database" search (real DB, snaglet_tables_reader)', () => {
  let probeTable = '';

  beforeAll(async () => {
    await cleanupCustom();
    await provisionTablesReaderRole(await getDbClient(), {
      password: readerPassword,
      database,
      revokePublic: true,
    });
    await applyAgentSchema('dbsearch_probe', {
      fields: [{ name: 'label', type: 'text' }],
    });
    await writeAgentEntries('dbsearch_probe', {
      insert: [{ values: { name: 'findable row' } }, { values: { name: 'other' } }],
    });
    // The reader resolves the physical table name in `user_tables`, which the
    // catalog maps from the display name.
    const [created] = await TableCatalog.listTables({ origin: 'custom' });
    if (!created) throw new Error('custom probe table was not created');
    probeTable = created.tableName;
  }, 60_000);

  afterAll(async () => {
    await cleanupCustom();
  });

  describe('a custom Database table is searchable', () => {
    it('finds rows in a custom table by keyword', async () => {
      const found = await search({ table: probeTable, query: 'findable' });
      expect(found).toContain('findable row');
      expect(found).not.toContain('other');
    });

    it('returns requested columns with a filter on a custom table', async () => {
      const row = await search({
        table: probeTable,
        columns: ['name'],
        filters: { name: 'other' },
      });
      expect(row).toContain('other');
      expect(row).not.toContain('findable row');
    });
  });

  describe('every non-custom table is refused with the same message', () => {
    // Workspace tables, credential tables,
    // catalog relations that resolve for any role without a schema name, and an
    // unknown name — all must give the one plain refusal.
    const forbidden = [
      'agents',
      'memories',
      'messages',
      'settings',
      'pg_settings',
      'pg_roles',
      'pg_views',
      'pg_authid',
      'user_provider_credentials',
      'definitely_not_a_table_12345',
      // Schema-qualified, quoted and mixed-case spellings of the same names.
      'public.agents',
      'pg_catalog.pg_settings',
      'information_schema.tables',
      'information_schema',
      'tables',
      '"agents"',
      'Agents',
      'PG_SETTINGS',
    ];

    it.each(forbidden)('refuses %s with the custom-tables-only message', async (table) => {
      const message = await failure({ table, query: 'x' });
      expect(message).toContain(REFUSAL);
    });

    it('never leaks data from a refused workspace or catalog table', async () => {
      const agents = await failure({ table: 'agents', columns: ['name'], query: 'System' });
      expect(agents).toContain(REFUSAL);
      expect(agents).not.toContain('System');
      const roles = await failure({ table: 'pg_roles', columns: ['rolname'] });
      expect(roles).toContain(REFUSAL);
      expect(roles).not.toContain(TABLES_READER_ROLE);
    });

    it('reads a custom table named after a catalog view, not the catalog', async () => {
      await getDb().query(
        'CREATE TABLE user_tables.pg_settings (name text, setting text, note text)'
      );
      await getDb().query(
        "INSERT INTO user_tables.pg_settings (name, setting, note) VALUES ('mine', 'custom', 'decoy row')"
      );
      await getDb().query('GRANT SELECT ON user_tables.pg_settings TO ' + TABLES_READER_ROLE);
      try {
        // The custom table has exactly one row and three columns; the catalog
        // view has hundreds of rows and columns such as `unit` and `vartype`.
        const all = await search({ table: 'pg_settings' });
        const [header, , ...dataLines] = all.split('\n');
        expect(header).toBe('name | setting | note');
        expect(dataLines).toEqual(['mine | custom | decoy row']);
        const found = await search({ table: 'pg_settings', query: 'decoy' });
        expect(found.split('\n').slice(2)).toEqual(['mine | custom | decoy row']);
        const catalogColumn = await failure({ table: 'pg_settings', columns: ['vartype'] });
        expect(catalogColumn).not.toContain('integer');
      } finally {
        await getDb().query('DROP TABLE IF EXISTS user_tables.pg_settings');
      }
    });

    it('refuses the immutable credential table before Postgres (same message)', async () => {
      const message = await failure({
        table: 'user_provider_credentials',
        columns: ['encrypted_secret'],
      });
      expect(message).toContain(REFUSAL);
    });
  });
});
