/**
 * Production boot recovery against the real external-mode `getDbClient()`
 * path. The per-file PostgreSQL clone is renamed to the exact parked-database
 * shape an interrupted restore leaves, then normal boot must recover it before
 * publishing an adapter instead of creating or accepting an empty database.
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';
import { closeDatabase, getDbClient } from '@snaglet/db/db';
import {
  databaseNameFromConfig,
  poolConfigForDatabase,
  quoteDatabaseName,
} from '@snaglet/db/runtime/postgres/restore-swap';

afterAll(async () => {
  await closeDatabase();
});

describe('getDbClient() production boot recovers an interrupted PostgreSQL restore', () => {
  it('renames the sole parked original back before opening the live database', async () => {
    const connectionString = process.env.SNAGLET_DATABASE_URL;
    expect(connectionString).toBeTruthy();
    const connection = { connectionString: connectionString! };
    const liveDatabase = databaseNameFromConfig(connection);
    const parkedDatabase = `${liveDatabase}_parked_boot`;
    expect(Buffer.byteLength(parkedDatabase)).toBeLessThanOrEqual(63);

    const original = await getDbClient();
    await original.exec(
      'CREATE TABLE public.snaglet_boot_recovery_probe (id text PRIMARY KEY, value text NOT NULL)'
    );
    await original.query(
      `INSERT INTO public.snaglet_boot_recovery_probe (id, value)
       VALUES ('marker', 'parked-original-survived')`
    );
    await closeDatabase();

    const admin = new Pool(poolConfigForDatabase(connection, 'postgres'));
    try {
      await admin.query(
        `ALTER DATABASE ${quoteDatabaseName(liveDatabase)}
         RENAME TO ${quoteDatabaseName(parkedDatabase)}`
      );
      const before = await admin.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname',
        [[liveDatabase, parkedDatabase]]
      );
      expect(before.rows).toEqual([{ datname: parkedDatabase }]);
    } finally {
      await admin.end();
    }

    const recovered = await getDbClient({ allowReopenAfterClose: true });
    const marker = await recovered.query<{ value: string }>(
      `SELECT value FROM public.snaglet_boot_recovery_probe WHERE id = 'marker'`
    );
    expect(marker.rows).toEqual([{ value: 'parked-original-survived' }]);

    const verification = new Pool(poolConfigForDatabase(connection, 'postgres'));
    try {
      const after = await verification.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname',
        [[liveDatabase, parkedDatabase]]
      );
      expect(after.rows).toEqual([{ datname: liveDatabase }]);
    } finally {
      await verification.end();
    }
  });
});
