/**
 * Recording history steps. A mutation collects its ops in a
 * {@link HistoryJournal} and calls {@link recordStep} in its own transaction,
 * after its writes and before commit, so the step and the change commit (or
 * roll back) together. Recording takes the actor's stack lock last, after the
 * mutation's table locks, the same order undo and redo use.
 */
import { randomUUID } from 'node:crypto';
import type { DbQueryable } from '@snaglet/db/db';
import {
  TABLE_HISTORY_DEPTH,
  type TableHistoryActor,
  type TableHistoryStep,
  type TableHistoryStepKind,
} from '@snaglet/shared/types';
import type { HistoryActor, HistoryJournal, HistoryOp, HistoryStepSummary } from './types';

export function newJournal(): HistoryJournal {
  return { stepId: `tstep-${randomUUID()}`, ops: [] };
}

/** Serialize one actor's stack: recording, undo and redo. */
export async function lockActorStack(actor: HistoryActor, tx: DbQueryable): Promise<void> {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('snaglet.table_history:' || $1, 0))",
    [`${actor.kind}:${actor.id}`]
  );
}

export function opTableIds(ops: readonly HistoryOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op === 'entries') for (const row of op.rows) ids.add(row.tableId);
    else ids.add(op.tableId);
  }
  return [...ids].sort();
}

export interface RecordedStep {
  id: string;
  /** Steps dropped (redo branch discarded, or pruned past the depth); their deleted data can go. */
  released: number;
}

let purgeRequested = false;

/**
 * Whether a recorded step dropped older steps since the last call (clearing
 * the flag): the caller should then run `TableHistory.purgeReleased()` after
 * its commit. A request from a transaction that rolled back only costs an
 * empty sweep.
 */
export function takePurgeRequest(): boolean {
  const requested = purgeRequested;
  purgeRequested = false;
  return requested;
}

/**
 * Append the journal as the actor's newest step: the actor's undone steps
 * (its redo branch) are discarded first, and steps beyond the newest
 * {@link TABLE_HISTORY_DEPTH} are pruned. An empty journal records nothing.
 */
export async function recordStep(
  tx: DbQueryable,
  actor: HistoryActor,
  journal: HistoryJournal,
  summary: HistoryStepSummary
): Promise<RecordedStep | null> {
  if (!journal.ops.length) return null;
  await lockActorStack(actor, tx);
  const discarded = await tx.query(
    "DELETE FROM public.table_history WHERE actor_kind = $1 AND actor_id = $2 AND state = 'undone'",
    [actor.kind, actor.id]
  );
  const { rows } = await tx.query<{ seq: number | string }>(
    'SELECT COALESCE(max(seq), 0) + 1 AS seq FROM public.table_history WHERE actor_kind = $1 AND actor_id = $2',
    [actor.kind, actor.id]
  );
  const seq = Number(rows[0]?.seq ?? 1);
  await tx.query(
    `INSERT INTO public.table_history (id, actor_kind, actor_id, actor_name, seq, state, kind, label, table_ids, ops)
     VALUES ($1, $2, $3, $4, $5, 'done', $6, $7, $8::text[], $9::jsonb)`,
    [
      journal.stepId,
      actor.kind,
      actor.id,
      actor.name ?? null,
      seq,
      summary.kind,
      summary.label,
      opTableIds(journal.ops),
      JSON.stringify(journal.ops),
    ]
  );
  const pruned = await tx.query(
    'DELETE FROM public.table_history WHERE actor_kind = $1 AND actor_id = $2 AND seq <= $3',
    [actor.kind, actor.id, seq - TABLE_HISTORY_DEPTH]
  );
  const released = (discarded.rowCount ?? 0) + (pruned.rowCount ?? 0);
  if (released) purgeRequested = true;
  return { id: journal.stepId, released };
}

export interface RawStep {
  id: string;
  actor_kind: TableHistoryActor['kind'];
  actor_id: string;
  actor_name: string | null;
  seq: number | string;
  state: 'done' | 'undone';
  kind: TableHistoryStepKind;
  label: string;
  table_ids: string[];
  ops: HistoryOp[];
  created_at: string;
  updated_at: string;
}

export function toStep(raw: RawStep): TableHistoryStep {
  return {
    id: raw.id,
    actor: { kind: raw.actor_kind, id: raw.actor_id, name: raw.actor_name },
    kind: raw.kind,
    label: raw.label,
    tableIds: raw.table_ids,
    state: raw.state,
    seq: Number(raw.seq),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Labels for the history list; names are the ones current when recorded. */
export const stepLabels = {
  entryCreate: (table: string) => ({
    kind: 'entry.create' as const,
    label: `Add entry to ${table}`,
  }),
  entryUpdate: (table: string, fields: readonly string[]) => ({
    kind: 'entry.update' as const,
    label:
      fields.length === 1
        ? `Edit ${fields[0]} in ${table}`
        : `Edit ${plural(fields.length, 'field')} in ${table}`,
  }),
  /** A repeat op on one row: `action` is e.g. "Complete", "Skip", "Set repeat of". */
  entryRepeat: (table: string, field: string, action: string) => ({
    kind: 'entry.update' as const,
    label: `${action} ${field} in ${table}`,
  }),
  entryDelete: (table: string, count: number) => ({
    kind: 'entry.delete' as const,
    label: `Delete ${plural(count, 'entry', 'entries')} from ${table}`,
  }),
  entryWrite: (table: string, inserted: number, updated: number) => ({
    kind: 'entry.write' as const,
    label: [
      inserted ? `add ${plural(inserted, 'entry', 'entries')}` : '',
      updated ? `edit ${plural(updated, 'entry', 'entries')}` : '',
    ]
      .filter(Boolean)
      .join(' and ')
      .replace(/^./, (first) => first.toUpperCase())
      .concat(` in ${table}`),
  }),
  fieldCreate: (table: string, field: string) => ({
    kind: 'field.create' as const,
    label: `Add field ${field} to ${table}`,
  }),
  fieldUpdate: (table: string, field: string) => ({
    kind: 'field.update' as const,
    label: `Change field ${field} in ${table}`,
  }),
  fieldReorder: (table: string) => ({
    kind: 'field.reorder' as const,
    label: `Reorder fields in ${table}`,
  }),
  fieldArchive: (table: string, field: string) => ({
    kind: 'field.archive' as const,
    label: `Archive field ${field} in ${table}`,
  }),
  fieldRestore: (table: string, field: string) => ({
    kind: 'field.restore' as const,
    label: `Restore field ${field} in ${table}`,
  }),
  fieldDelete: (table: string, field: string) => ({
    kind: 'field.delete' as const,
    label: `Delete field ${field} from ${table}`,
  }),
  fieldTitle: (table: string, field: string) => ({
    kind: 'field.title' as const,
    label: `Make ${field} the Name field of ${table}`,
  }),
  tableCreate: (table: string) => ({
    kind: 'table.create' as const,
    label: `Create table ${table}`,
  }),
  tableRename: (from: string, to: string) => ({
    kind: 'table.rename' as const,
    label: `Rename table ${from} to ${to}`,
  }),
  tableArchive: (table: string) => ({
    kind: 'table.archive' as const,
    label: `Archive table ${table}`,
  }),
  tableRestore: (table: string) => ({
    kind: 'table.restore' as const,
    label: `Restore table ${table}`,
  }),
  projectTablesArchive: (container: string, count: number) => ({
    kind: 'table.archive' as const,
    label: `Archive ${plural(count, 'table')} with ${container}`,
  }),
  projectTablesRestore: (container: string, count: number) => ({
    kind: 'table.restore' as const,
    label: `Restore ${plural(count, 'table')} with ${container}`,
  }),
  tableDelete: (table: string) => ({
    kind: 'table.delete' as const,
    label: `Delete table ${table}`,
  }),
  tableSchema: (table: string, changes: number) => ({
    kind: 'table.schema' as const,
    label: `Change table ${table} (${plural(changes, 'change')})`,
  }),
} satisfies Record<string, (...args: never[]) => HistoryStepSummary>;
