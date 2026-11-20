/**
 * Convenience DB exports used by the workspace_* tool suite.
 *
 * `db` is the engine-agnostic query facade (same object `getDb()` returns):
 * it routes through the PostgresAdapter in managed-local or external-URL mode.
 * Models and tools never receive the underlying pg.Pool.
 *
 * Usage:
 *   const result = await db.query<T>(sql, params);
 *   result.rows: T[]
 *   result.rowCount: number | null
 */

import { getDb, type DbQueryable } from './db';

export const db: DbQueryable = getDb();

export async function getDB(): Promise<DbQueryable> {
  return getDb();
}
