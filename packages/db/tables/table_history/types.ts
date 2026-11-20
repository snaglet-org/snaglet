/**
 * The reversible operations one history step stores (`table_history.ops`).
 * Each describes the exact state before and after, so the same code applies
 * it in either direction: undo moves every op from `after` back to `before`
 * (last op first), redo from `before` to `after`. Nothing here crosses the
 * wire; clients see only the step summary (`TableHistoryStep`).
 */
import type {
  TableFieldDefault,
  TableFieldRecurrence,
  TableFieldType,
  TableHistoryActorKind,
  TableHistoryStepKind,
  TableLifecycleState,
  TableReferenceKind,
  TableSelectOption,
} from '@snaglet/shared/types';

/** A row's cells as PostgreSQL text casts (exact), keyed by field id or {@link POSITION_KEY}. */
export type Cells = Record<string, string | null>;

/** Cells key of the system row-order column, which is never a field. */
export const POSITION_KEY = '$position';

/** One row's change: `before` null = the row did not exist, `after` null = it was deleted. */
export interface RowChange {
  tableId: string;
  id: string;
  before: Cells | null;
  after: Cells | null;
  /**
   * A link a delete's foreign key cleared in a hidden column (a retired field
   * or table). Put back only while it is still as the step left it; never a
   * conflict, since nobody can see or edit it.
   */
  hidden?: boolean;
}

export interface EntriesOp {
  op: 'entries';
  /** Per table, each recorded key's physical type (`format_type`) when recorded. */
  columns: Record<string, Record<string, string>>;
  rows: RowChange[];
}

/**
 * A field's lifecycle move. A create is `deleted` → `active` (its undo
 * deletes the field, held by the step, so redo can bring it back).
 */
export interface FieldStateOp {
  op: 'field.state';
  tableId: string;
  fieldId: string;
  /** The field's name when recorded, for messages. */
  name: string;
  before: TableLifecycleState;
  after: TableLifecycleState;
  /** The field's revision while the op leaves it active (updated on each apply). */
  revision: number | null;
  /**
   * The field's definition on the op's active side (updated on each apply),
   * so undo and redo can tell the field is unchanged once other steps moved
   * its revision. Absent for moves between archived and deleted, and in
   * steps recorded before it existed (their revision alone decides).
   */
  definition?: StoredFieldDefinition;
}

/** Everything a field edit can change, in stored form. */
export interface StoredFieldDefinition {
  name: string;
  description: string | null;
  type: TableFieldType;
  nullable: boolean;
  defaultValue: TableFieldDefault;
  referenceTableId: string | null;
  /** Absent in steps recorded before Snaglet item relations existed (= null). */
  referenceKind?: TableReferenceKind | null;
  multiple: boolean;
  /** Absent in steps recorded before date ranges existed (= false). */
  range?: boolean;
  options: TableSelectOption[] | null;
  /** Absent in steps recorded before repeating dates existed (= null). */
  recurrence?: TableFieldRecurrence | null;
}

/** Column values by entry id, as text casts. */
export type ColumnValues = Array<[string, string | null]>;

export interface FieldDefinitionOp {
  op: 'field.definition';
  tableId: string;
  fieldId: string;
  before: StoredFieldDefinition;
  after: StoredFieldDefinition;
  /**
   * The field's revision in its current state (updated on each apply). Undo
   * and redo of other steps move it without changing the field, so the
   * checks fall back to comparing `before` / `after` with the field.
   */
  revision: number;
  /** The whole column before and after, when the edit changed stored values. */
  values: { before: ColumnValues; after: ColumnValues } | null;
  /**
   * Per-entry repeats this step holds while the field is on its side without
   * a repeat setting (taken when the setting is turned off, by the edit or by
   * undoing the edit that turned it on); put back when it returns to the side
   * with one. Absent when the step holds none.
   */
  repeats?: EntryRepeats;
}

/** A field's `table_entry_repeats` rows: [entry id, value]. */
export type EntryRepeats = Array<[string, unknown]>;

/** Active field ids in display order. */
export interface FieldOrderOp {
  op: 'field.order';
  tableId: string;
  before: string[];
  after: string[];
}

export interface FieldTitleOp {
  op: 'field.title';
  tableId: string;
  before: string | null;
  after: string | null;
}

/** A table's lifecycle move. A create is `deleted` → `active`. */
export interface TableStateOp {
  op: 'table.state';
  tableId: string;
  name: string;
  before: TableLifecycleState;
  after: TableLifecycleState;
}

export interface TableNameOp {
  op: 'table.name';
  tableId: string;
  before: string;
  after: string;
}

/** A `table_entry_occurrences` row exactly as stored (wall times, ISO `createdAt`). */
export interface StoredOccurrence {
  id: string;
  tableId: string;
  fieldId: string;
  entryId: string;
  occurrence: string;
  kind: 'done' | 'skipped' | 'moved';
  movedTo: string | null;
  actorKind: string | null;
  actorId: string | null;
  createdAt: string;
}

/**
 * One row's repeat on one field (`table_entry_repeats`) and the occurrence
 * log rows a step added or removed for it. `before` /
 * `after` null = no repeat. Forward (redo) the `added` rows are inserted and
 * the `removed` rows deleted; undo does the reverse. The row's date cell is
 * an `entries` op in the same step.
 */
export interface RepeatOp {
  op: 'repeat';
  tableId: string;
  fieldId: string;
  entryId: string;
  before: unknown | null;
  after: unknown | null;
  added: StoredOccurrence[];
  removed: StoredOccurrence[];
  /**
   * Recorded by an entry delete (the repeat went with its row). Put back
   * only while its field still exists, so a field purged since never makes
   * the delete step impossible.
   */
  cleanup?: boolean;
  /**
   * The occurrence action this op was (the `table_entry:occurrence` hook
   * event, see `occurrenceChanges.ts`), so undo can send its inverse and
   * redo send it again. Absent on set, clear and cleanup ops, and on ops
   * journaled before it: those replay without an event.
   */
  occurrence?: OccurrenceTag;
}

/** What a repeat action did to an occurrence, as the hook event names it. */
export type OccurrenceAction = 'done' | 'skipped' | 'moved' | 'shifted' | 'jumped' | 'undone';

/**
 * {@link RepeatOp.occurrence}. The log rows say what most actions did;
 * `from` (and `to`) name the occurrence when no row is added: a shift
 * (from → to), a jump (from the occurrence it left) and a move back to its
 * own slot (from = to).
 */
export interface OccurrenceTag {
  action: OccurrenceAction;
  from?: string;
  to?: string;
}

export type HistoryOp =
  | EntriesOp
  | FieldStateOp
  | FieldDefinitionOp
  | FieldOrderOp
  | FieldTitleOp
  | TableStateOp
  | TableNameOp
  | RepeatOp;

export interface HistoryActor {
  kind: TableHistoryActorKind;
  id: string;
  name?: string | null;
}

/**
 * The ops a mutation collects inside its transaction. `stepId` is minted up
 * front so a deleted field or table can name the step that holds it before
 * the step row is written.
 */
export interface HistoryJournal {
  stepId: string;
  ops: HistoryOp[];
}

/** Ask a model mutation to record its step in the same transaction. */
export interface HistoryContext {
  actor: HistoryActor;
}

export interface HistoryStepSummary {
  kind: TableHistoryStepKind;
  label: string;
}
