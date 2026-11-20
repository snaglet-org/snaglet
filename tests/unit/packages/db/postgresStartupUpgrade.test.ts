import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { safeJsonParse } from '@snaglet/shared/utils';
import type { BackupAdapter, DbClient, DbQueryResult } from '@snaglet/db/adapters';
import { upgradeManagedDatabase } from '@snaglet/db/runtime/postgres/startup-upgrade';
import { PRE_UPDATE_SNAPSHOT_RETENTION } from '@snaglet/shared/constants/backups';

// The bundled forward chain (0001_init + every later numbered file), read the
// same way the runner discovers it. Enumerated instead of hardcoding
// `0001_init.sql` so adding a migration does not silently turn these into
// chain-length assertions (jest runs from the repo root).
const BUNDLED = readdirSync(path.join(process.cwd(), 'packages', 'db', 'migrations'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const applyAllBundled = (target: { applied: Set<string> }) =>
  BUNDLED.forEach((name) => target.applied.add(name));

class MigrationDatabase implements DbClient {
  readonly applied = new Set<string>();
  readonly operations: string[] = [];
  locked = false;
  failMigration = false;

  async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<DbQueryResult<T>> {
    if (sql.startsWith('SELECT name FROM')) {
      return {
        rows: [...this.applied].map((name) => ({ name })) as T[],
        rowCount: this.applied.size,
      };
    }
    if (sql.startsWith('INSERT INTO public._migrations')) this.applied.add(String(params?.[0]));
    return { rows: [], rowCount: 0 };
  }
  async exec(): Promise<void> {
    this.operations.push('migration');
    if (this.failMigration) throw new Error('simulated migration failure');
  }
  async transaction<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async end(): Promise<void> {}
  async withAdvisoryLock<T>(_key: string, fn: (db: DbClient) => Promise<T>): Promise<T> {
    this.locked = true;
    try {
      return await fn(this);
    } finally {
      this.locked = false;
    }
  }
}

describe('packaged PostgreSQL startup upgrades', () => {
  let home: string;
  let dataDir: string;
  let db: MigrationDatabase;
  const artifact = Buffer.from('PGDMP-test-fixture');

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'snaglet-upgrade-unit-'));
    dataDir = path.join(home, 'postgres');
    await mkdir(dataDir);
    db = new MigrationDatabase();
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function backup(dump: () => Promise<Buffer> = async () => artifact): BackupAdapter {
    return {
      engine: 'postgres',
      dump: async () => {
        expect(db.locked).toBe(true);
        db.operations.push('backup');
        return dump();
      },
      restore: async () => {
        throw new Error('Startup must not silently restore');
      },
    };
  }

  it('persists a checksum-verified backup under the migration lock before applying schema', async () => {
    await upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() });
    expect(db.operations).toEqual(['backup', ...BUNDLED.map(() => 'migration')]);
    const base = path.join(home, 'backups', 'pre-migration');
    const entries = await readdir(base);
    expect(entries).toHaveLength(1);
    const checkpoint = path.join(base, entries[0]);
    expect(await readFile(path.join(checkpoint, 'database.dump'))).toEqual(artifact);
    const manifest = safeJsonParse<{ sha256?: string; pendingMigrations?: string[] }>(
      await readFile(path.join(checkpoint, 'manifest.json'), 'utf8'),
      {}
    );
    expect(manifest.sha256).toBe(createHash('sha256').update(artifact).digest('hex'));
    expect(manifest.pendingMigrations).toEqual(BUNDLED);
    expect(await readFile(path.join(dataDir, 'snaglet-meta.json'), 'utf8')).toContain(
      `"migrationCount": ${BUNDLED.length}`
    );
  });

  it('does not migrate or stamp when a backup fails', async () => {
    await expect(
      upgradeManagedDatabase(db, {
        snagletHome: home,
        dataDir,
        backup: backup(async () => {
          throw new Error('disk full');
        }),
      })
    ).rejects.toThrow(/Schema migration did not start without a verified backup/);
    expect(db.operations).toEqual(['backup']);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('preserves the backup and reports its exact path when a migration fails', async () => {
    db.failMigration = true;
    await expect(
      upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() })
    ).rejects.toThrow(/pre-upgrade backup is preserved at .*database.dump/);
    expect(db.operations).toEqual(['backup', 'migration']);
    expect(await readdir(dataDir)).toEqual([]);
    expect(await readdir(path.join(home, 'backups', 'pre-migration'))).toHaveLength(1);
  });

  it('rejects an unknown newer migration even when every bundled migration is applied', async () => {
    applyAllBundled(db);
    db.applied.add('9999_future.sql');
    await expect(
      upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() })
    ).rejects.toThrow(/refusing schema downgrade/);
    expect(db.operations).toEqual([]);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('keeps only the newest checkpoints and touches nothing it did not write', async () => {
    const base = path.join(home, 'backups', 'pre-migration');
    const outside = path.join(home, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'outside data');
    const older = [
      '2020-01-01T00-00-00-000Z-00000001',
      '2020-01-02T00-00-00-000Z-00000002',
      '2020-01-03T00-00-00-000Z-00000003',
      '2020-01-04T00-00-00-000Z-00000004',
    ];
    for (const name of older) {
      await mkdir(path.join(base, name), { recursive: true });
      await writeFile(path.join(base, name, 'database.dump'), 'PGDMP-old');
    }
    // A staging folder a crashed boot left two hours ago.
    const crashed = path.join(base, '.preparing-2020-01-05T00-00-00-000Z-00000005');
    await mkdir(crashed);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(crashed, twoHoursAgo, twoHoursAgo);
    await mkdir(path.join(base, 'manual copy'));
    await writeFile(
      path.join(base, '2019-12-31T00-00-00-000Z-0000000f'),
      'a file, not a checkpoint'
    );
    await symlink(
      outside,
      path.join(base, '2019-12-30T00-00-00-000Z-0000000e'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    await upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() });

    const remaining = (await readdir(base)).sort();
    const fixtures = new Set([
      ...older,
      '2019-12-30T00-00-00-000Z-0000000e',
      '2019-12-31T00-00-00-000Z-0000000f',
      'manual copy',
    ]);
    const created = remaining.filter((name) => !fixtures.has(name));
    expect(created).toHaveLength(1);
    expect(await readFile(path.join(base, created[0], 'database.dump'))).toEqual(artifact);
    expect(remaining).toEqual(
      [
        '2019-12-30T00-00-00-000Z-0000000e',
        '2019-12-31T00-00-00-000Z-0000000f',
        ...older.slice(-(PRE_UPDATE_SNAPSHOT_RETENTION - 1)),
        created[0],
        'manual copy',
      ].sort()
    );
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside data');
  });

  it('prunes only after the migrations succeed, never on a failed upgrade', async () => {
    const base = path.join(home, 'backups', 'pre-migration');
    const older = [
      '2020-01-01T00-00-00-000Z-00000001',
      '2020-01-02T00-00-00-000Z-00000002',
      '2020-01-03T00-00-00-000Z-00000003',
    ];
    for (const name of older) await mkdir(path.join(base, name), { recursive: true });
    // While the migrations run, every older checkpoint is still on disk.
    const seenDuringMigration: number[] = [];
    const exec = db.exec.bind(db);
    db.exec = async () => {
      seenDuringMigration.push((await readdir(base)).length);
      return exec();
    };

    db.failMigration = true;
    await expect(
      upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() })
    ).rejects.toThrow(/pre-upgrade backup is preserved/);
    expect(seenDuringMigration).toEqual([older.length + 1]);
    expect(await readdir(base)).toHaveLength(older.length + 1);

    db.failMigration = false;
    await upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() });
    expect(seenDuringMigration[1]).toBe(older.length + 2);
    const remaining = await readdir(base);
    expect(remaining).toHaveLength(PRE_UPDATE_SNAPSHOT_RETENTION);
    expect(remaining.some((name) => older.includes(name))).toBe(false);
  });

  it('stamps and prunes while still holding the migration lock', async () => {
    const base = path.join(home, 'backups', 'pre-migration');
    for (const name of ['2020-01-01T00-00-00-000Z-00000001', '2020-01-02T00-00-00-000Z-00000002'])
      await mkdir(path.join(base, name), { recursive: true });
    const lockedWhilePruning: boolean[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (String(line).includes('old pre-migration checkpoint(s)')) {
        lockedWhilePruning.push(db.locked);
      }
    });
    try {
      await upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() });
    } finally {
      log.mockRestore();
    }

    expect(lockedWhilePruning).toEqual([true]);
    expect(db.locked).toBe(false);
    expect(await readdir(base)).toHaveLength(PRE_UPDATE_SNAPSHOT_RETENTION);
  });

  it('drains a checkpoint backlog on a successful boot with nothing to apply', async () => {
    const base = path.join(home, 'backups', 'pre-migration');
    const older = [
      '2020-01-01T00-00-00-000Z-00000001',
      '2020-01-02T00-00-00-000Z-00000002',
      '2020-01-03T00-00-00-000Z-00000003',
    ];
    for (const name of older) await mkdir(path.join(base, name), { recursive: true });
    applyAllBundled(db);

    await upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() });

    expect(db.operations).toEqual([]);
    expect((await readdir(base)).sort()).toEqual(older.slice(-PRE_UPDATE_SNAPSHOT_RETENTION));
  });

  it('does not create redundant backups when the schema is current', async () => {
    applyAllBundled(db);
    await upgradeManagedDatabase(db, { snagletHome: home, dataDir, backup: backup() });
    expect(db.operations).toEqual([]);
    expect(await readdir(home)).toEqual(['postgres']);
  });
});
