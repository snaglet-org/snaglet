import {
  CUSTOM_TABLES_SCHEMA,
  type FilterValue,
  assertAllowedTable,
  quoteIdentifier,
} from '@snaglet/db';
import {
  TableQuery,
  TableQueryError,
  type TableQueryRefusal,
  type TableQueryRows,
} from '@snaglet/db/tables/table_query';
import type { ToolHandler } from '@server/services/ToolService/types';
import { sqlState } from '@server/services/ToolService/tools/database/_shared/errors';
import { clampInt, getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';

/**
 * kind:"database" search: reads one custom table through {@link TableQuery}
 * as the read-only `snaglet_tables_reader` role (SELECT on `user_tables` only), not
 * the workspace reader, which would expose every agent's memories and threads
 * to this unguarded tool. Names are allow-listed by {@link assertCustomTable}
 * and qualified as `user_tables.<name>` (`pg_catalog` resolves before the pinned
 * search_path). Filter values are inlined as escaped literals: with validated
 * identifiers and a read-only transaction, a crafted value can at worst read
 * another `user_tables` table.
 */

/**
 * One plain refusal, identical for a forbidden (`public` / credential /
 * `pg_catalog`), unknown, or immutable table, so database search never reveals
 * whether a non-custom relation exists.
 */
const NOT_A_CUSTOM_TABLE =
  'No such table. kind:"database" reads custom Database tables only (the `user_tables` schema); ' +
  'workspace tables, credential tables and catalog relations are not searchable here. Use the ' +
  '`table` tool to list your custom tables.';

/** Shown when this install has no tables-reader connection (e.g. an external database). */
const DATABASE_MODE_UNAVAILABLE =
  'Database search is unavailable here (no snaglet_tables_reader connection). Use the `table` tool ' +
  '(op `read` or `query`) to read custom tables.';

/** A {@link TableQuery} refusal as the error this tool throws. */
function refusal(result: TableQueryRefusal): Error {
  return new Error(result.code === 'unavailable' ? DATABASE_MODE_UNAVAILABLE : result.message);
}

function parseStringArray(input: unknown): string[] {
  return Array.isArray(input) ? input.map((value) => String(value)).filter(Boolean) : [];
}

function parseFilters(input: unknown): Record<string, FilterValue> | undefined {
  if (input === undefined) return undefined;

  let parsed: unknown = input;
  if (typeof input === 'string') {
    // Valid JSON never parses to undefined, so undefined means malformed input.
    parsed = safeJsonParse<unknown>(input);
    if (parsed === undefined) {
      throw new Error('filters must be an object (received malformed JSON)');
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('filters must be an object');
  }

  const prototype = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('filters must be an object');
  }

  return parsed as Record<string, FilterValue>;
}

/** Render a scalar as a SQL literal for the read-only reader. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeColumnListSql(columns: unknown): string {
  if (!Array.isArray(columns) || columns.length === 0) return '*';
  return columns.map((column) => quoteIdentifier(String(column))).join(', ');
}

/** The WHERE clause from `filters`, with values inlined as literals. */
function buildFilterSql(filters: Record<string, FilterValue> | undefined): string {
  if (!filters || Object.keys(filters).length === 0) return '';
  const clauses: string[] = [];
  for (const [rawColumn, rawCondition] of Object.entries(filters)) {
    const column = quoteIdentifier(rawColumn);
    if (rawCondition === null) {
      clauses.push(`${column} IS NULL`);
      continue;
    }
    if (
      typeof rawCondition !== 'object' ||
      Array.isArray(rawCondition) ||
      !('op' in rawCondition)
    ) {
      clauses.push(`${column} = ${sqlLiteral(rawCondition)}`);
      continue;
    }
    const op = rawCondition.op ?? 'eq';
    const value = rawCondition.value;
    switch (op) {
      case 'eq':
        clauses.push(`${column} = ${sqlLiteral(value)}`);
        break;
      case 'ne':
        clauses.push(`${column} <> ${sqlLiteral(value)}`);
        break;
      case 'gt':
        clauses.push(`${column} > ${sqlLiteral(value)}`);
        break;
      case 'gte':
        clauses.push(`${column} >= ${sqlLiteral(value)}`);
        break;
      case 'lt':
        clauses.push(`${column} < ${sqlLiteral(value)}`);
        break;
      case 'lte':
        clauses.push(`${column} <= ${sqlLiteral(value)}`);
        break;
      case 'like':
        clauses.push(`${column} LIKE ${sqlLiteral(value)}`);
        break;
      case 'ilike':
        clauses.push(`${column} ILIKE ${sqlLiteral(value)}`);
        break;
      case 'in':
      case 'not_in': {
        if (!Array.isArray(value) || value.length === 0) {
          throw new Error(`${op} filter for ${rawColumn} requires a non-empty array`);
        }
        const list = value.map((item) => sqlLiteral(item)).join(', ');
        clauses.push(`${column} ${op === 'in' ? 'IN' : 'NOT IN'} (${list})`);
        break;
      }
      case 'is_null':
        clauses.push(`${column} IS ${value ? '' : 'NOT '}NULL`);
        break;
      default:
        throw new Error(`Unsupported filter operator: ${op}`);
    }
  }
  return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * Turn a reader refusal into advice an agent can act on. The table is already
 * allow-listed to `user_tables` by {@link assertCustomTable}, so a missing-grant
 * (42501) or unknown-relation (42P01) error here is a late race (the table was
 * dropped) rather than an exfil attempt; both collapse to the same plain
 * message so database mode never leaks whether a forbidden relation exists.
 */
function describeDatabaseFailure(error: unknown): string {
  if (error instanceof TableQueryError) return error.message;
  switch (sqlState(error)) {
    case '42501':
    case '42P01':
      return NOT_A_CUSTOM_TABLE;
    case '57014':
      return 'Database search canceled after 5 seconds; narrow it with filters or a smaller limit.';
    default:
      return getErrorMessage(error);
  }
}

/**
 * Refuse any name that is not a relation (table or view) in the `user_tables` schema — the
 * allow-list for kind:"database". Resolved through the reader itself (so it
 * sees exactly what a query would), schema-pinned to `user_tables` so a bare
 * `public` or `pg_catalog` name (`pg_settings`, `pg_roles`, `pg_views`, …) can
 * never match. `assertAllowedTable` first rejects a non-identifier or an
 * immutable credential name; everything else that is not in `user_tables` fails
 * here with the single {@link NOT_A_CUSTOM_TABLE} message.
 */
async function assertCustomTable(table: string): Promise<void> {
  // A non-identifier or an immutable credential name is refused with the same
  // plain message as any other non-custom table (assertAllowedTable's own
  // wording would otherwise reveal that it hit the credential denylist).
  try {
    assertAllowedTable(table, 'read');
  } catch {
    throw new Error(NOT_A_CUSTOM_TABLE);
  }
  // `to_regclass` on an explicitly `user_tables.`-qualified name: non-NULL only
  // when a table of that name really exists in `user_tables` and the reader can
  // see it. The quoted identifier is injected as a SQL literal argument, not an
  // identifier, so it cannot resolve against another schema.
  const literal = `'user_tables.${quoteIdentifier(table).replace(/'/g, "''")}'`;
  let result: Awaited<ReturnType<typeof TableQuery.select>>;
  try {
    result = await TableQuery.select(`SELECT to_regclass(${literal}) IS NOT NULL AS ok`, {
      limit: 1,
    });
  } catch (error: unknown) {
    throw new Error(describeDatabaseFailure(error));
  }
  if (!result.ok) throw refusal(result);
  const okIndex = result.columns.indexOf('ok');
  const value = okIndex >= 0 ? (result as TableQueryRows).rows[0]?.[okIndex] : null;
  // Postgres renders a boolean as 't' / 'f' in text; anything but a clear true
  // is a refusal.
  if (value !== 't' && value !== 'true') {
    throw new Error(NOT_A_CUSTOM_TABLE);
  }
}

/**
 * The text-like (or otherwise searchable) columns of `table`, discovered as
 * the reader so column discovery sees exactly what the search will. Pinned to
 * the `user_tables` schema like the search itself, so a custom table named after
 * a catalog view (`pg_settings`, …) reports its own columns.
 */
async function resolveSearchColumns(
  table: string,
  explicitSearchColumns: string[],
  explicitReturnColumns: string[]
): Promise<string[]> {
  if (explicitSearchColumns.length > 0) return explicitSearchColumns;
  if (explicitReturnColumns.length > 0) return explicitReturnColumns;

  const literal = `'${table.replace(/'/g, "''")}'`;
  // Columns the reader may SELECT in user_tables.<table>, text-like first then
  // other searchable ones. has_column_privilege keeps
  // a column the reader cannot read out of the search, matching the row boundary.
  const result = await TableQuery.select(
    `SELECT c.column_name
       FROM information_schema.columns c
      WHERE c.table_schema = '${CUSTOM_TABLES_SCHEMA}'
        AND c.table_name = ${literal}
        AND has_column_privilege(
              session_user, format('%I.%I', c.table_schema, c.table_name), c.column_name, 'SELECT')
        AND lower(c.udt_name) NOT LIKE '\\_%'
        AND lower(c.udt_name) NOT IN ('vector', 'tsvector')
        AND lower(c.data_type) NOT IN ('json', 'jsonb', 'bytea')
      ORDER BY
        CASE WHEN lower(c.data_type) IN ('text','character varying','character','varchar')
               OR lower(c.udt_name) = 'citext' THEN 0 ELSE 1 END,
        c.ordinal_position`,
    { limit: 200 }
  );

  if (!result.ok) throw refusal(result);
  const nameIndex = result.columns.indexOf('column_name');
  const columns: string[] = (result as TableQueryRows).rows
    .map((row) => (nameIndex >= 0 ? row[nameIndex] : null))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (columns.length > 0) return columns;
  throw new Error(`No searchable columns found for table "${table}"`);
}

function formatRows(result: TableQueryRows, limit: number): string {
  if (result.columns.length === 0 || result.rows.length === 0) {
    return 'No rows returned.';
  }
  const header = result.columns.join(' | ');
  const separator = result.columns.map((column) => '-'.repeat(column.length)).join('-+-');
  const renderedRows = result.rows.map((row) =>
    row.map((cell) => (cell === null ? 'NULL' : cell)).join(' | ')
  );
  let output = `${header}\n${separator}\n${renderedRows.join('\n')}`;
  if (result.capped) {
    output += `\n\n(showing the first ${limit} rows; more matched — narrow with filters)`;
  }
  return output;
}

const tool: ToolHandler = async (input) => {
  const table = String(input.table ?? '');
  // Allow-list gate: only a real `user_tables` custom table may be queried.
  await assertCustomTable(table);

  const query = input.query !== undefined ? String(input.query) : '';
  const searchColumns = parseStringArray(input.search_columns);
  const requestedColumns = parseStringArray(input.columns);

  let resolvedSearchColumns: string[] = [];
  if (query) {
    try {
      resolvedSearchColumns = await resolveSearchColumns(table, searchColumns, requestedColumns);
    } catch (error: unknown) {
      throw new Error(describeDatabaseFailure(error));
    }
  }

  const limit = clampInt(input.limit, 25, 1, 200);
  const offset = Math.max(Number(input.offset ?? 0), 0);
  const orderBy = input.order_by ? String(input.order_by) : null;
  const orderDirection =
    String(input.order_direction ?? 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const columnsSql = normalizeColumnListSql(input.columns);
  const filters = parseFilters(input.filters);

  let sql = `SELECT ${columnsSql} FROM user_tables.${quoteIdentifier(table)}`;
  const filterSql = buildFilterSql(filters);
  sql += filterSql;

  if (query) {
    const searchClause = resolvedSearchColumns
      .map((column: string) => `${quoteIdentifier(column)}::text ILIKE ${sqlLiteral(`%${query}%`)}`)
      .join(' OR ');
    sql += filterSql ? ` AND (${searchClause})` : ` WHERE (${searchClause})`;
  }

  if (orderBy) {
    sql += ` ORDER BY ${quoteIdentifier(orderBy)} ${orderDirection}`;
  }

  if (offset > 0) {
    sql += ` OFFSET ${Math.floor(offset)}`;
  }

  let result: Awaited<ReturnType<typeof TableQuery.select>>;
  try {
    result = await TableQuery.select(sql, { limit });
  } catch (error: unknown) {
    throw new Error(describeDatabaseFailure(error));
  }
  if (!result.ok) throw refusal(result);
  return formatRows(result, limit);
};

export default tool;
