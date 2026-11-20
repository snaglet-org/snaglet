/**
 * A fresh install's database for a schema test: an EMPTY database in the
 * run's shared cluster, provisioned through the real boot path
 * (`bootstrapIfFresh` applies every bundled migration). Unlike the per-file
 * `snaglet_template` clone it is private to one test, so a test may delete or
 * break rows freely. Call `close()` in a `finally` block.
 */
import { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { bootstrapIfFresh } from '@snaglet/db/migrations';
import { createEmptyTestDatabase } from './pgTestCluster';

export interface FreshDatabase {
  db: PostgresAdapter;
  /** Ends the pool and drops the database. */
  close(): Promise<void>;
}

export async function createFreshDatabase(label: string): Promise<FreshDatabase> {
  const target = createEmptyTestDatabase(label);
  const db = new PostgresAdapter({ connectionString: target.url });
  const close = async (): Promise<void> => {
    try {
      await db.end();
    } finally {
      target.drop();
    }
  };
  try {
    await bootstrapIfFresh(db);
  } catch (error: unknown) {
    await close();
    throw error;
  }
  return { db, close };
}
