/**
 * TableQuery — the sandbox that runs agent-written SELECTs over custom
 * Database tables.
 *
 * The boundary is the session user: every statement runs on a separate pool
 * whose login role is `snaglet_tables_reader` (see `provisionTablesReaderRole`), a
 * non-superuser that is a member of nothing, so `set_config('role', …)`,
 * `SET SESSION AUTHORIZATION`, late-bound plpgsql and superuser-only
 * functions all fail with 42501 inside PostgreSQL itself. Everything here is
 * defense in depth on top of that:
 *
 * - a pre-check that admits only SELECT statements (a stacked `select 1;
 *   select 2` is left for the server, whose extended protocol refuses it);
 * - one parameterized wrapper statement, so node-postgres uses Parse/Bind
 *   and an inner `;` is a syntax error rather than a second command;
 * - the SQL-side cell cut (`…[+N chars]`) and `LIMIT limit+1`, so the payload
 *   is bounded before it leaves the server and a cap is detectable;
 * - ROLLBACK plus `pg_advisory_unlock_all()` on the same connection before it
 *   returns to the pool, so a session-level advisory lock cannot outlive the
 *   call;
 * - server (`statement_timeout`) and client (`query_timeout`) ceilings; a
 *   query that outlives the client ceiling is canceled from the app pool.
 */

import { getErrorMessage, userTimeZone } from '@snaglet/shared/utils';
import type { DbClient } from '../../adapters/types';
import type { PostgresAdapter } from '../../adapters/postgres';
import { getDbClient, getTablesReaderClient } from '../../db';
import { assertNoImmutableTables } from '../../sql-utils';

export const TABLE_QUERY_DEFAULT_LIMIT = 50;
export const TABLE_QUERY_MAX_LIMIT = 200;
export const TABLE_QUERY_DEFAULT_MAX_CELL = 200;
export const TABLE_QUERY_MIN_MAX_CELL = 40;
export const TABLE_QUERY_MAX_MAX_CELL = 4_000;

/**
 * Matches the cut marker a truncated cell ends with. Writers refuse values
 * carrying it so a cut cell is never written back over the full one.
 */
export const TABLE_QUERY_CUT_MARKER_PATTERN = /…\[\+\d+ chars\]/;

export type TableQueryErrorCode = 'not_a_select' | 'immutable_table' | 'invalid_argument';

/** A request refused before it reached PostgreSQL. */
export class TableQueryError extends Error {
  constructor(
    readonly code: TableQueryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TableQueryError';
  }
}

export interface TableQueryOptions {
  /** Rows returned at most (1–200, default 50). */
  limit?: number;
  /** Text cells longer than this are cut and marked (40–4000, default 200). */
  maxCell?: number;
}

/** A cell's JSON type in `row_to_json` (a SQL NULL is `null`). */
export type TableQueryCellType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export interface TableQueryRows {
  ok: true;
  /** Column names in SELECT order; empty when the query produced no rows. */
  columns: string[];
  /** Cell text as PostgreSQL renders it (json text); null stays null. */
  rows: (string | null)[][];
  /**
   * Each cell's JSON type, parallel to `rows`, so a caller can turn the text
   * back into typed values (a numeric is `number`, a boolean `boolean`, an
   * array column `array`). The text in `rows` does not depend on it.
   */
  types?: TableQueryCellType[][];
  /** True when more than `limit` rows matched; only `limit` are returned. */
  capped: boolean;
}

export interface TableQueryRefusal {
  ok: false;
  code: 'unavailable';
  message: string;
}

export type TableQueryResult = TableQueryRows | TableQueryRefusal;

/** Injection seam for tests; production resolves both pools from `db.ts`. */
export interface TableQueryDependencies {
  reader?: PostgresAdapter | null;
  app?: DbClient;
}

export const TABLE_QUERY_UNAVAILABLE_MESSAGE =
  'SQL mode is unavailable on this database (no snaglet_tables_reader connection); ' +
  'use table {op: "read", table} or database_query.';

/**
 * Which reader pool an engine runs on and the bounds it accepts. The sandbox
 * mechanics (SELECT-only pre-check, one parameterized wrapper, READ ONLY
 * transaction, SQL-side cut, cancellation, advisory-lock release) are shared.
 */
export interface ReaderQueryProfile {
  /** The reader pool; null refuses the query with {@link unavailableMessage}. */
  resolveReader(): Promise<PostgresAdapter | null>;
  unavailableMessage: string;
  limit: { fallback: number; max: number };
  maxCell: { fallback: number; min: number; max: number };
}

const TABLES_READER_PROFILE: ReaderQueryProfile = {
  resolveReader: getTablesReaderClient,
  unavailableMessage: TABLE_QUERY_UNAVAILABLE_MESSAGE,
  limit: { fallback: TABLE_QUERY_DEFAULT_LIMIT, max: TABLE_QUERY_MAX_LIMIT },
  maxCell: {
    fallback: TABLE_QUERY_DEFAULT_MAX_CELL,
    min: TABLE_QUERY_MIN_MAX_CELL,
    max: TABLE_QUERY_MAX_MAX_CELL,
  },
};

// statement pre-check
// A minimal port of the server's toolPermission classifier (which lives in
// apps/server and cannot be imported from here): a literal-, quoted-identifier-,
// dollar-quote- and comment-aware split on top-level `;`, then the first
// keyword of each statement, unwrapping CTEs.

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  let buf = '';
  let i = 0;
  const flush = (): void => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) out.push(trimmed);
    buf = '';
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl;
      buf += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      buf += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      buf += c;
      i += 1;
      while (i < n) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          buf += quote + quote;
          i += 2;
          continue;
        }
        buf += sql[i];
        i += 1;
        if (sql[i - 1] === quote) break;
      }
      continue;
    }
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? n : close + tag[0].length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === ';') {
      flush();
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return out;
}

function classifyStatement(statement: string): string {
  let s = statement.trimStart();
  while (s.startsWith('(')) s = s.slice(1).trimStart();
  const first = (/^[a-zA-Z]+/.exec(s)?.[0] ?? '').toLowerCase();
  if (first === 'with') {
    const lower = s.toLowerCase();
    if (/\binsert\b/.test(lower)) return 'insert';
    if (/\bupdate\b/.test(lower)) return 'update';
    if (/\bdelete\b/.test(lower)) return 'delete';
    if (/\bmerge\b/.test(lower)) return 'merge';
    return 'select';
  }
  return first;
}

/** Every top-level statement's keyword, lowercased. Exported for tests. */
export function classifyTableQueryStatements(sql: string): string[] {
  return splitStatements(sql).map(classifyStatement);
}

function assertSelectOnly(sql: string): void {
  const kinds = classifyTableQueryStatements(sql);
  if (kinds.length === 0) throw new TableQueryError('not_a_select', 'sql is empty.');
  const offending = kinds.find((kind) => kind !== 'select');
  if (offending !== undefined) {
    throw new TableQueryError(
      'not_a_select',
      `Only SELECT statements run here (found ${offending.toUpperCase() || 'an unknown statement'}).`
    );
  }
}

function integerOption(
  value: number | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TableQueryError(
      'invalid_argument',
      `${name} must be an integer from ${min} to ${max}.`
    );
  }
  return value;
}

/** Strip trailing whitespace and one terminating semicolon. */
function stripTerminator(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/**
 * Every row as ordered `[column, cell, type]` triples. `row_to_json` (json,
 * not jsonb) keeps SELECT order and duplicate names; `#>> '{}'` renders each
 * `json_each` value as text exactly as `json_each_text` would (null stays
 * null), and `json_typeof` names its JSON type; the CASE cuts long cells and
 * appends `…[+N chars]` with the exact number of characters removed. The
 * newlines around the inner SQL keep a trailing `--` comment from swallowing
 * `) r`.
 */
function wrapForReader(sql: string): string {
  return (
    'SELECT (SELECT json_agg(json_build_array(pair.key, ' +
    'CASE WHEN length(pair.text) > $2 ' +
    "THEN left(pair.text, $2) || '…[+' || (length(pair.text) - $2)::text || ' chars]' " +
    'ELSE pair.text END, pair.type)) ' +
    "FROM (SELECT cell.key, cell.value #>> '{}' AS text, json_typeof(cell.value) AS type " +
    'FROM json_each(row_to_json(r)) AS cell) AS pair) AS row\n' +
    `FROM (\n${sql}\n) AS r\nLIMIT $1`
  );
}

const CLIENT_TIMEOUT_MESSAGE = 'Query read timeout';

function isClientTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === CLIENT_TIMEOUT_MESSAGE;
}

/** Best effort from the app pool: the reader connection is being discarded. */
async function cancelReaderBackend(app: DbClient, processId: number): Promise<void> {
  try {
    await app.query('SELECT pg_cancel_backend($1)', [processId]);
    await app.query('SELECT pg_terminate_backend($1)', [processId]);
  } catch {
    // The backend may already be gone; the discarded socket ends it anyway.
  }
}

type PairRow = { row: [string, string | null, TableQueryCellType | null][] | null };

function parseRows(raw: PairRow[]): Pick<TableQueryRows, 'columns' | 'rows' | 'types'> {
  const first = raw[0]?.row;
  if (!first) return { columns: [], rows: [], types: [] };
  const columns = first.map(([key]) => key);
  const rows = raw.map((entry) => (entry.row ?? []).map(([, value]) => value));
  const types = raw.map((entry) => (entry.row ?? []).map(([, , type]) => type ?? 'null'));
  return { columns, rows, types };
}

export class TableQueryEngine {
  constructor(private readonly profile: ReaderQueryProfile = TABLES_READER_PROFILE) {}

  /**
   * Run one read-only SELECT as the profile's reader (the tables reader by
   * default).
   *
   * Throws {@link TableQueryError} for requests refused before PostgreSQL, and
   * the driver's error (with its SQLSTATE `code`) for anything the server
   * refuses. Returns the refusal shape when no reader connection exists.
   */
  async select(
    sql: string,
    options: TableQueryOptions = {},
    dependencies: TableQueryDependencies = {}
  ): Promise<TableQueryResult> {
    if (typeof sql !== 'string' || !sql.trim()) {
      throw new TableQueryError('invalid_argument', 'sql must be a non-empty string.');
    }
    const { profile } = this;
    const limit = integerOption(
      options.limit,
      'limit',
      profile.limit.fallback,
      1,
      profile.limit.max
    );
    const maxCell = integerOption(
      options.maxCell,
      'maxCell',
      profile.maxCell.fallback,
      profile.maxCell.min,
      profile.maxCell.max
    );
    assertSelectOnly(sql);
    try {
      assertNoImmutableTables(sql);
    } catch (error: unknown) {
      throw new TableQueryError('immutable_table', getErrorMessage(error));
    }

    const reader =
      dependencies.reader === undefined ? await profile.resolveReader() : dependencies.reader;
    if (!reader) return { ok: false, code: 'unavailable', message: profile.unavailableMessage };
    const app = dependencies.app ?? (await getDbClient());
    const wrapped = wrapForReader(stripTerminator(sql));

    const raw = await reader.withConnection(async (connection) => {
      let inTransaction = false;
      try {
        await connection.query('BEGIN READ ONLY');
        inTransaction = true;
        // Timestamps print in the user's zone with its offset, and casts such
        // as `due::date` use that zone's calendar, as table_write reads
        // offset-less values there.
        await connection.query("SELECT set_config('TimeZone', $1, true)", [userTimeZone()]);
        const result = await connection.query<PairRow>(wrapped, [limit + 1, maxCell]);
        return result.rows;
      } catch (error: unknown) {
        if (error instanceof Error && isClientTimeout(error)) {
          // The statement is still running server-side and this socket can no
          // longer be trusted to be in sync: drop it and stop the backend.
          connection.discard(error);
          if (connection.processId !== null) await cancelReaderBackend(app, connection.processId);
          inTransaction = false;
        }
        throw error;
      } finally {
        if (inTransaction) {
          // Runs after a server-side error too (the transaction is aborted,
          // ROLLBACK is still accepted). Failures here mean the connection is
          // unusable, so it is discarded rather than pooled.
          try {
            await connection.query('ROLLBACK');
            await connection.query('SELECT pg_advisory_unlock_all()');
          } catch (cleanupError: unknown) {
            connection.discard(
              cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
            );
          }
        }
      }
    });

    const capped = raw.length > limit;
    const { columns, rows, types } = parseRows(capped ? raw.slice(0, limit) : raw);
    return { ok: true, columns, rows, types, capped };
  }
}

export const TableQuery = new TableQueryEngine();
