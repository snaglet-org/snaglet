/**
 * Titles of Snaglet items that relation fields link to (docs, agents, …), by kind
 * and id, for chips outside the page's `relatedItems`: an item just chosen in
 * a picker or dropped as a chip, before the page reload names it. Page reads
 * refresh it and forget linked ids the page does not name (purged items),
 * so those read as unavailable.
 */
import type {
  RelatedTableItems,
  TableEntry,
  TableField,
  TableReferenceItem,
  TableReferenceKind,
} from '@snaglet/shared/types';

const items = new Map<string, TableReferenceItem>();

const key = (kind: TableReferenceKind, id: string) => `${kind}\u0000${id}`;

const has = (record: object, id: string) => Object.prototype.hasOwnProperty.call(record, id);

/** Remember one item's title (from a search result or a dropped chip). */
export function rememberItem(kind: TableReferenceKind, id: string, item: TableReferenceItem): void {
  items.set(key(kind, id), item);
}

/**
 * Adopt a page's `relatedItems`: every item it names is remembered, and every
 * id its entries link to that it leaves out (a purged item) is forgotten.
 */
export function syncRelatedItems(
  fields: readonly TableField[],
  entries: readonly TableEntry[],
  related: RelatedTableItems | undefined
): void {
  for (const field of fields) {
    const kind = field.type === 'relation' ? field.referenceKind : null;
    if (!kind) continue;
    const named = related?.[kind] ?? {};
    for (const entry of entries) {
      const value = entry.values[field.id];
      const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
      for (const id of ids) {
        const item = has(named, id) ? named[id] : undefined;
        if (item) items.set(key(kind, id), item);
        else items.delete(key(kind, id));
      }
    }
  }
}

/**
 * The item a chip shows: the page's `relatedItems` first, then what this
 * session learned since. Undefined means it is gone (unavailable).
 */
export function knownItem(
  kind: TableReferenceKind,
  id: string,
  related?: RelatedTableItems
): TableReferenceItem | undefined {
  const named = related?.[kind];
  if (named && has(named, id)) return named[id];
  return items.get(key(kind, id));
}

/** @public Test isolation. */
export function __resetSnagletItemTitlesForTests(): void {
  items.clear();
}
