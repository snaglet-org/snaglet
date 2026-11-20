/**
 * High-level PostgreSQL migration backup/restore recovery through the real
 * DatabaseBackupService. The file-level harness clone makes every destructive
 * rename swap private to this suite while still exercising pg_dump,
 * validate-before-swap restore, the stable DB facade, and migration-ledger
 * point-in-time recovery.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '@snaglet/db';
import { getDbClient } from '@snaglet/db/db';
import { pendingMigrationCount } from '@snaglet/db/migrations';

let backupsDir: string;
let DatabaseBackupService: typeof import('@server/services/DatabaseBackupService');

beforeAll(async () => {
  backupsDir = mkdtempSync(join(tmpdir(), 'snaglet-pg-migration-restore-backups-'));
  process.env.SNAGLET_BACKUPS_DIR = backupsDir;
  DatabaseBackupService = await import('@server/services/DatabaseBackupService');
});

afterAll(() => {
  rmSync(backupsDir, { recursive: true, force: true });
  delete process.env.SNAGLET_BACKUPS_DIR;
});

async function waitForJobIdle(): Promise<ReturnType<typeof DatabaseBackupService.getDbJobStatus>> {
  for (;;) {
    const status = DatabaseBackupService.getDbJobStatus();
    if (!status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('DatabaseBackupService migration-failure recovery on PostgreSQL', () => {
  it('restores rows, schema, and migration ledger after a partial migration batch', async () => {
    const db = await getDbClient();
    const pool = getDb();

    await db.exec(
      'CREATE TABLE public.snaglet_migration_probe (id text PRIMARY KEY, value text NOT NULL)'
    );
    await pool.query(
      `INSERT INTO public.snaglet_migration_probe (id, value) VALUES
         ('row-1', 'alpha'), ('row-2', 'bravo'), ('row-3', 'charlie')`
    );

    // Borrow one real ledger row so the production pre-migration hook has a
    // genuine pending migration to protect, then restore it after the dump.
    // The ledger holds a single real entry, so borrowing it would leave the
    // snapshot's ledger empty, and restore validation refuses a database with
    // no ledger entries. A synthetic row parked alongside keeps the snapshot
    // valid while a genuine migration is still pending; it is removed in the
    // cleanup below.
    const SYNTHETIC_LEDGER_ROW = 'zzzz_migration_restore_probe.sql';
    await pool.query('INSERT INTO public._migrations (name) VALUES ($1)', [SYNTHETIC_LEDGER_ROW]);
    const migration = await pool.query<{ name: string }>(
      'SELECT name FROM public._migrations WHERE name <> $1 ORDER BY name LIMIT 1',
      [SYNTHETIC_LEDGER_ROW]
    );
    const borrowedName = migration.rows[0]!.name;
    await pool.query('DELETE FROM public._migrations WHERE name = $1', [borrowedName]);
    const pendingAtSnapshot = await pendingMigrationCount(db);
    expect(pendingAtSnapshot).toBeGreaterThan(0);

    // A boot that leaves migrations pending (source checkout, external DB)
    // takes no snapshot; one about to apply them does.
    await expect(
      DatabaseBackupService.preMigrationBackupIfNeeded({ migrationsWillApply: false })
    ).resolves.toBeNull();
    const snapshot = await DatabaseBackupService.preMigrationBackupIfNeeded({
      migrationsWillApply: true,
    });
    expect(snapshot).toMatchObject({ kind: 'pre-migration', engine: 'postgres' });
    await pool.query(
      'INSERT INTO public._migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [borrowedName]
    );

    // Migration N commits. Migration N+1 fails and rolls back only its own
    // statement batch, leaving a realistic partially-upgraded database.
    await db.exec(`
      DELETE FROM public.snaglet_migration_probe WHERE id = 'row-2';
      ALTER TABLE public.snaglet_migration_probe ADD COLUMN migrated_flag boolean DEFAULT true;
    `);
    await expect(
      db.exec(`
        UPDATE public.snaglet_migration_probe SET value = 'corrupted' WHERE id = 'row-1';
        ALTER TABLE public.snaglet_migration_probe ADD COLUMN migrated_flag boolean;
      `)
    ).rejects.toThrow(/migrated_flag.*already exists/i);

    const midBatch = await pool.query<{ id: string; value: string }>(
      'SELECT id, value FROM public.snaglet_migration_probe ORDER BY id'
    );
    expect(midBatch.rows).toEqual([
      { id: 'row-1', value: 'alpha' },
      { id: 'row-3', value: 'charlie' },
    ]);

    const restoreStarted = DatabaseBackupService.startRestore(snapshot!.id);
    expect(restoreStarted).toMatchObject({ running: true, kind: 'restore' });
    const restored = await waitForJobIdle();
    expect(restored.error).toBeNull();
    expect(restored.requiresRestart).toBe(true);

    const afterRows = await getDb().query<{ id: string; value: string }>(
      'SELECT id, value FROM public.snaglet_migration_probe ORDER BY id'
    );
    expect(afterRows.rows).toEqual([
      { id: 'row-1', value: 'alpha' },
      { id: 'row-2', value: 'bravo' },
      { id: 'row-3', value: 'charlie' },
    ]);
    await expect(
      getDb().query('SELECT migrated_flag FROM public.snaglet_migration_probe')
    ).rejects.toThrow(/migrated_flag.*does not exist/i);

    expect(await pendingMigrationCount(await getDbClient())).toBe(pendingAtSnapshot);
    const ledger = await getDb().query('SELECT name FROM public._migrations WHERE name = $1', [
      borrowedName,
    ]);
    expect(ledger.rows).toHaveLength(0);
    await getDb().query(
      'INSERT INTO public._migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [borrowedName]
    );
    // The restored database carries the parked synthetic row — remove it so
    // the ledger is back to exactly the real entries.
    await getDb().query('DELETE FROM public._migrations WHERE name = $1', [SYNTHETIC_LEDGER_ROW]);
  }, 90_000);

  it('leaves the live database untouched when the snapshot record is missing', async () => {
    const started = DatabaseBackupService.startRestore('does-not-exist-nobody-made-this');
    expect(started.running).toBe(true);

    const finished = await waitForJobIdle();
    expect(finished.error).toMatch(/Snapshot not found/i);
    expect(finished.requiresRestart).toBe(false);
    await expect(getDb().query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('rejects a corrupt pg_dump artifact before replacing the live database', async () => {
    const db = await getDbClient();
    await db.exec(
      'CREATE TABLE public.snaglet_corrupt_restore_probe (id text PRIMARY KEY, value text NOT NULL)'
    );
    await db.query(
      `INSERT INTO public.snaglet_corrupt_restore_probe (id, value)
       VALUES ('marker', 'live-database-still-here')`
    );

    const snapshotStarted = DatabaseBackupService.startSnapshot('corrupt-restore-probe');
    expect(snapshotStarted.running).toBe(true);
    const snapshot = await waitForJobIdle();
    expect(snapshot.error).toBeNull();
    const corruptId = snapshot.lastSnapshotId!;
    writeFileSync(join(backupsDir, `${corruptId}.dump`), Buffer.from('not a pg_dump archive'));

    const restoreStarted = DatabaseBackupService.startRestore(corruptId);
    expect(restoreStarted.running).toBe(true);
    const restore = await waitForJobIdle();
    expect(restore.error).toBeTruthy();
    expect(restore.requiresRestart).toBe(false);

    await expect(getDb().query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    const marker = await getDb().query<{ value: string }>(
      `SELECT value FROM public.snaglet_corrupt_restore_probe WHERE id = 'marker'`
    );
    expect(marker.rows).toEqual([{ value: 'live-database-still-here' }]);
  }, 90_000);
});
