/**
 * Text ↔ Snaglet item relation conversions. Their values cannot be computed by an
 * `ALTER … USING` expression (titles and kinds live in other tables), so the
 * field edit retypes the column with `USING NULL` and then writes every
 * entry's converted value from here, inside the same locked transaction.
 */
import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import type { TableCatalogRow } from '@snaglet/db/tables/table_catalog';
import { TableReferences } from '@snaglet/db/tables/table_references';
import {
  TABLE_RELATION_MAX_LINKS,
  type TableField,
  type TableFieldDefinition,
  type TableReferenceKind,
} from '@snaglet/shared/types';
import {
  tableReferenceChip,
  tableReferenceIdsInText,
  tableReferenceKindArticle,
  tableReferenceKindName,
} from '@snaglet/shared/utils';
import { fieldConflict, physicalTable } from './fieldSchema';

/** Every entry's converted value, by entry id: text, one item id, or a list of them. */
export type ItemValues = Array<[string, string | string[] | null]>;

/** Up to three ids for a message, then `…`. */
function sample(ids: readonly string[]): string {
  return `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''}`;
}

/**
 * Text → items: allowed when every non-blank value is one chip
 * (`[Title](doc-…)`) or bare id of the kind — several, separated by commas
 * or spaces, for a multiple relation — archived items included. Otherwise
 * 409 and nothing changes.
 */
async function textToItems(
  table: TableCatalogRow,
  field: TableField,
  kind: TableReferenceKind,
  multiple: boolean,
  tx: DbQueryable
): Promise<ItemValues> {
  const { rows } = await tx.query<{ id: string; value: string | null }>(
    `SELECT id::text AS id, ${quoteIdentifier(field.columnName)} AS value FROM ONLY ${physicalTable(table)}`
  );
  const parsed: Array<[string, string[]]> = [];
  const unreadable: string[] = [];
  let several = false;
  for (const row of rows) {
    const ids = row.value === null ? [] : tableReferenceIdsInText(row.value);
    if (ids === null) {
      unreadable.push(row.id);
      continue;
    }
    const unique = [...new Set(ids)];
    if (unique.length > (multiple ? TABLE_RELATION_MAX_LINKS : 1)) several = true;
    parsed.push([row.id, unique]);
  }
  const name = tableReferenceKindName(kind);
  if (unreadable.length)
    throw fieldConflict(
      `Some values are not ${multiple ? `${name} chips or ids` : `one ${name} chip or id`}. Edit those values before making this a ${name} relation.`
    );
  const named = [...new Set(parsed.flatMap(([, ids]) => ids))];
  const found = await TableReferences.existingItems(kind, named, tx);
  const missing = named.filter((id) => !found.has(id));
  if (missing.length)
    throw fieldConflict(
      `Some values are not ${tableReferenceKindArticle(kind)} in Snaglet (${sample(missing)}). Edit those values first.`
    );
  if (several)
    throw fieldConflict(
      multiple
        ? `Some values name more than ${TABLE_RELATION_MAX_LINKS} ${tableReferenceKindName(kind, true)}. Shorten them first.`
        : `Some values name more than one ${name}. Allow multiple ${tableReferenceKindName(kind, true)}, or keep one per entry first.`
    );
  return parsed.map(([id, ids]) => [id, multiple ? ids : (ids[0] ?? null)]);
}

/**
 * Items → text: each link becomes chip markdown `[Title](id)` (several joined
 * with ", "); an item that no longer exists becomes its bare id.
 */
async function itemsToText(
  table: TableCatalogRow,
  field: TableField,
  kind: TableReferenceKind,
  tx: DbQueryable
): Promise<ItemValues> {
  const column = quoteIdentifier(field.columnName);
  const { rows } = await tx.query<{ id: string; value: string | string[] | null }>(
    `SELECT id::text AS id, ${field.multiple ? `to_json(${column})` : column} AS value
       FROM ONLY ${physicalTable(table)}`
  );
  const lists = rows.map((row): [string, string[]] => [
    row.id,
    Array.isArray(row.value) ? row.value : row.value === null ? [] : [row.value],
  ]);
  const items =
    (await TableReferences.readItems(new Map([[kind, lists.flatMap(([, ids]) => ids)]]), tx))[
      kind
    ] ?? {};
  return lists.map(([id, ids]) => [
    id,
    ids.length
      ? ids
          .map((item) =>
            Object.hasOwn(items, item) ? tableReferenceChip(item, items[item]?.title ?? '') : item
          )
          .join(', ')
      : null,
  ]);
}

/**
 * The values a text ↔ item relation edit writes, or null when `definition`
 * is not one (other conversions are `ALTER … USING` expressions).
 */
export async function itemValueConversion(
  table: TableCatalogRow,
  field: TableField,
  definition: TableFieldDefinition & { multiple: boolean },
  tx: DbQueryable
): Promise<ItemValues | null> {
  const toKind = definition.type === 'relation' ? (definition.referenceKind ?? null) : null;
  const fromKind = field.type === 'relation' ? (field.referenceKind ?? null) : null;
  if (field.type === 'text' && toKind)
    return textToItems(table, field, toKind, definition.multiple, tx);
  if (fromKind && definition.type === 'text') return itemsToText(table, field, fromKind, tx);
  return null;
}

/** Write {@link itemValueConversion}'s values into the retyped column. */
export async function writeItemValues(
  table: TableCatalogRow,
  columnName: string,
  list: boolean,
  values: ItemValues,
  tx: DbQueryable
): Promise<void> {
  if (!values.length) return;
  const column = quoteIdentifier(columnName);
  const value = list
    ? `ARRAY(SELECT element.value FROM jsonb_array_elements_text(kept.value) WITH ORDINALITY AS element(value, n) ORDER BY element.n)`
    : `kept.value #>> '{}'`;
  await tx.query(
    `UPDATE ONLY ${physicalTable(table)} AS entry SET ${column} = ${value}
       FROM jsonb_each($1::jsonb) AS kept(id, value)
      WHERE entry.id = kept.id::uuid`,
    [JSON.stringify(Object.fromEntries(values))]
  );
}
