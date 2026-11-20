/**
 * Structured `table` reads for hook and tool code (`snaglet.tables.read`).
 *
 * The text a read returns (TSV for SQL, one line per entry for id and page
 * reads) is what agents read and what older hooks parse, so it never changes.
 * When the caller is SDK code (`ToolHandlerContext.structuredResult`), the
 * same read also carries its rows as objects, built from the same result, so
 * code can gate on "every row of phase 2 is Done" without parsing text.
 */

import type { TableQueryCellType } from '@snaglet/db/tables/table_query';
import type { TableEntryValue, TableField } from '@snaglet/shared/types';
import { safeJsonParse } from '@snaglet/shared/utils';
import type {
  AgentEntriesResult,
  AgentListEntriesResult,
  AgentQueryResult,
} from '@server/domains/tables/tableAgent';

/** One value in a structured row. */
type TableReadCell = string | number | boolean | null;

/**
 * A row value: one cell, or a list of them for a multi-select, a multiple
 * relation or an array column.
 */
export type TableReadValue = TableReadCell | TableReadCell[];

/** What a row read adds beside its text: the rows as objects keyed by `fields`. */
export interface TableReadData {
  /** Keys in order: a query's columns; `id`, `rev`, then field names for an entry read. */
  fields: string[];
  rows: Record<string, TableReadValue>[];
}

/**
 * A number's text as a JS number, or the text itself when it is not a finite
 * number or is too large to keep exactly (beyond 2^53): a bigint id or a huge
 * numeric stays the string the TSV shows.
 */
function numberOrText(text: string): number | string {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    return text;
  }
  return value;
}

/** Own-property write, so a column named `__proto__` is a key, not a prototype. */
function setOwn(row: Record<string, TableReadValue>, key: string, value: TableReadValue): void {
  Object.defineProperty(row, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function asCell(value: unknown): TableReadCell {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  return JSON.stringify(value) ?? null;
}

/**
 * One SQL cell from its text and JSON type: numbers and booleans come back
 * typed, an array column as a list, everything else (text, select labels,
 * dates, timestamps, ranges, objects) as the text the TSV shows. A cell the
 * reader cut (`…[+N chars]`) stays text.
 */
export function sqlCellValue(
  text: string | null,
  type: TableQueryCellType | undefined
): TableReadValue {
  if (text === null) return null;
  if (type === 'number') return numberOrText(text);
  if (type === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
  if (type === 'array') {
    const parsed = safeJsonParse<unknown>(text, undefined);
    return Array.isArray(parsed) ? parsed.map(asCell) : text;
  }
  return text;
}

/** A `{sql}` read's rows: one object per row, keyed by column (a repeated column keeps its last cell). */
export function structuredQuery(result: AgentQueryResult): TableReadData {
  const rows = result.rows.map((cells, rowIndex) => {
    const row: Record<string, TableReadValue> = {};
    result.columns.forEach((column, index) => {
      setOwn(row, column, sqlCellValue(cells[index] ?? null, result.types?.[rowIndex]?.[index]));
    });
    return row;
  });
  return { fields: [...new Set(result.columns)], rows };
}

/** One entry value: a number field's decimal string becomes a number; the rest pass through. */
export function entryCellValue(
  value: TableEntryValue | undefined,
  type: string | undefined
): TableReadValue {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'string' && type === 'number') return numberOrText(value);
  return value;
}

/**
 * An `{table, ids}` or paged `{table, where/sort/columns/page}` read's rows:
 * `id`, `rev` (the short revision a guarded write takes), then each field by
 * name. `fields` is the table's editable fields, narrowed to the requested
 * `columns` when given; with no rows it still lists them.
 */
export function structuredEntries(
  result: AgentEntriesResult | AgentListEntriesResult,
  tableFields: readonly Pick<TableField, 'name' | 'type' | 'managed'>[],
  columns?: readonly string[]
): TableReadData {
  const editable = tableFields.filter((field) => !field.managed);
  const wanted = columns?.map((name) => name.trim().toLowerCase());
  const picked = wanted
    ? editable.filter((field) => wanted.includes(field.name.toLowerCase()))
    : editable;
  const typeOf = new Map(picked.map((field) => [field.name, field.type as string]));
  const names = picked.map((field) => field.name);
  const rows = result.entries.map((entry) => {
    const row: Record<string, TableReadValue> = {};
    setOwn(row, 'id', entry.id);
    setOwn(row, 'rev', entry.rev);
    // Every listed field is a key: one the entry never set reads null.
    for (const name of names) {
      setOwn(
        row,
        name,
        Object.hasOwn(entry.values, name)
          ? entryCellValue(entry.values[name], typeOf.get(name))
          : null
      );
    }
    return row;
  });
  return { fields: [...new Set(['id', 'rev', ...names])], rows };
}
