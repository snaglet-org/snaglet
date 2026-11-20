/**
 * Scans of the whole database for what a delete left behind: every column
 * of every table that can hold text (text, JSON, arrays, search vectors) is
 * searched for ids or for a sentinel string. Slow on a big database, fine on
 * a test one.
 */
import { getDb } from '@snaglet/db';

/** Columns whose text is a person's own writing elsewhere, kept as written. */
const KEPT_TEXT = new Set(['public.docs.content', 'public.doc_snapshots.content']);

interface Column {
  name: string;
  /** SQL for the column's text, on the table aliased `t`. */
  text: string;
  from: string;
  isSearchVector: boolean;
}

async function textColumns(): Promise<Column[]> {
  const { rows } = await getDb().query<{
    schema: string;
    table: string;
    column: string;
    type: string;
    udt: string;
  }>(
    `SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column,
            c.data_type AS type, c.udt_name AS udt
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE t.table_type = 'BASE TABLE'
        AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND (c.data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')
             OR c.udt_name = 'tsvector')
      ORDER BY 1, 2, 3`
  );
  return rows.map(({ schema, table, column, type, udt }) => {
    const ident = `t."${column.replace(/"/g, '""')}"`;
    return {
      name: `${schema}.${table}.${column}`,
      text: type === 'ARRAY' ? `array_to_string(${ident}, ' ')` : `${ident}::text`,
      from: `"${schema}"."${table}" t`,
      isSearchVector: udt === 'tsvector',
    };
  });
}

/** Every column that holds one of `ids`, as `schema.table.column` -> the ids it holds. */
async function scanForIds(ids: string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const column of await textColumns()) {
    if (column.isSearchVector || KEPT_TEXT.has(column.name)) continue;
    const { rows } = await getDb().query<{ id: string }>(
      `SELECT p.id FROM unnest($1::text[]) AS p(id)
        WHERE EXISTS (SELECT 1 FROM ${column.from} WHERE ${column.text} LIKE '%' || p.id || '%')
        ORDER BY p.id`,
      [ids]
    );
    if (rows.length > 0)
      found.set(
        column.name,
        rows.map((row) => row.id)
      );
  }
  return found;
}

/** What is left of `ids`, one line per column: `schema.table.column: <ids>`. */
export async function residue(ids: string[]): Promise<string[]> {
  return [...(await scanForIds(ids))].map(([column, held]) => `${column}: ${held.join(', ')}`);
}

/** Of `ids`, those no column holds; empty when the scan can see every one. */
export async function unseen(ids: string[]): Promise<string[]> {
  const seen = new Set([...(await scanForIds(ids)).values()].flat());
  return ids.filter((value) => !seen.has(value));
}

/**
 * Every column, search vectors and people's own docs included, where some row
 * holds `sentinel` (case-insensitive), as `schema.table.column: n row(s)`.
 */
export async function sentinelHits(sentinel: string): Promise<string[]> {
  const hits: string[] = [];
  for (const column of await textColumns()) {
    const { rows } = await getDb().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${column.from} WHERE ${column.text} ILIKE '%' || $1 || '%'`,
      [sentinel]
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) hits.push(`${column.name}: ${n} row(s)`);
  }
  return hits;
}
