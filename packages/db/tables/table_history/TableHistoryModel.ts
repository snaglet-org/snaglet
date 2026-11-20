/**
 * Per-actor undo history for custom tables: list a stack, undo its newest
 * done step, redo its oldest undone one, and purge data whose deleting step
 * has left the history.
 *
 * Undo and redo are all or nothing and never overwrite: every op first checks
 * that what it touches is still exactly as the step left it (for undo) or
 * found it (for redo), and any difference is a 409 that changes nothing.
 * They lock every table the step touches (catalog rows FOR UPDATE, then the
 * physical tables ACCESS EXCLUSIVE, in id order), then the actor's stack,
 * the same order recording uses.
 */
import { getDb, transaction, type DbQueryable } from '@snaglet/db/db';
import {
  CUSTOM_TABLES_SCHEMA,
  TableCatalog,
  toTableCatalogEntry,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import {
  ErrorCode,
  TABLE_HISTORY_DEPTH,
  type TableCatalogEntry,
  type TableHistoryConflict,
  type TableHistoryConflictDetails,
  type TableHistoryStep,
} from '@snaglet/shared/types';
import { AppError, getErrorMessage, tableNameProblem } from '@snaglet/shared/utils';
import {
  findField,
  lockFieldOrder,
  toField,
  writeFieldOrder,
  type RawField,
} from '../table_fields/fieldRows';
import { columnType, physicalTable } from '../table_fields/fieldSchema';
import { putFieldRepeats, takeFieldRepeats } from '../table_fields/recurrence';
import {
  deleteOccurrences,
  insertOccurrences,
  readOccurrences,
  readRepeat,
  restoreEntryRepeats,
  sameRepeat,
  takeEntryRepeats,
  writeRepeat,
} from '../table_entries/repeats';
import { occurrenceChange, type OccurrenceChange } from '../table_entries/occurrenceChanges';
import { isLegacyQuotaRepeatOp } from './legacyQuota';
import type { TableRepeat } from '@snaglet/shared/utils';
import {
  columnMatches,
  currentTitleField,
  linkedFields,
  nameTaken,
  purgeField,
  purgeTable,
  restoreFieldDefinition,
  restoreRetiredField,
  restoreRetiredTable,
  retireField,
  retireTable,
  sameStoredDefinition,
  setTitleField,
  storedDefinition,
} from './lifecycle';
import { missingTargets, stepTargets, uniqueActors } from './forget';
import { lockActorStack, toStep, type RawStep } from './record';
import {
  columnsByKey,
  insertRows,
  rowExists,
  rowMatches,
  trackedColumns,
  updateCells,
  useCanonicalText,
  visibleLinksTo,
  type TrackedColumn,
} from './rows';
import type {
  EntriesOp,
  FieldDefinitionOp,
  FieldOrderOp,
  FieldStateOp,
  FieldTitleOp,
  HistoryActor,
  HistoryOp,
  RowChange,
  RepeatOp,
  StoredFieldDefinition,
  TableNameOp,
  TableStateOp,
} from './types';

export type HistoryDirection = 'undo' | 'redo';

/** What a step changed, so the caller can emit realtime events after commit. */
export interface StepEffects {
  /** Table id → changed entry ids. */
  entries: Map<string, Set<string>>;
  /** Tables whose fields (or their stored values) changed. */
  fields: Set<string>;
  /** Tables whose lifecycle or name changed, with their entry after the step. */
  tables: Map<string, { table: TableCatalogEntry; change: 'removed' | 'restored' | 'renamed' }>;
  /**
   * The occurrence actions the step undid (each as an `undone`, or the
   * action again for an undone undo) or redid, in the step's own order.
   */
  occurrences: OccurrenceChange[];
}

export interface StepOutcome {
  step: TableHistoryStep;
  undo: TableHistoryStep | null;
  redo: TableHistoryStep | null;
  effects: StepEffects;
}

/** A step undo or redo removed instead of applying: something it needs is gone for good. */
interface Discarded {
  discarded: TableHistoryStep;
  /** A table (not only a field) it needed was dropped. */
  tableGone: boolean;
}

/**
 * The 409 for a step removed from the history because a table or field it
 * needs was permanently deleted: nothing else changed, and the next press
 * reaches the step beyond it.
 */
function discardedStep(direction: HistoryDirection, { discarded, tableGone }: Discarded): AppError {
  const what = tableGone ? 'table' : 'field';
  const next =
    direction === 'undo'
      ? 'Press Undo again for the step before it.'
      : 'Press Redo again for the step after it.';
  return historyConflict(
    `That step's ${what} was permanently deleted, so it was removed from your history. ${next}`,
    { reason: 'discarded', step: discarded }
  );
}

export interface StackView {
  steps: TableHistoryStep[];
  undo: TableHistoryStep | null;
  redo: TableHistoryStep | null;
}

function historyConflict(message: string, details: TableHistoryConflictDetails): AppError {
  return new AppError(message, ErrorCode.CONFLICT, 409, true, details);
}

class StepConflict extends Error {
  constructor(readonly conflict: TableHistoryConflict) {
    super(conflict.message);
  }
}

function conflictOf(
  kind: TableHistoryConflict['kind'],
  tableId: string,
  id: string,
  message: string
): StepConflict {
  return new StepConflict({ kind, tableId, id, message });
}

interface ApplyContext {
  tx: DbQueryable;
  stepId: string;
  direction: HistoryDirection;
  names: Readonly<Record<string, string>>;
  tables: Map<string, TableCatalogRow>;
  effects: StepEffects;
  /**
   * Field revisions set by ops already applied in this undo or redo. A later
   * op on the same field expects these instead of what it recorded, so
   * several ops on one field in one step (an agent batch) chain.
   */
  revisions: Map<string, number>;
}

function sides<T>(ctx: ApplyContext, before: T, after: T): { from: T; to: T } {
  return ctx.direction === 'undo' ? { from: after, to: before } : { from: before, to: after };
}

function tableLabel(ctx: ApplyContext, tableId: string): string {
  return ctx.tables.get(tableId)?.name ?? 'the table';
}

function markEntries(ctx: ApplyContext, tableId: string, ids: Iterable<string>): void {
  const set = ctx.effects.entries.get(tableId) ?? new Set<string>();
  for (const id of ids) set.add(id);
  ctx.effects.entries.set(tableId, set);
}

function markTable(
  ctx: ApplyContext,
  row: TableCatalogRow,
  change: 'removed' | 'restored' | 'renamed'
): void {
  ctx.tables.set(row.id, row);
  ctx.effects.tables.set(row.id, { table: toTableCatalogEntry(row), change });
}

async function applyEntries(ctx: ApplyContext, op: EntriesOp): Promise<void> {
  const { tx } = ctx;
  const columns = new Map<string, Map<string, TrackedColumn>>();
  const skipped = new Set<RowChange>();
  const tableOf = (change: RowChange) => ctx.tables.get(change.tableId);
  for (const tableId of [...new Set(op.rows.map((row) => row.tableId))].sort()) {
    const table = ctx.tables.get(tableId);
    const visible = op.rows.filter((row) => row.tableId === tableId && !row.hidden);
    if (!table || (table.state !== 'active' && visible.length)) {
      if (visible.length)
        throw conflictOf(
          'table',
          tableId,
          tableId,
          !table
            ? 'The table these entries were in no longer exists.'
            : `${table.name} is ${table.state === 'archived' ? 'archived' : 'deleted'}. Restore it first.`
        );
      // Hidden links into a table that has been dropped since: nothing to put back.
      for (const row of op.rows) if (row.tableId === tableId) skipped.add(row);
      continue;
    }
    const now = columnsByKey(await trackedColumns(table, tx));
    columns.set(tableId, now);
    for (const [key, recorded] of Object.entries(op.columns[tableId] ?? {})) {
      const current = now.get(key);
      if (!current || current.sqlType === recorded) continue;
      if (visible.length)
        throw conflictOf(
          'field',
          tableId,
          key,
          `A field of ${table.name} changed type since, so these values no longer fit.`
        );
      for (const row of op.rows) if (row.tableId === tableId) skipped.add(row);
    }
  }
  for (const change of op.rows) {
    if (skipped.has(change)) continue;
    const table = tableOf(change);
    const now = columns.get(change.tableId);
    if (!table || !now) continue;
    const { from } = sides(ctx, change.before, change.after);
    const ok =
      from === null
        ? !(await rowExists(table, change.id, tx))
        : await rowMatches(table, now, change.id, from, tx);
    if (ok) continue;
    if (change.hidden) {
      skipped.add(change);
      continue;
    }
    throw conflictOf(
      'entry',
      change.tableId,
      change.id,
      from === null
        ? `An entry of ${table.name} with this id exists again.`
        : `An entry of ${table.name} changed since. Undo refuses to overwrite it.`
    );
  }
  const live = op.rows.filter((change) => !skipped.has(change));
  const inserts = new Map<string, Array<{ id: string; cells: Record<string, string | null> }>>();
  const deletes = new Map<string, string[]>();
  for (const change of live) {
    const { from, to } = sides(ctx, change.before, change.after);
    if (from === null && to !== null)
      inserts.set(change.tableId, [
        ...(inserts.get(change.tableId) ?? []),
        { id: change.id, cells: to },
      ]);
    else if (from !== null && to === null)
      deletes.set(change.tableId, [...(deletes.get(change.tableId) ?? []), change.id]);
  }
  for (const [tableId, rows] of inserts) {
    const table = ctx.tables.get(tableId);
    const now = columns.get(tableId);
    if (table && now) await insertRows(table, now, rows, tx);
  }
  for (const change of live) {
    const { from, to } = sides(ctx, change.before, change.after);
    const table = tableOf(change);
    const now = columns.get(change.tableId);
    if (from !== null && to !== null && table && now)
      await updateCells(table, now, change.id, to, tx);
  }
  const removing = new Set(
    [...deletes].flatMap(([tableId, ids]) => ids.map((id) => `${tableId}/${id}`))
  );
  for (const [tableId, ids] of deletes) {
    const table = ctx.tables.get(tableId);
    if (!table) continue;
    const links = await visibleLinksTo(tableId, ids, removing, tx);
    const first = links[0];
    if (first)
      throw conflictOf(
        'entry',
        tableId,
        first.entryId,
        `${links.length === 1 ? 'Another entry links' : `${links.length} other entries link`} to ${ids.length === 1 ? 'this entry' : 'these entries'} now. Remove those links first.`
      );
    await tx.query(`DELETE FROM ONLY ${physicalTable(table)} WHERE id = ANY($1::uuid[])`, [ids]);
    // A repeat never outlives its row (an undone create, a redone delete).
    await takeEntryRepeats(tx, tableId, ids);
  }
  for (const change of live) if (!change.hidden) markEntries(ctx, change.tableId, [change.id]);
}

function requireTable(ctx: ApplyContext, tableId: string): TableCatalogRow {
  const table = ctx.tables.get(tableId);
  if (!table) throw conflictOf('table', tableId, tableId, 'The table no longer exists.');
  return table;
}

function requestedName(ctx: ApplyContext, id: string, kind: 'table' | 'field'): string | undefined {
  const name = ctx.names[id];
  if (name === undefined) return undefined;
  const problem = tableNameProblem(name, kind);
  if (problem) throw new AppError(problem, ErrorCode.VALIDATION_ERROR, 400);
  return name.trim();
}

/**
 * Whether an active field is still as an op left it (undo) or found it
 * (redo), like an entry op's cells. A later op on the field in this same undo
 * or redo follows the revision the earlier op set. Otherwise the op's own
 * revision proves it when nothing changed the field since the op last ran;
 * failing that, its stored definition decides: undoing and redoing the
 * actor's other steps on the field moves the revision without changing what
 * the field is, so a chain of steps on one field undoes and redoes one after
 * another, while anyone else's edit differs and is refused.
 */
function fieldIsAsRecorded(
  ctx: ApplyContext,
  raw: RawField,
  revision: number | null,
  definition: StoredFieldDefinition | undefined
): boolean {
  const chained = ctx.revisions.get(raw.id);
  if (chained !== undefined) return raw.revision === chained;
  if (raw.revision === revision) return true;
  if (definition) return sameStoredDefinition(storedDefinition(toField(raw)), definition);
  // A field.state op recorded before definitions were kept: its revision alone decides.
  return revision === null;
}

async function applyFieldState(ctx: ApplyContext, op: FieldStateOp): Promise<void> {
  const { from, to } = sides(ctx, op.before, op.after);
  const table = requireTable(ctx, op.tableId);
  const raw = await findField(op.fieldId, ctx.tx);
  const gone = conflictOf(
    'field',
    op.tableId,
    op.fieldId,
    `The field ${op.name} no longer exists: it was permanently deleted.`
  );
  if (!raw || raw.table_id !== op.tableId) throw gone;
  const unchanged =
    raw.state === from &&
    (from !== 'deleted' || raw.held_by === ctx.stepId) &&
    (from !== 'active' || fieldIsAsRecorded(ctx, raw, op.revision, op.definition));
  if (!unchanged)
    throw conflictOf(
      'field',
      op.tableId,
      op.fieldId,
      raw.state === 'active'
        ? `The field ${raw.name} changed since.`
        : `The field ${op.name} was ${raw.state} since.`
    );
  if (to === 'active') {
    const restored = await restoreRetiredField(
      table,
      op.fieldId,
      requestedName(ctx, op.fieldId, 'field'),
      ctx.tx
    );
    op.name = restored.field.name;
    op.revision = restored.field.revision;
    op.definition = storedDefinition(restored.field);
    ctx.revisions.set(op.fieldId, restored.field.revision);
  } else {
    await retireField(table, op.fieldId, to, to === 'deleted' ? ctx.stepId : null, ctx.tx);
    op.revision = raw.revision;
    if (from === 'active') op.definition = storedDefinition(toField(raw));
    ctx.revisions.set(op.fieldId, raw.revision);
  }
  ctx.effects.fields.add(op.tableId);
}

async function applyFieldDefinition(ctx: ApplyContext, op: FieldDefinitionOp): Promise<void> {
  const sidesOf = sides(ctx, op.before, op.after);
  const table = requireTable(ctx, op.tableId);
  const raw = await findField(op.fieldId, ctx.tx);
  if (
    !raw ||
    raw.table_id !== op.tableId ||
    raw.state !== 'active' ||
    !fieldIsAsRecorded(ctx, raw, op.revision, sidesOf.from)
  )
    throw conflictOf(
      'field',
      op.tableId,
      op.fieldId,
      raw && raw.state === 'active'
        ? `The field ${raw.name} changed since.`
        : `The field ${sidesOf.from.name} is no longer in ${table.name}.`
    );
  // A calendar binding is not part of the step (it moves on its own), but
  // only a date or datetime field can carry one.
  const { type } = sidesOf.to;
  if (raw.calendar_id && type !== 'date' && type !== 'datetime')
    throw conflictOf(
      'field',
      op.tableId,
      op.fieldId,
      `The field ${raw.name} is on a calendar now, so it cannot change to ${type}. Take it off the calendar first.`
    );
  let values = null;
  if (op.values) {
    const { from, to } = sides(ctx, op.values.before, op.values.after);
    const current = {
      type: raw.type,
      multiple: raw.multiple,
      referenceKind: raw.reference_kind,
      range: raw.is_range,
    };
    if (!(await columnMatches(table, raw.column_name, columnType(current), from, ctx.tx)))
      throw conflictOf(
        'field',
        op.tableId,
        op.fieldId,
        `Entries of ${table.name} changed ${raw.name} (or were added or deleted) since, so its old values cannot be put back exactly.`
      );
    values = to;
  }
  const rename = requestedName(ctx, op.fieldId, 'field');
  const target = rename ? { ...sidesOf.to, name: rename } : sidesOf.to;
  const updated = await restoreFieldDefinition(table, op.fieldId, target, values, ctx.tx);
  // Rows' repeats exist only while the field repeats, and hold wall times of
  // its type. Moving to a side without a setting takes them into the step;
  // moving back puts them back (either side may be the one without). A
  // repeating field that changes type between the sides takes them the same
  // way: the step holds them while the field has the other type.
  if (raw.recurrence && !target.recurrence) op.repeats = await takeFieldRepeats(op.fieldId, ctx.tx);
  else if (!raw.recurrence && target.recurrence && op.repeats) {
    await putFieldRepeats(table.id, physicalTable(table), op.fieldId, op.repeats, ctx.tx);
    delete op.repeats;
  } else if (raw.recurrence && target.recurrence && raw.type !== target.type) {
    if (op.repeats) {
      await putFieldRepeats(table.id, physicalTable(table), op.fieldId, op.repeats, ctx.tx);
      delete op.repeats;
    } else op.repeats = await takeFieldRepeats(op.fieldId, ctx.tx);
  }
  if (rename) sidesOf.to.name = rename;
  op.revision = updated.revision;
  ctx.revisions.set(op.fieldId, updated.revision);
  ctx.effects.fields.add(op.tableId);
}

async function applyFieldOrder(ctx: ApplyContext, op: FieldOrderOp): Promise<void> {
  const { from, to } = sides(ctx, op.before, op.after);
  requireTable(ctx, op.tableId);
  const current = await lockFieldOrder(op.tableId, ctx.tx);
  if (current.length !== from.length || current.some((id, index) => id !== from[index]))
    throw conflictOf(
      'order',
      op.tableId,
      op.tableId,
      `The fields of ${tableLabel(ctx, op.tableId)} were reordered, added or removed since.`
    );
  await writeFieldOrder(op.tableId, to, ctx.tx);
  ctx.effects.fields.add(op.tableId);
}

async function applyFieldTitle(ctx: ApplyContext, op: FieldTitleOp): Promise<void> {
  const { from, to } = sides(ctx, op.before, op.after);
  requireTable(ctx, op.tableId);
  if ((await currentTitleField(op.tableId, ctx.tx)) !== from)
    throw conflictOf(
      'title',
      op.tableId,
      op.tableId,
      `The Name field of ${tableLabel(ctx, op.tableId)} changed since.`
    );
  try {
    await setTitleField(op.tableId, to, ctx.tx);
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500)
      throw conflictOf(
        'title',
        op.tableId,
        to ?? op.tableId,
        `That field can no longer be the Name field of ${tableLabel(ctx, op.tableId)}.`
      );
    throw error;
  }
  ctx.effects.fields.add(op.tableId);
}

async function applyTableState(ctx: ApplyContext, op: TableStateOp): Promise<void> {
  const { from, to } = sides(ctx, op.before, op.after);
  const row = ctx.tables.get(op.tableId);
  if (!row)
    throw conflictOf(
      'table',
      op.tableId,
      op.tableId,
      `The table ${op.name} no longer exists: it was permanently deleted.`
    );
  if (row.state !== from || (from === 'deleted' && row.heldBy !== ctx.stepId))
    throw conflictOf(
      'table',
      op.tableId,
      op.tableId,
      `The table ${row.name} was ${row.state === 'active' ? 'restored' : row.state} since.`
    );
  if (to === 'active') {
    const restored = await restoreRetiredTable(
      row,
      requestedName(ctx, op.tableId, 'table'),
      ctx.tx
    );
    op.name = restored.name;
    markTable(ctx, restored, 'restored');
    return;
  }
  if (to === 'deleted') {
    const linked = await linkedFields(op.tableId, ctx.tx);
    const first = linked[0];
    if (first)
      throw conflictOf(
        'table',
        op.tableId,
        op.tableId,
        `Other tables link to ${row.name} now (${linked
          .map((field) => `${field.tableName}.${field.fieldName}`)
          .join(', ')}). Remove those relation fields first.`
      );
  }
  const retired = await retireTable(row, to, to === 'deleted' ? ctx.stepId : null, ctx.tx);
  markTable(ctx, retired, 'removed');
}

async function applyTableName(ctx: ApplyContext, op: TableNameOp): Promise<void> {
  const { from, to } = sides(ctx, op.before, op.after);
  const row = requireTable(ctx, op.tableId);
  if (row.state !== 'active' || row.name !== from)
    throw conflictOf(
      'table',
      op.tableId,
      op.tableId,
      row.state !== 'active'
        ? `${row.name} is ${row.state}. Restore it first.`
        : `The table was renamed to ${row.name} since.`
    );
  const rename = requestedName(ctx, op.tableId, 'table');
  const next = rename ?? to;
  const { rows: taken } = await ctx.tx.query<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM public.table_catalog
                     WHERE state = 'active' AND lower(name) = lower($1) AND id <> $2)
         OR (lower($1) <> lower($3) AND to_regclass(format('%I.%I', $4::text, $1::text)) IS NOT NULL) AS taken`,
    [next, op.tableId, row.name, CUSTOM_TABLES_SCHEMA]
  );
  if (taken[0]?.taken)
    throw nameTaken([{ kind: 'table', id: op.tableId, tableId: op.tableId, name: next }]);
  const renamed = await TableCatalog.renameCustom(op.tableId, next, from, ctx.tx);
  if (!renamed) throw conflictOf('table', op.tableId, op.tableId, 'The table changed since.');
  if (rename) {
    if (ctx.direction === 'undo') op.before = rename;
    else op.after = rename;
  }
  markTable(ctx, renamed, 'renamed');
}

async function applyOp(ctx: ApplyContext, op: HistoryOp): Promise<void> {
  switch (op.op) {
    case 'entries':
      return applyEntries(ctx, op);
    case 'field.state':
      return applyFieldState(ctx, op);
    case 'field.definition':
      return applyFieldDefinition(ctx, op);
    case 'field.order':
      return applyFieldOrder(ctx, op);
    case 'field.title':
      return applyFieldTitle(ctx, op);
    case 'table.state':
      return applyTableState(ctx, op);
    case 'table.name':
      return applyTableName(ctx, op);
    case 'repeat':
      return applyRepeat(ctx, op);
  }
}

/**
 * A row's repeat and its log rows. Checks that the repeat is still what
 * the step left (undo) or found (redo), that the log rows it added are still
 * there and the ones it removed are still gone; then swaps them. A cleanup
 * op (an entry delete's) whose field is gone for good is skipped, and so is
 * a journaled quota op (see `legacyQuota.ts`).
 */
async function applyRepeat(ctx: ApplyContext, op: RepeatOp): Promise<void> {
  if (isLegacyQuotaRepeatOp(op)) return;
  const { tx } = ctx;
  const { from, to } = sides(ctx, op.before, op.after);
  const present = ctx.direction === 'undo' ? op.added : op.removed;
  const absent = ctx.direction === 'undo' ? op.removed : op.added;
  if (op.cleanup) {
    // An entry delete's: the row's own op decides; this only follows it.
    if (ctx.direction === 'redo') {
      await writeRepeat(tx, op.tableId, op.fieldId, op.entryId, null);
      await deleteOccurrences(
        tx,
        op.removed.map((row) => row.id)
      );
    } else
      await restoreEntryRepeats(tx, {
        repeats:
          op.before === null
            ? []
            : [
                {
                  tableId: op.tableId,
                  fieldId: op.fieldId,
                  entryId: op.entryId,
                  value: op.before as TableRepeat,
                },
              ],
        log: op.removed,
      });
    return;
  }
  requireTable(ctx, op.tableId);
  const conflict = (message: string) => conflictOf('entry', op.tableId, op.entryId, message);
  const current = await readRepeat(tx, op.fieldId, op.entryId, true);
  if (!sameRepeat(current, (from as TableRepeat | null) ?? null))
    throw conflict(`This entry's repeat changed since.`);
  const found = await readOccurrences(
    tx,
    [...present, ...absent].map((row) => row.id),
    true
  );
  const foundIds = new Map(found.map((row) => [row.id, row]));
  for (const row of present) {
    const now = foundIds.get(row.id);
    if (
      !now ||
      now.occurrence !== row.occurrence ||
      now.kind !== row.kind ||
      now.movedTo !== row.movedTo
    )
      throw conflict(`This entry's repeat history changed since.`);
  }
  if (absent.some((row) => foundIds.has(row.id)))
    throw conflict(`This entry's repeat history changed since.`);
  await deleteOccurrences(
    tx,
    present.map((row) => row.id)
  );
  try {
    await insertOccurrences(tx, absent);
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw conflict(`That occurrence was completed or skipped again since.`);
    throw error;
  }
  await writeRepeat(tx, op.tableId, op.fieldId, op.entryId, (to as TableRepeat | null) ?? null);
  markEntries(ctx, op.tableId, [op.entryId]);
  const change = await occurrenceChange(tx, op, ctx.direction === 'undo' ? 'undo' : 'forward');
  if (change) ctx.effects.occurrences.push(change);
}

/** Every table a step's ops read or write, relation targets included. */
function lockSet(ops: readonly HistoryOp[]): string[] {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.op === 'entries') for (const row of op.rows) ids.add(row.tableId);
    else ids.add(op.tableId);
    if (op.op === 'field.definition')
      for (const target of [op.before.referenceTableId, op.after.referenceTableId])
        if (target) ids.add(target);
  }
  return [...ids].sort();
}

/**
 * Lock catalog rows FOR UPDATE, then the physical tables (tombstones
 * included) ACCESS EXCLUSIVE, both in id order. Missing ids are left out.
 */
export async function lockHistoryTables(
  ids: readonly string[],
  tx: DbQueryable
): Promise<Map<string, TableCatalogRow>> {
  await tx.query('SET LOCAL lock_timeout = 5000');
  await tx.query('SET LOCAL statement_timeout = 15000');
  await useCanonicalText(tx);
  const sorted = [...new Set(ids)].sort();
  await tx.query(
    'SELECT id FROM public.table_catalog WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
    [sorted]
  );
  const tables = new Map<string, TableCatalogRow>();
  for (const id of sorted) {
    const row = await TableCatalog.findById(id, tx);
    if (row && row.origin === 'custom') tables.set(id, row);
  }
  const physical: string[] = [];
  for (const row of tables.values()) {
    const { rows } = await tx.query<{ found: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS found',
      [physicalTable(row)]
    );
    if (rows[0]?.found) physical.push(physicalTable(row));
  }
  if (physical.length) await tx.query(`LOCK TABLE ${physical.join(', ')} IN ACCESS EXCLUSIVE MODE`);
  return tables;
}

const STEP_COLUMNS =
  'id, actor_kind, actor_id, actor_name, seq, state, kind, label, table_ids, ops, created_at, updated_at';

async function nextStep(
  actor: HistoryActor,
  direction: HistoryDirection,
  tx: DbQueryable,
  lock = false
): Promise<RawStep | null> {
  const { rows } = await tx.query<RawStep>(
    `SELECT ${STEP_COLUMNS} FROM public.table_history
      WHERE actor_kind = $1 AND actor_id = $2 AND state = $3
      ORDER BY seq ${direction === 'undo' ? 'DESC' : 'ASC'} LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [actor.kind, actor.id, direction === 'undo' ? 'done' : 'undone']
  );
  return rows[0] ?? null;
}

function mapStepError(error: unknown): unknown {
  if (error instanceof StepConflict)
    return historyConflict(error.message, { reason: 'conflict', conflicts: [error.conflict] });
  if (error instanceof AppError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case '55P03':
    case '57014':
    case '40P01':
      return historyConflict('The tables are busy. Nothing was changed; try again.', {
        reason: 'conflict',
        conflicts: [],
      });
    case '23502':
    case '23503':
    case '23505':
    case '23514':
    case '22P02':
    case '42P01':
    case '42703':
    case '42701':
    case '42P07':
      return historyConflict(
        `The tables changed since in a way this step cannot reverse exactly. Nothing was changed. (${getErrorMessage(error)})`,
        { reason: 'conflict', conflicts: [] }
      );
    default:
      return error;
  }
}

class TableHistoryModelClass {
  /** One actor's stack, newest first, with the steps undo and redo would take next. */
  async stack(actor: HistoryActor, limit = TABLE_HISTORY_DEPTH): Promise<StackView> {
    return transaction(async (tx) => {
      const { rows } = await tx.query<RawStep>(
        `SELECT ${STEP_COLUMNS} FROM public.table_history
          WHERE actor_kind = $1 AND actor_id = $2 ORDER BY seq DESC LIMIT $3`,
        [actor.kind, actor.id, limit]
      );
      const undo = await nextStep(actor, 'undo', tx);
      const redo = await nextStep(actor, 'redo', tx);
      return {
        steps: rows.map(toStep),
        undo: undo && toStep(undo),
        redo: redo && toStep(redo),
      };
    });
  }

  /** The newest steps of every actor (recorded, undone or redone last), newest first. */
  async recent(limit = TABLE_HISTORY_DEPTH, tableId?: string): Promise<TableHistoryStep[]> {
    const { rows } = await getDb().query<RawStep>(
      `SELECT ${STEP_COLUMNS} FROM public.table_history
          ${tableId ? 'WHERE $2 = ANY(table_ids)' : ''}
          ORDER BY updated_at DESC, id LIMIT $1`,
      tableId ? [limit, tableId] : [limit]
    );
    return rows.map(toStep);
  }

  /**
   * Undo the actor's newest done step, or redo its oldest undone one. When
   * `stepId` is given it must be that step (409 `stale` otherwise). `names`
   * renames restored fields or tables whose name is taken now. A step that
   * needs a table or field that no longer exists at all can never apply: it
   * is removed (nothing else changes) and the answer is a 409 `discarded`.
   */
  async step(
    actor: HistoryActor,
    direction: HistoryDirection,
    opts: { stepId?: string; names?: Record<string, string> } = {}
  ): Promise<StepOutcome> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const peek = await nextStep(actor, direction, getDb());
      if (!peek)
        throw historyConflict(
          direction === 'undo' ? 'There is nothing to undo.' : 'There is nothing to redo.',
          { reason: 'empty', step: null }
        );
      if (opts.stepId !== undefined && opts.stepId !== peek.id)
        throw historyConflict(
          `The history changed: the next step to ${direction} is now "${peek.label}".`,
          { reason: 'stale', step: toStep(peek) }
        );
      try {
        const outcome = await transaction<StepOutcome | Discarded | null>(async (tx) => {
          const tables = await lockHistoryTables(lockSet(peek.ops), tx);
          await lockActorStack(actor, tx);
          const current = await nextStep(actor, direction, tx, true);
          // The lock set came from the peeked step; another step now means retry.
          if (!current || current.id !== peek.id) return null;
          const gone = await missingTargets(stepTargets(current.ops), tx);
          if (gone.tables.length || gone.fields.length) {
            await tx.query('DELETE FROM public.table_history WHERE id = $1', [current.id]);
            return { discarded: toStep(current), tableGone: gone.tables.length > 0 };
          }
          const effects: StepEffects = {
            entries: new Map(),
            fields: new Set(),
            tables: new Map(),
            occurrences: [],
          };
          const ctx: ApplyContext = {
            tx,
            stepId: current.id,
            direction,
            names: opts.names ?? {},
            tables,
            effects,
            revisions: new Map(),
          };
          const ops = current.ops;
          const ordered = direction === 'undo' ? [...ops].reverse() : ops;
          for (const op of ordered) await applyOp(ctx, op);
          // Undo applies the ops last first; its events keep the step's order.
          if (direction === 'undo') effects.occurrences.reverse();
          const { rows } = await tx.query<RawStep>(
            `UPDATE public.table_history SET state = $2, ops = $3::jsonb, updated_at = clock_timestamp()
              WHERE id = $1 RETURNING ${STEP_COLUMNS}`,
            [current.id, direction === 'undo' ? 'undone' : 'done', JSON.stringify(ops)]
          );
          const updated = rows[0];
          if (!updated) throw new Error('History step is missing');
          const undo = await nextStep(actor, 'undo', tx);
          const redo = await nextStep(actor, 'redo', tx);
          return {
            step: toStep(updated),
            undo: undo && toStep(undo),
            redo: redo && toStep(redo),
            effects,
          };
        });
        if (outcome && 'discarded' in outcome) throw discardedStep(direction, outcome);
        if (outcome) return outcome;
      } catch (error) {
        throw mapStepError(error);
      }
    }
    throw historyConflict('The history is changing too quickly. Nothing was changed; try again.', {
      reason: 'stale',
    });
  }

  /**
   * Drop, for good, every deleted table and field whose holding step has left
   * the history (pruned past the depth or discarded from a redo branch), with
   * the other steps that needed it. Each is dropped in its own transaction
   * under the schema locks; failures are returned and retried by the next
   * sweep. `actors` are the stacks that lost steps.
   */
  async purgeReleased(): Promise<{
    tables: string[];
    fields: string[];
    errors: string[];
    actors: HistoryActor[];
  }> {
    const db = getDb();
    const released = `NOT EXISTS (SELECT 1 FROM public.table_history AS step WHERE step.id = item.held_by)`;
    const { rows: tables } = await db.query<{ id: string }>(
      `SELECT item.id FROM public.table_catalog AS item WHERE item.state = 'deleted' AND ${released} ORDER BY item.id`
    );
    const { rows: fields } = await db.query<{ id: string; table_id: string }>(
      `SELECT item.id, item.table_id FROM public.table_fields AS item
         JOIN public.table_catalog AS catalog ON catalog.id = item.table_id
        WHERE item.state = 'deleted' AND ${released}
          AND NOT (catalog.state = 'deleted' AND NOT EXISTS (SELECT 1 FROM public.table_history AS step WHERE step.id = catalog.held_by))
        ORDER BY item.id`
    );
    const result = { tables: [] as string[], fields: [] as string[], errors: [] as string[] };
    const actors: HistoryActor[] = [];
    for (const { id } of tables) {
      try {
        const purged = await transaction(async (tx) => {
          const row = (await lockHistoryTables([id], tx)).get(id);
          if (!row || row.state !== 'deleted' || !row.heldBy) return false;
          const { rows } = await tx.query<{ held: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM public.table_history WHERE id = $1) AS held',
            [row.heldBy]
          );
          if (rows[0]?.held) return false;
          actors.push(...(await purgeTable(row, tx)));
          return true;
        });
        if (purged) result.tables.push(id);
      } catch (error) {
        result.errors.push(`table ${id}: ${getErrorMessage(error)}`);
      }
    }
    for (const field of fields) {
      try {
        const purged = await transaction(async (tx) => {
          const table = (await lockHistoryTables([field.table_id], tx)).get(field.table_id);
          const raw = await findField(field.id, tx);
          if (!table || !raw || raw.state !== 'deleted' || !raw.held_by) return false;
          const { rows } = await tx.query<{ held: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM public.table_history WHERE id = $1) AS held',
            [raw.held_by]
          );
          if (rows[0]?.held) return false;
          actors.push(...(await purgeField(table, field.id, tx)));
          return true;
        });
        if (purged) result.fields.push(field.id);
      } catch (error) {
        result.errors.push(`field ${field.id}: ${getErrorMessage(error)}`);
      }
    }
    return { ...result, actors: uniqueActors(actors) };
  }
}

export const TableHistory = new TableHistoryModelClass();
