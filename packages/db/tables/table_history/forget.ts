/**
 * Steps that can never apply again. A table or field dropped for good (the
 * Archived drawer's "delete forever", or a deleted item whose holding step
 * left the history) cannot come back, so any step that needs it can never be
 * undone or redone exactly, and as the newest step of a stack it would block
 * every step below it. Every drop removes those steps, of every actor and in
 * either state, in its own transaction; undo and redo also discard such a
 * step if they meet one (a table dropped by raw SQL, say).
 */
import type { DbQueryable } from '@snaglet/db/db';
import type { RawStep } from './record';
import type { HistoryActor, HistoryOp } from './types';

/**
 * Tables and fields a step's ops must find to apply. A hidden link (a
 * delete's cleared link in a retired column) is put back only while its
 * table exists, so it never makes a step impossible.
 */
export function stepTargets(ops: readonly HistoryOp[]): {
  tables: Set<string>;
  fields: Set<string>;
} {
  const tables = new Set<string>();
  const fields = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case 'entries':
        for (const row of op.rows) if (!row.hidden) tables.add(row.tableId);
        break;
      case 'field.state':
        tables.add(op.tableId);
        fields.add(op.fieldId);
        break;
      case 'field.definition':
        tables.add(op.tableId);
        fields.add(op.fieldId);
        for (const target of [op.before.referenceTableId, op.after.referenceTableId])
          if (target) tables.add(target);
        break;
      case 'field.order':
        tables.add(op.tableId);
        for (const id of [...op.before, ...op.after]) fields.add(id);
        break;
      case 'field.title':
        tables.add(op.tableId);
        for (const id of [op.before, op.after]) if (id) fields.add(id);
        break;
      case 'table.state':
      case 'table.name':
        tables.add(op.tableId);
        break;
      case 'repeat':
        tables.add(op.tableId);
        if (!op.cleanup) fields.add(op.fieldId);
        break;
    }
  }
  return { tables, fields };
}

/** What of `targets` no longer exists at all: gone for good, never to return. */
export async function missingTargets(
  targets: { tables: Set<string>; fields: Set<string> },
  tx: DbQueryable
): Promise<{ tables: string[]; fields: string[] }> {
  const tableIds = [...targets.tables];
  const fieldIds = [...targets.fields];
  const { rows: tables } = tableIds.length
    ? await tx.query<{ id: string }>(
        'SELECT id FROM public.table_catalog WHERE id = ANY($1::text[])',
        [tableIds]
      )
    : { rows: [] };
  const { rows: fields } = fieldIds.length
    ? await tx.query<{ id: string }>(
        'SELECT id FROM public.table_fields WHERE id = ANY($1::text[])',
        [fieldIds]
      )
    : { rows: [] };
  const foundTables = new Set(tables.map((row) => row.id));
  const foundFields = new Set(fields.map((row) => row.id));
  return {
    tables: tableIds.filter((id) => !foundTables.has(id)).sort(),
    fields: fieldIds.filter((id) => !foundFields.has(id)).sort(),
  };
}

/**
 * Remove every step (any actor, done or undone) that needs one of the
 * tables or fields this transaction dropped for good. Call it in the same
 * transaction, after the drop. Returns the stacks that changed, for
 * `table.history.changed`.
 */
export async function forgetDropped(
  dropped: {
    tables?: readonly string[];
    fields?: ReadonlyArray<{ tableId: string; fieldId: string }>;
  },
  tx: DbQueryable
): Promise<HistoryActor[]> {
  const tables = new Set(dropped.tables ?? []);
  const fields = new Set((dropped.fields ?? []).map((field) => field.fieldId));
  if (!tables.size && !fields.size) return [];
  // Candidates: steps on those tables (every op that needs a field names its
  // table too), and field edits whose relation targeted a dropped table.
  // Catalog ids hold no LIKE wildcards. Each candidate's ops decide.
  const owners = [...tables, ...(dropped.fields ?? []).map((field) => field.tableId)];
  const { rows } = await tx.query<Pick<RawStep, 'id' | 'actor_kind' | 'actor_id' | 'ops'>>(
    `SELECT id, actor_kind, actor_id, ops FROM public.table_history
      WHERE table_ids && $1::text[] OR ops::text LIKE ANY($2::text[])
      ORDER BY id FOR UPDATE`,
    [[...new Set(owners)], [...tables].map((id) => `%"${id}"%`)]
  );
  const doomed = rows.filter((row) => {
    const needs = stepTargets(row.ops);
    return (
      [...needs.tables].some((id) => tables.has(id)) ||
      [...needs.fields].some((id) => fields.has(id))
    );
  });
  if (!doomed.length) return [];
  await tx.query('DELETE FROM public.table_history WHERE id = ANY($1::text[])', [
    doomed.map((row) => row.id),
  ]);
  return uniqueActors(doomed.map((row) => ({ kind: row.actor_kind, id: row.actor_id })));
}

/** Each stack once, by kind and id. */
export function uniqueActors(actors: readonly HistoryActor[]): HistoryActor[] {
  const unique = new Map<string, HistoryActor>();
  for (const actor of actors)
    unique.set(`${actor.kind}:${actor.id}`, { kind: actor.kind, id: actor.id });
  return [...unique.values()];
}
