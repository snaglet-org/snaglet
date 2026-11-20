import type { DbQueryable } from '@snaglet/db/db';
import { entryBadRequest } from './entrySchema';
import { readEntryNames } from './entryNames';

/**
 * Chip targets found in written text values, each with the href it came
 * from (named in the 400 when it does not resolve).
 */
export interface EntryReferences {
  /** `entry:<tableId>/<entryId>`: an entry of a custom table. */
  entries: readonly { tableId: string; entryId: string; href: string }[];
  /** `table:<catalogId>`: any catalog table. */
  tables: readonly { tableId: string; href: string }[];
  /** Workspace node chips: a live `public.nodes` row of one of `types`. */
  nodes: readonly { id: string; types: readonly string[]; href: string }[];
}

function badReference(href: string, problem: string): Error {
  return entryBadRequest(`Bad reference (${href}): ${problem}`);
}

/**
 * Refuse chips whose target is missing: one query per referenced custom
 * table, one catalog query and one nodes query. Runs in the writing
 * transaction after its rows are written, so a chip may name an entry the
 * same batch inserts.
 */
export async function assertEntryReferences(
  references: EntryReferences,
  tx: DbQueryable
): Promise<void> {
  const idsByTable = new Map<string, Set<string>>();
  for (const ref of references.entries) {
    const ids = idsByTable.get(ref.tableId) ?? new Set<string>();
    ids.add(ref.entryId.toLowerCase());
    idsByTable.set(ref.tableId, ids);
  }
  const named = await readEntryNames(
    new Map([...idsByTable].map(([tableId, ids]) => [tableId, [...ids]])),
    tx
  );
  for (const ref of references.entries) {
    const table = named.get(ref.tableId);
    if (!table) throw badReference(ref.href, 'no such custom table.');
    if (!table.names.has(ref.entryId.toLowerCase()))
      throw badReference(ref.href, `no such entry in ${table.tableName}.`);
  }

  if (references.tables.length) {
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM public.table_catalog WHERE id = ANY($1::text[]) AND state = 'active'",
      [[...new Set(references.tables.map((ref) => ref.tableId))]]
    );
    const found = new Set(rows.map((row) => row.id));
    const missing = references.tables.find((ref) => !found.has(ref.tableId));
    if (missing) throw badReference(missing.href, 'no such table, or it is archived.');
  }

  if (references.nodes.length) {
    const { rows } = await tx.query<{ id: string; type: string }>(
      'SELECT id, type::text AS type FROM public.nodes WHERE id = ANY($1::text[]) AND NOT archived',
      [[...new Set(references.nodes.map((ref) => ref.id))]]
    );
    const types = new Map(rows.map((row) => [row.id, row.type]));
    for (const ref of references.nodes) {
      const type = types.get(ref.id);
      if (type === undefined) throw badReference(ref.href, 'no such item, or it is archived.');
      if (ref.types.length && !ref.types.includes(type))
        throw badReference(ref.href, `${ref.id} is a ${type}, not a ${ref.types.join(' or ')}.`);
    }
  }
}
