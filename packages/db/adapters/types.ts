/**
 * Database Abstraction Layer.
 *
 * `DbClient` is the engine-agnostic surface all application code depends on.
 *
 * The interface is intentionally minimal — parameterized queries and
 * transactional blocks — mirroring exactly the subset of `pg` that Snaglet uses.
 */

/**
 * Result shape returned by `query`. Matches `pg.QueryResult<T>` for the
 * fields Snaglet actually reads. Other pg fields (command, oid, fields, etc.)
 * are intentionally omitted — if a call site needs them, surface them here
 * deliberately rather than leaking the underlying driver.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default mirrors pg's own QueryResult<T = any>; callers opt in with concrete types
export interface DbQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

/**
 * Engine-agnostic database client. The active PostgresAdapter wraps a
 * node-postgres `pg.Pool` for both managed and external modes.
 */
export interface DbClient {
  /**
   * Run a parameterized SQL statement.
   *
   * @param sql      Parameterized SQL text. Use `$1`, `$2`, ... placeholders.
   * @param params   Positional parameter values.
   * @returns        Rows and rowCount. `rowCount` may be null for statements
   *                 that don't produce one (per pg semantics).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default; callers pass concrete T for typed results
  query<T = any>(sql: string, params?: ReadonlyArray<unknown>): Promise<DbQueryResult<T>>;

  /**
   * Execute a SQL script that may contain multiple statements and DDL.
   *
   * Used by migrations and schema bootstrap. PostgreSQL executes these through
   * the simple-query protocol. Parameter binding is not supported
   * here; use {@link DbClient.query} for parameterized statements.
   *
   * Throws if the script fails to parse or any statement errors.
   */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a transaction.
   *
   * The callback receives a `DbClient` scoped to the transaction — all
   * queries issued through it run on the same connection inside the BEGIN
   * block. Returning normally commits; throwing rolls back.
   *
   * Nested transactions are not supported by this interface — if you need
   * them, build savepoints on top of `query` explicitly.
   */
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;

  /**
   * Close the underlying connection pool.
   *
   * Idempotent — calling more than once is safe and a no-op after the first.
   */
  end(): Promise<void>;
}
