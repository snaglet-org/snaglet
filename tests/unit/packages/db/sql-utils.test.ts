import { describe, test, expect } from '@jest/globals';
import {
  assertValidIdentifier,
  quoteIdentifier,
  assertAllowedTable,
  assertNoImmutableTables,
  normalizeColumnList,
  buildFilterClause,
  ensureReadonlySelectSql,
  formatQueryRows,
  IMMUTABLE_DATABASE_TABLES,
  type FilterValue,
} from '../../../../packages/db/sql-utils';

/**
 * sql-utils underpins the raw-SQL / database tool surface, so its guards
 * (identifier validation, immutable-table denylist, readonly enforcement)
 * are security-load-bearing. These tests pin the accept/reject boundaries
 * and the parameterized-clause shapes.
 */

describe('assertValidIdentifier', () => {
  test('accepts valid SQL identifiers', () => {
    expect(() => assertValidIdentifier('users', 'identifier')).not.toThrow();
    expect(() => assertValidIdentifier('_private', 'identifier')).not.toThrow();
    expect(() => assertValidIdentifier('Col_2', 'identifier')).not.toThrow();
  });

  test('rejects empty, leading-digit, and special-char identifiers', () => {
    expect(() => assertValidIdentifier('', 'identifier')).toThrow('Invalid identifier: ');
    expect(() => assertValidIdentifier('1abc', 'identifier')).toThrow('Invalid identifier: 1abc');
    expect(() => assertValidIdentifier('a-b', 'identifier')).toThrow();
    expect(() => assertValidIdentifier('drop table', 'identifier')).toThrow();
    expect(() => assertValidIdentifier('users; DROP', 'col')).toThrow('Invalid col: users; DROP');
  });
});

describe('quoteIdentifier', () => {
  test('wraps a valid identifier in double quotes', () => {
    expect(quoteIdentifier('users')).toBe('"users"');
  });

  test('throws for an invalid identifier (no quoting of injection)', () => {
    expect(() => quoteIdentifier('a"; DROP TABLE x; --')).toThrow('Invalid identifier');
  });
});

describe('assertAllowedTable', () => {
  test('allows non-immutable, valid table names', () => {
    expect(() => assertAllowedTable('users', 'read')).not.toThrow();
    expect(() => assertAllowedTable('tasks', 'write')).not.toThrow();
  });

  test('blocks immutable credential tables with a mode-specific message', () => {
    expect(() => assertAllowedTable('user_provider_credentials', 'read')).toThrow(
      'Read access is not allowed for immutable table: user_provider_credentials'
    );
    expect(() => assertAllowedTable('provider_fallback_credentials', 'write')).toThrow(
      'Mutation access is not allowed for immutable table: provider_fallback_credentials'
    );
  });

  test('rejects invalid identifiers before the denylist check', () => {
    expect(() => assertAllowedTable('bad-name', 'read')).toThrow('Invalid table name: bad-name');
  });
});

describe('assertNoImmutableTables', () => {
  test('passes clean queries through', () => {
    expect(() => assertNoImmutableTables('SELECT * FROM users WHERE id = $1')).not.toThrow();
  });

  test('blocks structured references to credential tables', () => {
    expect(() => assertNoImmutableTables('SELECT * FROM user_provider_credentials')).toThrow(
      /immutable table/
    );
    expect(() =>
      assertNoImmutableTables(
        'SELECT u.* FROM users u JOIN provider_fallback_credentials c ON true'
      )
    ).toThrow(/immutable table/);
  });

  test('also blocks via substring scan (over-block is acceptable)', () => {
    // No FROM/JOIN keyword, but the table name still appears verbatim.
    expect(() =>
      assertNoImmutableTables('SELECT col FROM v WHERE x = (user_provider_credentials)')
    ).toThrow(/immutable table/);
  });

  test('every immutable table name is covered', () => {
    for (const table of IMMUTABLE_DATABASE_TABLES) {
      expect(() => assertNoImmutableTables(`SELECT * FROM ${table}`)).toThrow();
    }
  });
});

describe('normalizeColumnList', () => {
  test('quotes and joins a column array', () => {
    expect(normalizeColumnList(['id', 'name'])).toBe('"id", "name"');
  });

  test('returns the fallback for non-array or empty input', () => {
    expect(normalizeColumnList(undefined)).toBe('*');
    expect(normalizeColumnList([])).toBe('*');
    expect(normalizeColumnList('id')).toBe('*');
    expect(normalizeColumnList([], 'id')).toBe('id');
  });

  test('rejects invalid column identifiers', () => {
    expect(() => normalizeColumnList(['a-b'])).toThrow('Invalid identifier: a-b');
    expect(() => normalizeColumnList([1])).toThrow('Invalid identifier: 1');
  });
});

describe('buildFilterClause', () => {
  test('returns an empty clause for missing/empty filters', () => {
    expect(buildFilterClause(undefined)).toEqual({ sql: '', params: [], nextIndex: 1 });
    expect(buildFilterClause({})).toEqual({ sql: '', params: [], nextIndex: 1 });
    expect(buildFilterClause({}, 5)).toEqual({ sql: '', params: [], nextIndex: 5 });
  });

  test('builds equality clauses for primitive values', () => {
    const result = buildFilterClause({ status: 'active' });
    expect(result.sql).toBe(' WHERE "status" = $1');
    expect(result.params).toEqual(['active']);
    expect(result.nextIndex).toBe(2);
  });

  test('emits IS NULL for a null condition (no param)', () => {
    const result = buildFilterClause({ deleted_at: null });
    expect(result.sql).toBe(' WHERE "deleted_at" IS NULL');
    expect(result.params).toEqual([]);
    expect(result.nextIndex).toBe(1);
  });

  test('maps comparison operators', () => {
    expect(buildFilterClause({ age: { op: 'gte', value: 18 } }).sql).toBe(' WHERE "age" >= $1');
    expect(buildFilterClause({ age: { op: 'ne', value: 0 } }).sql).toBe(' WHERE "age" <> $1');
    expect(buildFilterClause({ name: { op: 'ilike', value: '%sam%' } }).sql).toBe(
      ' WHERE "name" ILIKE $1'
    );
  });

  test('expands in / not_in into placeholder lists', () => {
    const result = buildFilterClause({ id: { op: 'in', value: [1, 2, 3] } });
    expect(result.sql).toBe(' WHERE "id" IN ($1, $2, $3)');
    expect(result.params).toEqual([1, 2, 3]);
    expect(result.nextIndex).toBe(4);
    expect(buildFilterClause({ id: { op: 'not_in', value: ['a'] } }).sql).toBe(
      ' WHERE "id" NOT IN ($1)'
    );
  });

  test('rejects empty/invalid in arrays', () => {
    expect(() => buildFilterClause({ id: { op: 'in', value: [] } })).toThrow(
      'in filter for id requires a non-empty array'
    );
    expect(() => buildFilterClause({ id: { op: 'not_in', value: 'x' } })).toThrow(
      'not_in filter for id requires a non-empty array'
    );
  });

  test('is_null toggles IS NULL / IS NOT NULL on the truthiness of value', () => {
    expect(buildFilterClause({ x: { op: 'is_null', value: true } }).sql).toBe(' WHERE "x" IS NULL');
    expect(buildFilterClause({ x: { op: 'is_null', value: false } }).sql).toBe(
      ' WHERE "x" IS NOT NULL'
    );
  });

  test('treats an op-less object as an equality value', () => {
    // A bare object (no `op` key) is pushed as the equality param verbatim —
    // cast through `FilterValue` since the literal isn't in the public union.
    const payload = { foo: 1 };
    const result = buildFilterClause({ meta: payload as unknown as FilterValue });
    expect(result.sql).toBe(' WHERE "meta" = $1');
    expect(result.params).toEqual([payload]);
  });

  test('combines multiple filters with AND and honors startingIndex', () => {
    const result = buildFilterClause({ a: 1, b: { op: 'lt', value: 9 } }, 5);
    expect(result.sql).toBe(' WHERE "a" = $5 AND "b" < $6');
    expect(result.params).toEqual([1, 9]);
    expect(result.nextIndex).toBe(7);
  });

  test('quotes the column name (no raw interpolation of attacker keys)', () => {
    expect(() => buildFilterClause({ 'a"; DROP': 1 })).toThrow('Invalid identifier');
  });

  test('throws on an unsupported operator', () => {
    expect(() => buildFilterClause({ x: { op: 'weird' as 'eq', value: 1 } })).toThrow(
      'Unsupported filter operator: weird'
    );
  });
});

describe('ensureReadonlySelectSql', () => {
  test('returns the trimmed SQL for valid SELECT / WITH statements', () => {
    expect(ensureReadonlySelectSql('  SELECT * FROM users  ')).toBe('SELECT * FROM users');
    expect(ensureReadonlySelectSql('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(
      'WITH t AS (SELECT 1) SELECT * FROM t'
    );
  });

  test('rejects empty input', () => {
    expect(() => ensureReadonlySelectSql('   ')).toThrow('select_sql is required');
  });

  test('rejects multi-statement (semicolon) input', () => {
    expect(() => ensureReadonlySelectSql('SELECT 1; DROP TABLE users')).toThrow(
      'single statement without semicolons'
    );
  });

  test('rejects statements that do not start with SELECT or WITH', () => {
    expect(() => ensureReadonlySelectSql('DELETE FROM users')).toThrow(
      'must start with SELECT or WITH'
    );
  });

  test('rejects a SELECT/WITH that smuggles a write keyword', () => {
    expect(() => ensureReadonlySelectSql('WITH x AS (DELETE FROM y RETURNING *) SELECT 1')).toThrow(
      'forbidden write operations'
    );
  });
});

describe('formatQueryRows', () => {
  test('reports affected rows when no rows are returned', () => {
    expect(formatQueryRows([], 3)).toBe(
      'Query executed successfully. 3 rows affected. No rows returned.'
    );
  });

  test('renders a header, separator, and rows', () => {
    const out = formatQueryRows([{ id: 1, name: 'a' }], 1);
    const lines = out.split('\n');
    expect(lines[0]).toBe('id | name');
    expect(lines[2]).toBe('1 | a');
  });

  test('renders null as NULL and objects as JSON', () => {
    expect(formatQueryRows([{ a: null }], 1).split('\n')[2]).toBe('NULL');
    expect(formatQueryRows([{ a: { x: 1 } }], 1).split('\n')[2]).toBe('{"x":1}');
  });

  test('appends a truncation note when rowCount exceeds the limit', () => {
    expect(formatQueryRows([{ id: 1 }], 10, 5)).toContain('(showing 1 of 10 rows)');
    expect(formatQueryRows([{ id: 1 }], 1, 5)).not.toContain('(showing');
  });
});
