import { afterEach, expect, it } from '@jest/globals';
import { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { applyPendingMigrations, pendingMigrationCount } from '@snaglet/db/migrations';
import { BASELINE_MIGRATION } from '@snaglet/db/migration-files';
import { createEmptyTestDatabase, type EmptyTestDatabase } from '../../../support/pgTestCluster';

let target: EmptyTestDatabase | undefined;
let db: PostgresAdapter | undefined;

afterEach(async () => {
  await db?.end();
  target?.drop();
});

it('rolls back non-idempotent DDL when ledger recording fails, then retries cleanly', async () => {
  target = createEmptyTestDatabase('migration_atomic');
  const client = new PostgresAdapter({ connectionString: target.url });
  db = client;
  await pendingMigrationCount(client); // creates the ledger without applying anything

  // Fail after the baseline's DDL has run but before its ledger row lands.
  await client.exec(`
    CREATE FUNCTION public.reject_baseline_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name = '${BASELINE_MIGRATION}' THEN
        RAISE EXCEPTION 'injected ledger failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_baseline_ledger BEFORE INSERT ON public._migrations
      FOR EACH ROW EXECUTE FUNCTION public.reject_baseline_ledger();
  `);
  await expect(applyPendingMigrations(client)).rejects.toThrow('injected ledger failure');
  const failed = await client.query<{ relation: string | null; recorded: boolean }>(
    `SELECT to_regclass('public.calendars')::text AS relation,
       EXISTS (SELECT 1 FROM public._migrations WHERE name = $1) AS recorded`,
    [BASELINE_MIGRATION]
  );
  expect(failed.rows[0]).toEqual({ relation: null, recorded: false });

  await client.exec('DROP TRIGGER reject_baseline_ledger ON public._migrations');
  await client.exec('DROP FUNCTION public.reject_baseline_ledger()');
  await applyPendingMigrations(client);
  const recovered = await client.query<{ relation: string | null; recorded: boolean }>(
    `SELECT to_regclass('public.calendars')::text AS relation,
       EXISTS (SELECT 1 FROM public._migrations WHERE name = $1) AS recorded`,
    [BASELINE_MIGRATION]
  );
  expect(recovered.rows[0]).toEqual({ relation: 'calendars', recorded: true });
  await applyPendingMigrations(client);
}, 60_000);
