import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { CUSTOM_TABLES_SCHEMA } from '@snaglet/db/tables/table_catalog';

export interface NamedEntries {
  /** The table's catalog name. */
  tableName: string;
  /** Entry id → its Name-field value ('' when unnamed or the table has none). */
  names: Map<string, string>;
}

/**
 * Codes a single table's name read may hit when its schema changes or its
 * table is busy mid-request. That table's names are left out; the caller's
 * transaction and every other table's names are unaffected.
 */
const SKIPPED_TABLE_ERRORS = new Set(['42703', '42P01', '55P03', '57014']);

function isSkippedTableError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && SKIPPED_TABLE_ERRORS.has(code);
}

/**
 * Names of the given entries (lowercase UUIDs), one query per custom table.
 * Unknown, built-in, archived, deleted and missing tables, and missing
 * entries, are absent, so links into an archived table show as unavailable.
 * Names decorate links and chips, so this takes no schema locks: each table
 * is read under a savepoint, and a table whose Name column or physical table
 * changes concurrently is skipped. Must run inside a transaction.
 */
export async function readEntryNames(
  idsByTable: ReadonlyMap<string, readonly string[]>,
  tx: DbQueryable
): Promise<Map<string, NamedEntries>> {
  const result = new Map<string, NamedEntries>();
  if (!idsByTable.size) return result;
  const { rows: tables } = await tx.query<{
    id: string;
    name: string;
    table_name: string;
    title_column: string | null;
  }>(
    `SELECT catalog.id, catalog.name, catalog.table_name, title.column_name AS title_column
       FROM public.table_catalog AS catalog
       LEFT JOIN public.table_fields AS title
              ON title.table_id = catalog.id AND title.is_title AND title.state = 'active'
      WHERE catalog.id = ANY($1::text[]) AND catalog.origin = 'custom' AND catalog.state = 'active'
        AND to_regclass(format('%I.%I', $2::text, catalog.table_name)) IS NOT NULL
      ORDER BY catalog.id`,
    [[...idsByTable.keys()], CUSTOM_TABLES_SCHEMA]
  );
  for (const table of tables) {
    const ids = idsByTable.get(table.id);
    if (!ids?.length) continue;
    const name = table.title_column
      ? `COALESCE(${quoteIdentifier(table.title_column)}::text, '')`
      : "''";
    await tx.query('SAVEPOINT snaglet_entry_names');
    try {
      const { rows } = await tx.query<{ id: string; name: string }>(
        `SELECT id::text AS id, ${name} AS name
           FROM ONLY ${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(table.table_name)}
          WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      await tx.query('RELEASE SAVEPOINT snaglet_entry_names');
      result.set(table.id, {
        tableName: table.name,
        names: new Map(rows.map((row) => [row.id, row.name])),
      });
    } catch (error) {
      if (!isSkippedTableError(error)) throw error;
      await tx.query('ROLLBACK TO SAVEPOINT snaglet_entry_names');
    }
  }
  return result;
}
