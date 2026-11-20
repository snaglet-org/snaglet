/**
 * Pre-migration snapshots: taken only when this boot is about to apply the
 * pending migrations, and pruned to the retention count once the boot's
 * migrations succeeded — without touching user-created snapshots.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRE_UPDATE_SNAPSHOT_RETENTION } from '@snaglet/shared/constants/backups';

jest.mock('@snaglet/db/db', () => ({
  getDb: jest.fn(),
  getDbClient: jest.fn(),
  transaction: jest.fn(),
  getBackupAdapter: jest.fn(),
  resolveDatabaseMode: jest.fn((env: NodeJS.ProcessEnv) =>
    env.SNAGLET_DATABASE_URL ? 'url' : 'managed'
  ),
}));

jest.mock('@snaglet/db/migrations', () => ({
  pendingMigrationCount: jest.fn(),
  reapplySeedFiles: jest.fn(),
  reapplyProviderCatalogSeed: jest.fn(),
  reapplyLocalModelSeeds: jest.fn(),
  SEED_REPLAY_FILES: [],
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@server/services/snagletHome', () => ({
  SNAGLET_BACKUPS_DIR: '/should-never-be-used-by-pre-migration-tests',
}));

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: { load: jest.fn(), syncToDatabase: jest.fn() },
}));

type SnapshotKind = 'manual' | 'pre-reset' | 'pre-migration';

describe('DatabaseBackupService pre-migration snapshots', () => {
  let backupsDir: string;
  let originalBackupsDir: string | undefined;
  let service: typeof import('@server/services/DatabaseBackupService');
  let db: typeof import('@snaglet/db/db');
  let migrations: typeof import('@snaglet/db/migrations');
  let logger: (typeof import('@server/config/logger'))['logger'];
  const dump = jest.fn(async () => Buffer.from('PGDMP test archive'));

  beforeAll(async () => {
    backupsDir = await mkdtemp(join(tmpdir(), 'snaglet-pre-migration-backups-'));
    originalBackupsDir = process.env.SNAGLET_BACKUPS_DIR;
    process.env.SNAGLET_BACKUPS_DIR = backupsDir;
    // The service captures SNAGLET_BACKUPS_DIR when it is evaluated.
    service = await import('@server/services/DatabaseBackupService');
    db = await import('@snaglet/db/db');
    migrations = await import('@snaglet/db/migrations');
    ({ logger } = await import('@server/config/logger'));
  });

  afterAll(async () => {
    if (originalBackupsDir === undefined) delete process.env.SNAGLET_BACKUPS_DIR;
    else process.env.SNAGLET_BACKUPS_DIR = originalBackupsDir;
    await rm(backupsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const name of await readdir(backupsDir)) {
      await rm(join(backupsDir, name), { recursive: true, force: true });
    }
    dump.mockClear();
    const query = jest.fn(async (sql: string) =>
      sql.includes('schema_sentinel')
        ? { rows: [{ schema_sentinel: 'nodes' }] }
        : { rows: [{ database: 'snaglet' }] }
    );
    jest.mocked(db.getDbClient).mockResolvedValue({ query } as never);
    jest.mocked(db.getBackupAdapter).mockResolvedValue({ engine: 'postgres', dump } as never);
    jest.mocked(migrations.pendingMigrationCount).mockResolvedValue(1);
  });

  async function writeSnapshot(id: string, kind: SnapshotKind, createdAt: string): Promise<void> {
    await writeFile(join(backupsDir, `${id}.dump`), Buffer.from(`artifact:${id}`));
    await writeFile(
      join(backupsDir, `${id}.json`),
      JSON.stringify({
        id,
        label: `Test ${kind}`,
        createdAt,
        sizeBytes: 0,
        dbName: 'snaglet',
        kind,
        engine: 'postgres',
        format: 'custom',
        fileName: `${id}.dump`,
        legacy: false,
        restorable: true,
      }),
      'utf8'
    );
  }

  const listIds = async (): Promise<string[]> =>
    (await service.listSnapshots()).map((snapshot) => snapshot.id).sort();

  it('takes no snapshot when pending migrations are left for `pnpm db:migrate`', async () => {
    await expect(
      service.preMigrationBackupIfNeeded({ migrationsWillApply: false })
    ).resolves.toBeNull();
    expect(dump).not.toHaveBeenCalled();
    expect(await readdir(backupsDir)).toEqual([]);
  });

  it('snapshots when the boot is about to apply pending migrations', async () => {
    const manifest = await service.preMigrationBackupIfNeeded({ migrationsWillApply: true });

    expect(manifest).toMatchObject({ kind: 'pre-migration', label: 'Before 1 migration(s)' });
    expect(dump).toHaveBeenCalledTimes(1);
  });

  it('takes no snapshot when nothing is pending, even on an applying boot', async () => {
    jest.mocked(migrations.pendingMigrationCount).mockResolvedValue(0);
    await expect(
      service.preMigrationBackupIfNeeded({ migrationsWillApply: true })
    ).resolves.toBeNull();
    expect(dump).not.toHaveBeenCalled();
  });

  it('never prunes while taking the snapshot, before the migrations have run', async () => {
    for (let day = 1; day <= 6; day += 1) {
      await writeSnapshot(`pre-migration-${day}`, 'pre-migration', `2026-01-0${day}T00:00:00.000Z`);
    }

    await service.preMigrationBackupIfNeeded({ migrationsWillApply: true });

    expect(dump).toHaveBeenCalledTimes(1);
    expect((await listIds()).filter((id) => id.startsWith('pre-migration-'))).toHaveLength(6);
  });

  it('keeps the newest pre-migration snapshots after a boot and never user-created ones', async () => {
    for (let day = 1; day <= 6; day += 1) {
      await writeSnapshot(`pre-migration-${day}`, 'pre-migration', `2026-01-0${day}T00:00:00.000Z`);
    }
    await writeSnapshot('manual-old', 'manual', '2025-01-01T00:00:00.000Z');
    await writeSnapshot('pre-reset-old', 'pre-reset', '2025-01-02T00:00:00.000Z');
    jest.mocked(logger.info).mockClear();

    const result = await service.pruneAutomaticSnapshots();

    expect(PRE_UPDATE_SNAPSHOT_RETENTION).toBe(2);
    expect(await listIds()).toEqual([
      'manual-old',
      'pre-migration-5',
      'pre-migration-6',
      'pre-reset-old',
    ]);
    const removed = ['pre-migration-4', 'pre-migration-3', 'pre-migration-2', 'pre-migration-1'];
    expect(result.removed).toEqual(removed);
    // Each artifact is `artifact:<id>`, 24 bytes for these ids.
    expect(result.bytesFreed).toBe(4 * 'artifact:pre-migration-1'.length);
    expect(await readdir(backupsDir)).not.toContain('pre-migration-1.json');
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = String(jest.mocked(logger.info).mock.calls[0]?.[0]);
    expect(line).toContain('pruned 4 automatic snapshot(s), freed 96 Bytes');
    for (const id of removed) expect(line).toContain(id);

    // Idempotent: nothing left to remove.
    await expect(service.pruneAutomaticSnapshots()).resolves.toEqual({
      removed: [],
      bytesFreed: 0,
    });
  });

  it('keeps the snapshot this boot took and anything newer, even after a clock change', async () => {
    await writeSnapshot('pre-migration-old', 'pre-migration', '2025-06-01T00:00:00.000Z');
    await writeSnapshot('pre-migration-now', 'pre-migration', '2026-01-01T00:00:00.000Z');
    for (const day of [1, 2, 3]) {
      await writeSnapshot(
        `pre-migration-future-${day}`,
        'pre-migration',
        `2030-01-0${day}T00:00:00.000Z`
      );
    }

    const result = await service.pruneAutomaticSnapshots({
      justTaken: { id: 'pre-migration-now', createdAt: '2026-01-01T00:00:00.000Z' },
    });

    expect(result.removed).toEqual(['pre-migration-old']);
    expect(await listIds()).toEqual([
      'pre-migration-future-1',
      'pre-migration-future-2',
      'pre-migration-future-3',
      'pre-migration-now',
    ]);
  });

  it('logs a snapshot it cannot remove, keeps it listed, and prunes the rest', async () => {
    for (let day = 1; day <= 4; day += 1) {
      await writeSnapshot(`pre-migration-${day}`, 'pre-migration', `2026-01-0${day}T00:00:00.000Z`);
    }
    // A directory where the dump should be: unlink fails on it.
    await rm(join(backupsDir, 'pre-migration-1.dump'));
    await mkdir(join(backupsDir, 'pre-migration-1.dump'));
    jest.mocked(logger.warn).mockClear();

    const result = await service.pruneAutomaticSnapshots();

    expect(result.removed).toEqual(['pre-migration-2']);
    expect(await listIds()).toEqual(['pre-migration-1', 'pre-migration-3', 'pre-migration-4']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(jest.mocked(logger.warn).mock.calls[0]?.[0])).toContain(
      'could not prune snapshot pre-migration-1'
    );
  });

  /** Write `manifest` under `file`, as a copied or hand-edited manifest would be. */
  async function writeManifestFile(file: string, manifest: Record<string, unknown>) {
    await writeFile(join(backupsDir, file), JSON.stringify(manifest), 'utf8');
  }

  const preMigrationManifest = (id: string, createdAt: string, fileName = `${id}.dump`) => ({
    id,
    label: 'Crafted',
    createdAt,
    sizeBytes: 0,
    dbName: 'snaglet',
    kind: 'pre-migration',
    engine: 'postgres',
    format: 'custom',
    fileName,
    legacy: false,
    restorable: true,
  });

  it('never prunes a manifest whose id is unsafe or not its own file name', async () => {
    for (let day = 3; day <= 4; day += 1) {
      await writeSnapshot(`pre-migration-${day}`, 'pre-migration', `2026-01-0${day}T00:00:00.000Z`);
    }
    // Old enough to fall outside retention if it were trusted.
    await writeFile(join(backupsDir, 'crafted.dump'), 'not a snapshot of this id');
    await writeManifestFile(
      'crafted.json',
      preMigrationManifest('../../outside', '2025-01-01T00:00:00.000Z', 'crafted.dump')
    );
    await writeManifestFile(
      'renamed.json',
      preMigrationManifest('snaglet-real', '2025-01-02T00:00:00.000Z', 'crafted.dump')
    );
    await writeFile(join(backupsDir, 'manual-dump.dump'), 'a manual snapshot');
    await writeManifestFile(
      'snaglet-borrower.json',
      preMigrationManifest('snaglet-borrower', '2025-01-03T00:00:00.000Z', 'manual-dump.dump')
    );
    jest.mocked(logger.warn).mockClear();

    const result = await service.pruneAutomaticSnapshots();

    expect(result.removed).toEqual([]);
    expect(await readdir(backupsDir)).toEqual(
      expect.arrayContaining([
        'crafted.dump',
        'crafted.json',
        'renamed.json',
        'manual-dump.dump',
        'snaglet-borrower.json',
      ])
    );
    const warnings = jest.mocked(logger.warn).mock.calls.map((call) => String(call[0]));
    for (const file of ['crafted.json', 'renamed.json', 'snaglet-borrower.json']) {
      expect(warnings).toContainEqual(expect.stringContaining(`not pruning ${file}`));
    }
  });

  it('counts a copied manifest once, so it never pushes out the real second-newest', async () => {
    for (let day = 1; day <= 3; day += 1) {
      await writeSnapshot(`pre-migration-${day}`, 'pre-migration', `2026-01-0${day}T00:00:00.000Z`);
    }
    await writeManifestFile(
      'pre-migration-3 copy.json',
      preMigrationManifest('pre-migration-3', '2026-01-03T00:00:00.000Z')
    );

    const result = await service.pruneAutomaticSnapshots();

    expect(result.removed).toEqual(['pre-migration-1']);
    const remaining = await readdir(backupsDir);
    expect(remaining).toEqual(
      expect.arrayContaining(['pre-migration-2.dump', 'pre-migration-3.dump'])
    );
    expect(remaining).not.toContain('pre-migration-1.dump');
  });

  it('counts the packaged pre-update checkpoints under SNAGLET_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'snaglet-pre-update-checkpoints-'));
    const originalHome = process.env.SNAGLET_HOME;
    process.env.SNAGLET_HOME = home;
    try {
      const checkpoint = join(
        home,
        'backups',
        'pre-migration',
        '2026-01-01T00-00-00-000Z-0000000a'
      );
      await mkdir(checkpoint, { recursive: true });
      await writeFile(join(checkpoint, 'database.dump'), Buffer.alloc(40));
      await writeFile(join(home, 'backups', 'pre-migration', 'notes.txt'), 'not a checkpoint');

      await expect(service.getPreUpdateCheckpointSummary()).resolves.toEqual({
        count: 1,
        totalBytes: 40,
      });
    } finally {
      if (originalHome === undefined) delete process.env.SNAGLET_HOME;
      else process.env.SNAGLET_HOME = originalHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('only a Snaglet-owned managed cluster applies migrations at boot', () => {
    expect(service.bootAppliesPendingMigrations({ SNAGLET_PG_OWNED: '1' })).toBe(true);
    expect(service.bootAppliesPendingMigrations({})).toBe(false);
    expect(
      service.bootAppliesPendingMigrations({
        SNAGLET_PG_OWNED: '1',
        SNAGLET_DATABASE_URL: 'postgresql://user@127.0.0.1:1/snaglet_test',
      })
    ).toBe(false);
  });
});
