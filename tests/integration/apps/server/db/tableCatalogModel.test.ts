/**
 * `public.table_catalog` against the real database: the builtin seed,
 * camelCase mapping, deterministic listing and origin filter, lookups,
 * case-insensitive name uniqueness, the origin / physical-name / reserved-id /
 * custom name-is-table CHECKs, seed replay (idempotent, builtins healed, custom
 * rows and their `user_tables` physical tables untouched), physical creation and
 * real renames, and `registerCustom` joining — and rolling back with — its
 * caller's transaction.
 */

import { afterAll, describe, expect, it } from '@jest/globals';
import { Containers, getDb, getDbClient, transaction } from '@snaglet/db';
import { ensureBuiltinCatalog, reapplySeedFiles, SEED_REPLAY_FILES } from '@snaglet/db/migrations';
import { TableCatalog, toTableCatalogEntry } from '@snaglet/db/tables/table_catalog';

const BUILTINS: ReadonlyArray<[id: string, name: string, tableName: string]> = [
  ['table-builtin-docs', 'Docs', 'docs'],
  ['table-builtin-containers', 'Containers', 'containers'],
  ['table-builtin-hooks', 'Hooks', 'hook_registrations'],
  ['table-builtin-tools', 'Tools', 'tools'],
  ['table-builtin-files', 'Files', 'files'],
  ['table-builtin-images', 'Images', 'images'],
  ['table-builtin-threads', 'Threads', 'threads'],
  ['table-builtin-agents', 'Agents', 'agents'],
  ['table-builtin-providers', 'Providers', 'providers'],
  ['table-builtin-models', 'Models', 'models'],
  ['table-builtin-credentials', 'Credentials', 'user_provider_credentials'],
  ['table-builtin-automations', 'Automations', 'automations'],
];

const CUSTOM_ID = 'table-1111111111111-aaaaaaaaa';
const CUSTOM_ID_B = 'table-1111111111111-bbbbbbbbb';
const CUSTOM_ID_C = 'table-1111111111111-ccccccccc';
// A custom table's name is its real physical name.
const PHYSICAL = 'test_table';
const PHYSICAL_B = 'test_table_b';
const PHYSICAL_C = 'test_table_c';
const RENAMED = 'renamed_table';
const PROJECT = 'container-1111111111111-project1';
const MISSING_ID = 'table-1111111111111-zzzzzzzzz';

class RollbackSentinel extends Error {}

async function physicalExists(tableName: string): Promise<boolean> {
  const { rows } = await getDb().query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`user_tables.${tableName}`]
  );
  return rows[0]?.present === true;
}

async function catalogRows(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await getDb().query<Record<string, unknown>>(
    'SELECT * FROM public.table_catalog ORDER BY id'
  );
  return rows;
}

async function pgError(
  run: () => Promise<unknown>
): Promise<{ code?: string; constraint?: string } | undefined> {
  try {
    await run();
  } catch (err) {
    const { code, constraint } = err as { code?: string; constraint?: string };
    return { code, constraint };
  }
  return undefined;
}

async function pgErrorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  return (await pgError(run))?.code;
}

describe('table_catalog (real DB)', () => {
  afterAll(async () => {
    await getDb().query('DELETE FROM public.table_catalog WHERE origin = $1', ['custom']);
    await getDb().query('DELETE FROM public.nodes WHERE id = $1', [PROJECT]);
    for (const name of [PHYSICAL, PHYSICAL_B, PHYSICAL_C, RENAMED]) {
      await getDb().query(`DROP TABLE IF EXISTS user_tables."${name}"`);
    }
  });

  describe('table_catalog schema and seed', () => {
    it('provisions the user_tables schema and seeds the 12 builtins against real public tables', async () => {
      const { rows: schema } = await getDb().query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'user_tables') AS present`
      );
      expect(schema[0]?.present).toBe(true);

      const builtins = await TableCatalog.listTables({ origin: 'builtin' });
      expect(builtins.map((row) => [row.id, row.name, row.tableName]).sort()).toEqual(
        [...BUILTINS].map((entry) => [...entry]).sort()
      );
      for (const [, , tableName] of BUILTINS) {
        const { rows } = await getDb().query<{ present: boolean }>(
          'SELECT to_regclass($1) IS NOT NULL AS present',
          [`public.${tableName}`]
        );
        expect({ tableName, present: rows[0]?.present }).toEqual({ tableName, present: true });
      }
    });

    it('maps rows to camelCase and projects wire entries without the physical name', async () => {
      const row = await TableCatalog.findById('table-builtin-credentials');
      expect(row).toEqual({
        id: 'table-builtin-credentials',
        name: 'Credentials',
        tableName: 'user_provider_credentials',
        origin: 'builtin',
        projectId: null,
        sortOrder: 0,
        createdAt: expect.any(String),
        state: 'active',
        stateChangedAt: null,
        heldBy: null,
      });
      if (!row) throw new Error('missing builtin');
      const entry = toTableCatalogEntry(row);
      expect(entry).toEqual({
        id: row.id,
        name: row.name,
        origin: 'builtin',
        projectId: null,
        sortOrder: 0,
        createdAt: row.createdAt,
      });
      expect(Object.keys(entry)).not.toContain('tableName');
      expect(await TableCatalog.findById('table-1111111111111-zzzzzzzzz')).toBeNull();
    });
  });

  describe('TableCatalog model', () => {
    it('registers a custom row and finds it by id, table and name', async () => {
      await getDb().query(`CREATE TABLE user_tables."${PHYSICAL}" (id uuid PRIMARY KEY)`);
      const row = await TableCatalog.registerCustom({
        id: CUSTOM_ID,
        name: PHYSICAL,
        tableName: PHYSICAL,
      });
      expect(row).toMatchObject({ id: CUSTOM_ID, origin: 'custom', tableName: PHYSICAL });

      expect(await TableCatalog.findByTable('custom', PHYSICAL)).toEqual(row);
      expect(await TableCatalog.findByTable('builtin', PHYSICAL)).toBeNull();
      expect(await TableCatalog.findByTable('builtin', 'docs')).toMatchObject({
        id: 'table-builtin-docs',
      });
      expect(await TableCatalog.findByName('TEST_TABLE')).toEqual(row);
    });

    it('lists builtin before custom, then by case-insensitive name, and filters by origin', async () => {
      const all = await TableCatalog.listTables();
      const origins = all.map((row) => row.origin);
      expect(origins.lastIndexOf('builtin')).toBeLessThan(origins.indexOf('custom'));
      const builtinNames = all.filter((row) => row.origin === 'builtin').map((row) => row.name);
      expect(builtinNames).toEqual(
        [...builtinNames].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      );
      expect(await TableCatalog.listTables({ origin: 'custom' })).toEqual([
        expect.objectContaining({ id: CUSTOM_ID }),
      ]);
      expect((await TableCatalog.listTables({ origin: 'builtin' })).length).toBe(BUILTINS.length);
    });

    it('enforces case-insensitive name uniqueness across origins', async () => {
      // A custom `docs` collides with the builtin display name `Docs`.
      expect(
        await pgErrorCode(() =>
          TableCatalog.registerCustom({ id: CUSTOM_ID_B, name: 'docs', tableName: 'docs' })
        )
      ).toBe('23505');
      expect(
        await pgErrorCode(() =>
          TableCatalog.registerCustom({ id: CUSTOM_ID_B, name: PHYSICAL, tableName: PHYSICAL })
        )
      ).toBe('23505');
    });

    it('requires a custom row name to equal its physical table name', async () => {
      expect(
        await pgError(() =>
          TableCatalog.registerCustom({ id: CUSTOM_ID_B, name: 'other', tableName: PHYSICAL_B })
        )
      ).toEqual({ code: '23514', constraint: 'table_catalog_custom_name_is_table' });
      expect(await TableCatalog.findById(CUSTOM_ID_B)).toBeNull();
    });

    it('rejects an unknown origin, a bad physical name and a mismatched id/origin at the database', async () => {
      const insert = (id: string, tableName: string, origin: string) => () =>
        getDb().query(
          `INSERT INTO public.table_catalog (id, name, table_name, origin) VALUES ($1, $2, $3, $4)`,
          [id, tableName, tableName, origin]
        );
      expect(await pgErrorCode(insert(CUSTOM_ID_C, PHYSICAL_C, 'external'))).toBe('23514');
      expect(await pgErrorCode(insert(CUSTOM_ID_C, 'Bad-Name', 'custom'))).toBe('23514');
      expect(await pgErrorCode(insert(CUSTOM_ID_C, 'x'.repeat(64), 'custom'))).toBe('23514');
      expect(await pgErrorCode(insert('table-builtin-extra', PHYSICAL_C, 'custom'))).toBe('23514');
      expect(await pgErrorCode(insert(CUSTOM_ID_C, PHYSICAL_C, 'builtin'))).toBe('23514');
      expect(await TableCatalog.findById(CUSTOM_ID_C)).toBeNull();
    });

    it('refuses reserved ids and invalid targets before touching the database', async () => {
      await expect(
        TableCatalog.registerCustom({
          id: 'table-builtin-docs',
          name: 'Reserved',
          tableName: PHYSICAL_C,
        })
      ).rejects.toThrow(/reserved prefix/);
      await expect(
        TableCatalog.registerCustom({ id: CUSTOM_ID_C, name: 'Bad', tableName: 'x; DROP TABLE' })
      ).rejects.toThrow(/Invalid physical table name/);
      await expect(
        TableCatalog.createCustomPhysicalTable('Bad Name', CUSTOM_ID_C, getDb())
      ).rejects.toThrow(/Invalid physical table name/);
    });

    it('creates every custom table with an indexed, required row-order position column', async () => {
      await TableCatalog.createCustomPhysicalTable(PHYSICAL_C, CUSTOM_ID_C, getDb());
      expect(
        await TableCatalog.physicalColumns({ origin: 'custom', tableName: PHYSICAL_C })
      ).toEqual([
        { name: 'id', dataType: 'uuid', nullable: false },
        { name: 'created_at', dataType: 'timestamp with time zone', nullable: false },
        { name: 'position', dataType: 'double precision', nullable: false },
      ]);
      // Key and index are named after the stable table id, never the table name.
      const { rows } = await getDb().query<{ indexname: string; indexdef: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='user_tables' AND tablename=$1 ORDER BY indexname",
        [PHYSICAL_C]
      );
      expect(rows.map((row) => row.indexname)).toEqual([
        'table_1111111111111_ccccccccc_pkey',
        'table_1111111111111_ccccccccc_position_idx',
      ]);
      expect(rows[1]?.indexdef).toContain('("position", created_at, id)');
      await getDb().query(`DROP TABLE user_tables."${PHYSICAL_C}"`);
    });

    it('renameCustom renames the physical table with its row, only from the expected name', async () => {
      const renamed = await transaction((tx) =>
        TableCatalog.renameCustom(CUSTOM_ID, RENAMED, PHYSICAL, tx)
      );
      expect(renamed).toMatchObject({ id: CUSTOM_ID, name: RENAMED, tableName: RENAMED });
      expect(await physicalExists(RENAMED)).toBe(true);
      expect(await physicalExists(PHYSICAL)).toBe(false);
      expect(
        await transaction((tx) => TableCatalog.renameCustom(CUSTOM_ID, 'other_name', PHYSICAL, tx))
      ).toBeNull();
      await transaction((tx) => TableCatalog.renameCustom(CUSTOM_ID, PHYSICAL, RENAMED, tx));
      expect(await physicalExists(PHYSICAL)).toBe(true);
      expect(await physicalExists(RENAMED)).toBe(false);
    });

    it('setProject locks the row and writes only while it is a live custom table', async () => {
      await Containers.create({ id: PROJECT, name: 'Launch', category: 'project' });
      const link = (id: string, projectId: string | null) =>
        transaction((tx) => TableCatalog.setProject(id, projectId, tx));

      // The row stays locked FOR UPDATE until the caller's transaction ends.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held!: () => void;
      const holding = new Promise<void>((resolve) => (held = resolve));
      const holder = transaction(async (tx) => {
        expect((await TableCatalog.setProject(CUSTOM_ID, PROJECT, tx))?.projectId).toBe(PROJECT);
        held();
        await gate;
      });
      await holding;
      try {
        expect(
          await pgErrorCode(() =>
            getDb().query('SELECT id FROM public.table_catalog WHERE id = $1 FOR UPDATE NOWAIT', [
              CUSTOM_ID,
            ])
          )
        ).toBe('55P03');
      } finally {
        release();
      }
      await holder;
      // The current home again: the unchanged row, without looking at the target.
      expect((await link(CUSTOM_ID, PROJECT))?.projectId).toBe(PROJECT);

      // Archived meanwhile (as a concurrent archive would leave it): no write, null.
      await getDb().query(
        `UPDATE public.table_catalog
            SET state = 'archived', state_changed_at = now(), table_name = '_snaglet_guarded'
          WHERE id = $1`,
        [CUSTOM_ID]
      );
      expect(await link(CUSTOM_ID, null)).toBeNull();
      expect((await TableCatalog.findById(CUSTOM_ID))?.projectId).toBe(PROJECT);
      await getDb().query(
        `UPDATE public.table_catalog
            SET state = 'active', state_changed_at = NULL, table_name = name
          WHERE id = $1`,
        [CUSTOM_ID]
      );
      expect((await link(CUSTOM_ID, null))?.projectId).toBeNull();

      // A built-in or a missing row is null too; the domain words those refusals.
      expect(await link('table-builtin-docs', PROJECT)).toBeNull();
      expect(await link(MISSING_ID, PROJECT)).toBeNull();
      expect((await TableCatalog.findById('table-builtin-docs'))?.projectId).toBeNull();
    });

    it('registerCustom joins the caller transaction and rolls back with it', async () => {
      await expect(
        transaction(async (tx) => {
          await TableCatalog.createCustomPhysicalTable(PHYSICAL_C, CUSTOM_ID_C, tx);
          await TableCatalog.registerCustom(
            { id: CUSTOM_ID_C, name: PHYSICAL_C, tableName: PHYSICAL_C },
            tx
          );
          expect(await TableCatalog.findById(CUSTOM_ID_C, tx)).not.toBeNull();
          throw new RollbackSentinel();
        })
      ).rejects.toBeInstanceOf(RollbackSentinel);
      expect(await TableCatalog.findById(CUSTOM_ID_C)).toBeNull();
      expect(await physicalExists(PHYSICAL_C)).toBe(false);
    });
  });

  describe('table-catalog seed replay', () => {
    it('is healed by ensureBuiltinCatalog when a builtin row goes missing', async () => {
      const db = await getDbClient();
      await db.query(`DELETE FROM public.table_catalog WHERE id = 'table-builtin-files'`);
      expect(await ensureBuiltinCatalog(db)).toBe(true);
      expect(await TableCatalog.findById('table-builtin-files')).toMatchObject({
        name: 'Files',
        tableName: 'files',
      });
    });

    it('is replayable twice: heals builtins, keeps ids stable, never touches custom rows or tables', async () => {
      expect(SEED_REPLAY_FILES).toContain('seeds/table-catalog.sql');
      const db = await getDbClient();

      await db.query(`INSERT INTO user_tables."${PHYSICAL}" (id) VALUES (gen_random_uuid())`);
      const customBefore = await TableCatalog.findById(CUSTOM_ID);
      const builtinBefore = await TableCatalog.listTables({ origin: 'builtin' });
      await db.query(
        `UPDATE public.table_catalog SET name = 'Renamed Docs' WHERE id = 'table-builtin-docs'`
      );
      await db.query(`DELETE FROM public.table_catalog WHERE id = 'table-builtin-models'`);

      await reapplySeedFiles(db, [...SEED_REPLAY_FILES]);
      const afterFirst = await catalogRows();
      await reapplySeedFiles(db, ['seeds/table-catalog.sql']);
      expect(await catalogRows()).toEqual(afterFirst);

      const builtinAfter = await TableCatalog.listTables({ origin: 'builtin' });
      expect(builtinAfter.map((row) => [row.id, row.name, row.tableName])).toEqual(
        builtinBefore.map((row) => [row.id, row.name, row.tableName])
      );
      expect(afterFirst).toHaveLength(BUILTINS.length + 1);
      expect(await TableCatalog.findById(CUSTOM_ID)).toEqual(customBefore);
      expect(await physicalExists(PHYSICAL)).toBe(true);
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_tables."${PHYSICAL}"`
      );
      expect(rows[0]?.n).toBe(1);
    });
  });
});
