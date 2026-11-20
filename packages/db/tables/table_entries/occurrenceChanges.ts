/**
 * What a write did to the occurrences of repeating rows, for the server's
 * `table_entry:occurrence` hook event. Every change is built
 * from a {@link RepeatOp} carrying its {@link OccurrenceTag}, inside the
 * write's transaction (so `ended` reads the state it leaves), and handed
 * back to the caller, which emits only after the commit.
 *
 * One op is one change: a Skip to upcoming that logs N skipped rows is one
 * change with `count: N`, never N changes. Undo of an op is its inverse (an
 * `undone` of the action, or the action again when the op was an undo), redo
 * is the op again.
 */
import type { DbQueryable } from '@snaglet/db/db';
import type { TableRepeat } from '@snaglet/shared/utils';
import type { OccurrenceAction, RepeatOp, StoredOccurrence } from '../table_history/types';
import { isFinished } from './repeats';

/** The actions an `undone` change can name. */
type UndoneOccurrenceAction = Exclude<OccurrenceAction, 'undone'>;

/**
 * One occurrence change. Wall times (`occurrence`, `lastOccurrence`,
 * `movedTo`, `current`) are local times without an offset, read in `tz`.
 * `current` and `ended` describe the repeat after the write.
 */
export interface OccurrenceChange {
  tableId: string;
  fieldId: string;
  entryId: string;
  action: OccurrenceAction;
  /** The occurrence acted on (a period's first day); the first one for a Skip to upcoming. */
  occurrence: string;
  /** The last occurrence covered: `occurrence` unless `count` > 1. */
  lastOccurrence: string;
  /** Occurrences covered: 1, or N for one Skip to upcoming (and its undo). */
  count: number;
  /** IANA zone of the wall times. */
  tz: string;
  /** moved: where it went; shifted: where `occurrence` went; null otherwise. */
  movedTo: string | null;
  /** undone: the action it took back. */
  undoneAction: UndoneOccurrenceAction | null;
  /** The log rows covered, in order; none for shifted, jumped and a move back to its slot. */
  logIds: string[];
  /** The occurrence the row is on after the write; null when it no longer repeats. */
  current: string | null;
  /** Whether the series has ended after the write (its last occurrence is done or skipped). */
  ended: boolean;
}

/** The action a log row records. */
function rowAction(row: StoredOccurrence): UndoneOccurrenceAction {
  return row.kind;
}

interface ChangeShape {
  action: OccurrenceAction;
  undoneAction: UndoneOccurrenceAction | null;
  rows: StoredOccurrence[];
  occurrence: string;
  movedTo: string | null;
}

/** The change `op` makes going forward (the action itself, or a redo of it). */
function forwardShape(op: RepeatOp): ChangeShape | null {
  const tag = op.occurrence;
  if (!tag || op.cleanup) return null;
  if (tag.from !== undefined)
    return {
      action: tag.action,
      undoneAction: null,
      rows: [],
      occurrence: tag.from,
      movedTo: tag.to ?? null,
    };
  if (tag.action === 'undone') {
    const row = op.removed[0];
    if (!row) return null;
    return {
      action: 'undone',
      undoneAction: rowAction(row),
      rows: [row],
      occurrence: row.occurrence,
      movedTo: row.movedTo,
    };
  }
  const first = op.added[0];
  if (!first) return null;
  return {
    action: tag.action,
    undoneAction: null,
    rows: op.added,
    occurrence: first.occurrence,
    movedTo: first.movedTo,
  };
}

/** Undo's change for `op`: what it did, taken back. */
function inverseShape(shape: ChangeShape): ChangeShape {
  if (shape.action !== 'undone') return { ...shape, action: 'undone', undoneAction: shape.action };
  // Undoing an undo puts the row back: the action it had undone, again.
  return shape.undoneAction ? { ...shape, action: shape.undoneAction, undoneAction: null } : shape;
}

/**
 * The change `op` made, as its write (`forward`, also a redo) or its undo
 * left things; null for an op that is no occurrence action. Reads the
 * occurrence's log in `tx` for `ended`, so call it after the op is applied,
 * in the same transaction.
 */
export async function occurrenceChange(
  tx: DbQueryable,
  op: RepeatOp,
  direction: 'forward' | 'undo'
): Promise<OccurrenceChange | null> {
  const forward = forwardShape(op);
  if (!forward) return null;
  const shape = direction === 'forward' ? forward : inverseShape(forward);
  const before = op.before as TableRepeat | null;
  const after = op.after as TableRepeat | null;
  const repeat = direction === 'forward' ? after : before;
  const tz = repeat?.tz ?? after?.tz ?? before?.tz;
  if (!tz) return null;
  const rows = shape.rows;
  const last = rows[rows.length - 1];
  return {
    tableId: op.tableId,
    fieldId: op.fieldId,
    entryId: op.entryId,
    action: shape.action,
    occurrence: shape.occurrence,
    lastOccurrence: last?.occurrence ?? shape.occurrence,
    count: Math.max(1, rows.length),
    tz,
    movedTo: shape.movedTo,
    undoneAction: shape.undoneAction,
    logIds: rows.map((row) => row.id),
    current: repeat?.current ?? null,
    ended: repeat ? await isFinished(tx, op.fieldId, op.entryId, repeat.current, repeat) : false,
  };
}

/** {@link occurrenceChange} for each op that is an occurrence action, in order. */
export async function occurrenceChanges(
  tx: DbQueryable,
  ops: readonly RepeatOp[],
  direction: 'forward' | 'undo'
): Promise<OccurrenceChange[]> {
  const changes: OccurrenceChange[] = [];
  for (const op of ops) {
    const change = await occurrenceChange(tx, op, direction);
    if (change) changes.push(change);
  }
  return changes;
}
