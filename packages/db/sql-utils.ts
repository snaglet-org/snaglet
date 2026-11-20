/**
 * SQL utility functions shared across database tool handlers.
 * Provides identifier validation, query building, and result formatting.
 */

export const IMMUTABLE_DATABASE_TABLES = new Set([
  'provider_fallback_credentials',
  'user_provider_credentials',
]);

export const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type FilterValue =
  | string
  | number
  | boolean
  | null
  | {
      op?:
        | 'eq'
        | 'ne'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'like'
        | 'ilike'
        | 'in'
        | 'not_in'
        | 'is_null';
      value?: unknown;
    };

export function assertValidIdentifier(name: string, label: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
}

export function quoteIdentifier(name: string): string {
  assertValidIdentifier(name, 'identifier');
  return `"${name}"`;
}

export function assertAllowedTable(table: string, mode: 'read' | 'write'): void {
  assertValidIdentifier(table, 'table name');
  if (IMMUTABLE_DATABASE_TABLES.has(table)) {
    throw new Error(
      `${mode === 'write' ? 'Mutation' : 'Read'} access is not allowed for immutable table: ${table}`
    );
  }
}

// Scans a raw SQL string for any reference to a credential table. Used by
// the raw-SQL paths (database_execute, ad-hoc database-query) and by
// database_create_view to prevent a VIEW from being used as an exfil proxy.
// Two layers: structured table-ref regex catches common SQL forms; substring
// scan catches creative phrasing (aliases, comments, whitespace tricks).
// The denylist is small enough that an over-block on a column or alias
// sharing a name with a credential table is an acceptable trade.
export function assertNoImmutableTables(sql: string): void {
  const tableRefRegex = /\b(?:from|join|into|update|table)\s+(?:"?\w+"?\.)?"?(\w+)"?/gi;
  for (const match of sql.matchAll(tableRefRegex)) {
    const table = (match[1] ?? '').toLowerCase();
    if (IMMUTABLE_DATABASE_TABLES.has(table)) {
      throw new Error(`Access denied: query references immutable table "${table}"`);
    }
  }
  const lower = sql.toLowerCase();
  for (const table of IMMUTABLE_DATABASE_TABLES) {
    if (lower.includes(table)) {
      throw new Error(`Access denied: query references immutable table "${table}"`);
    }
  }
}

export function normalizeColumnList(columns: unknown, fallback = '*'): string {
  if (!Array.isArray(columns) || columns.length === 0) return fallback;
  return columns.map((column) => quoteIdentifier(String(column))).join(', ');
}

export function buildFilterClause(
  filters: Record<string, FilterValue> | undefined,
  startingIndex = 1
): { sql: string; params: unknown[]; nextIndex: number } {
  if (!filters || Object.keys(filters).length === 0) {
    return { sql: '', params: [], nextIndex: startingIndex };
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  let index = startingIndex;

  for (const [rawColumn, rawCondition] of Object.entries(filters)) {
    const column = quoteIdentifier(rawColumn);

    if (rawCondition === null) {
      clauses.push(`${column} IS NULL`);
      continue;
    }

    if (
      typeof rawCondition !== 'object' ||
      Array.isArray(rawCondition) ||
      rawCondition === null ||
      !('op' in rawCondition)
    ) {
      clauses.push(`${column} = $${index}`);
      params.push(rawCondition);
      index += 1;
      continue;
    }

    const op = rawCondition.op ?? 'eq';
    const value = rawCondition.value;

    switch (op) {
      case 'eq':
        clauses.push(`${column} = $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'ne':
        clauses.push(`${column} <> $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'gt':
        clauses.push(`${column} > $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'gte':
        clauses.push(`${column} >= $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'lt':
        clauses.push(`${column} < $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'lte':
        clauses.push(`${column} <= $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'like':
        clauses.push(`${column} LIKE $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'ilike':
        clauses.push(`${column} ILIKE $${index}`);
        params.push(value);
        index += 1;
        break;
      case 'in':
      case 'not_in': {
        if (!Array.isArray(value) || value.length === 0) {
          throw new Error(`${op} filter for ${rawColumn} requires a non-empty array`);
        }
        const placeholders = value.map(() => `$${index++}`);
        params.push(...value);
        clauses.push(`${column} ${op === 'in' ? 'IN' : 'NOT IN'} (${placeholders.join(', ')})`);
        break;
      }
      case 'is_null':
        clauses.push(`${column} IS ${value ? '' : 'NOT '}NULL`);
        break;
      default:
        throw new Error(`Unsupported filter operator: ${op}`);
    }
  }

  return {
    sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
    nextIndex: index,
  };
}

export function ensureReadonlySelectSql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error('select_sql is required');
  if (trimmed.includes(';')) {
    throw new Error('select_sql must contain a single statement without semicolons');
  }
  const normalized = trimmed.toLowerCase();
  if (!(normalized.startsWith('select') || normalized.startsWith('with'))) {
    throw new Error('select_sql must start with SELECT or WITH');
  }
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(trimmed)) {
    throw new Error('select_sql contains forbidden write operations');
  }
  return trimmed;
}

export function formatQueryRows(
  rows: Record<string, unknown>[],
  rowCount: number,
  limit?: number
): string {
  if (!rows || rows.length === 0) {
    return `Query executed successfully. ${rowCount} rows affected. No rows returned.`;
  }

  const columns = Object.keys(rows[0]);
  const header = columns.join(' | ');
  const separator = columns.map((c) => '-'.repeat(c.length)).join('-+-');
  const renderedRows = rows.map((row) =>
    columns
      .map((column) => {
        const value = row[column];
        if (value === null) return 'NULL';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
      })
      .join(' | ')
  );

  let output = `${header}\n${separator}\n${renderedRows.join('\n')}`;
  if (typeof limit === 'number' && rowCount > limit) {
    output += `\n\n(showing ${rows.length} of ${rowCount} rows)`;
  }
  return output;
}
