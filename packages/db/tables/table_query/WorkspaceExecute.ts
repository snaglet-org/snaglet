/**
 * WorkspaceExecute — the sandbox `database_execute` and `create_view` run
 * agent SQL in.
 *
 * Unlike {@link TableQuery}/{@link WorkspaceQuery} (one read-only SELECT), this
 * runs arbitrary agent SQL — DDL and DML — but on the `snaglet_workspace_writer`
 * pool, a non-superuser login role that can write the custom `user_tables`
 * schema and reach nothing in `public` (Snaglet's system tables). The role, not
 * this module, is the boundary; see `runtime/postgres/workspaceWriter.ts`.
 *
 * Each call runs inside one transaction on a single checked-out connection:
 * BEGIN, set the user's time zone, run the statement(s), COMMIT — or ROLLBACK
 * on error. `statement_timeout` (a role default and a pool ceiling) bounds a
 * runaway. The connection's search_path is `user_tables`, so an unqualified
 * CREATE lands in the custom schema.
 */
import { userTimeZone } from '@snaglet/shared/utils';
import type { PostgresAdapter } from '../../adapters/postgres';
import { getWorkspaceWriterPool } from '../../db';

export const WORKSPACE_EXECUTE_UNAVAILABLE_MESSAGE =
  'This tool is unavailable on this database (no snaglet_workspace_writer connection). ' +
  'Under SNAGLET_DATABASE_URL set SNAGLET_WORKSPACE_WRITER_URL to a writer role that can reach only ' +
  'the user_tables schema; it is never run as the app database user.';

/** Raised when no writer connection is configured, so the tool can refuse cleanly. */
export class WorkspaceExecuteUnavailableError extends Error {
  constructor(message: string = WORKSPACE_EXECUTE_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'WorkspaceExecuteUnavailableError';
  }
}

export interface WorkspaceExecuteResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** Injection seam for tests; production resolves the pool from `db.ts`. */
export interface WorkspaceExecuteDependencies {
  writer?: PostgresAdapter | null;
}

export class WorkspaceExecuteEngine {
  /**
   * Run agent SQL as the workspace writer, inside one transaction. Returns the
   * last statement's rows (and affected-row count). Throws
   * {@link WorkspaceExecuteUnavailableError} when no writer connection exists,
   * and the driver's error (with its SQLSTATE `code`) for anything PostgreSQL
   * refuses — a write to a system table, a view over `agents`, `COPY … TO
   * PROGRAM`, and so on all fail there.
   */
  async execute(
    sql: string,
    dependencies: WorkspaceExecuteDependencies = {}
  ): Promise<WorkspaceExecuteResult> {
    if (typeof sql !== 'string' || !sql.trim()) {
      throw new Error('sql must be a non-empty string.');
    }
    const writer =
      dependencies.writer === undefined ? await getWorkspaceWriterPool() : dependencies.writer;
    if (!writer) throw new WorkspaceExecuteUnavailableError();

    return writer.withConnection(async (connection) => {
      let inTransaction = false;
      try {
        await connection.query('BEGIN');
        inTransaction = true;
        // Match the readers: casts such as `due::date` use the user's zone.
        await connection.query("SELECT set_config('TimeZone', $1, true)", [userTimeZone()]);
        const result = await connection.query<Record<string, unknown>>(sql);
        await connection.query('COMMIT');
        inTransaction = false;
        return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
      } catch (error: unknown) {
        if (inTransaction) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError: unknown) {
            connection.discard(
              rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError))
            );
          }
        }
        throw error;
      }
    });
  }
}

export const WorkspaceExecute = new WorkspaceExecuteEngine();
