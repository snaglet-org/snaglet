import type { TableReferenceKind } from './table-references';
import type { TableSelectOption, TableSelectOptionInput } from './table-select-options';

/**
 * Editable types for custom-table fields. The managed `id` is a `uuid`, and
 * the managed `created_at` is a `datetime` that stays read-only through its
 * `managed` flag.
 */
export const EDITABLE_TABLE_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'datetime',
  'checkbox',
  'relation',
  'select',
] as const;
export type EditableTableFieldType = (typeof EDITABLE_TABLE_FIELD_TYPES)[number];
export type TableFieldType = EditableTableFieldType | 'uuid';
export const TABLE_FIELD_DESCRIPTION_MAX_LENGTH = 2000;
export const CUSTOM_FIELD_ID_PATTERN = /^field-\d{13}-[a-z0-9]{1,12}$/;

/**
 * Numbers use decimal strings to avoid losing precision in JSON. A datetime
 * is ISO 8601 and is saved as UTC (`2026-10-01T22:30:00.000000Z`). A multiple
 * relation's default is always the empty list; a multi-select's is a list of
 * option labels.
 */
export type TableFieldDefault = string | boolean | null | string[];

/** Most entries one multiple relation value may link to. */
export const TABLE_RELATION_MAX_LINKS = 100;

/** Narrowest and widest a field's grid column may be set, in CSS px. */
export const TABLE_FIELD_WIDTH_MIN = 64;
export const TABLE_FIELD_WIDTH_MAX = 800;

export interface TableFieldDefinition {
  name: string;
  description: string | null;
  type: EditableTableFieldType;
  /** Single relations are nullable; a multiple relation is stored as never null (empty = `[]`). */
  nullable: boolean;
  /**
   * Relations have none: null, or `[]` for a multiple relation (null is
   * accepted and becomes `[]`). A select's is an option label or null; a
   * multi-select's a list of labels (null becomes `[]`).
   */
  defaultValue: TableFieldDefault;
  /** Relation target: a custom table's catalog id. */
  referenceTableId: string | null;
  /**
   * Relation target instead of a table: one kind of Snaglet item (docs, agents, …).
   * A relation has exactly one of `referenceTableId` and `referenceKind`.
   * Create defaults to null; an update that omits it keeps the field's current
   * kind while it stays a relation without a table target.
   */
  referenceKind?: TableReferenceKind | null;
  /**
   * Relations and selects: hold an ordered list (entries or option labels)
   * instead of one value. Create defaults to false; an update that omits it
   * keeps the field's current value.
   */
  multiple?: boolean;
  /**
   * Date and datetime fields only: each value is a start and an end (End
   * date in the field editor), on the wire `start/end` or a single start
   * (see `parseTableDateRange`). A range field has no default value. Create
   * defaults to false; an update that omits it keeps the field's current
   * setting while it stays a date or datetime field.
   */
  range?: boolean;
  /**
   * Select fields only, in display order (see {@link TableSelectOptionInput}).
   * Create defaults to none; an update that omits it keeps the current options.
   * Other types take null or leave it out.
   */
  options?: TableSelectOptionInput[] | null;
  /**
   * Date and datetime fields only: the field's repeat setting (see
   * {@link TableFieldRecurrence}); null = rows of this field never repeat.
   * Create defaults to null; an update that omits it keeps the current one.
   */
  recurrence?: TableFieldRecurrence | null;
  /**
   * Date and datetime fields only: the calendar every row's value of this
   * field shows on; null = not on a calendar.
   * Create defaults to null; an update that omits it keeps the current one.
   * Binding when no calendar exists: pass the literal `'default'` and
   * the server binds to the Default calendar, creating it if needed.
   */
  calendarId?: string | 'default' | null;
}

/**
 * A date field's repeat setting (completion model A). When an
 * entry's status (a single select of the same table) is set to one of
 * `doneOptionIds`, a repeating date advances to its next occurrence and the
 * status resets to `resetOptionId` (null = cleared). Options are referenced
 * by id, so renaming one keeps the setting; removing one it names, retiring
 * or retyping the status field are refused while the setting names them.
 * Repeats start their weeks on Monday; the `weekStart` key older settings
 * still store is ignored when read and never written.
 */
export interface TableFieldRecurrence {
  /**
   * The select field whose done options also complete a row (completion by
   * status), or null: rows are then completed only with Done / Skip (the
   * calendar, the row's repeat section, an agent's repeat ops).
   */
  statusFieldId: string | null;
  /** At least one when there is a status field, none otherwise; never includes `resetOptionId`. */
  doneOptionIds: string[];
  /** Null without a status field. */
  resetOptionId: string | null;
}

export interface TableField extends Omit<
  TableFieldDefinition,
  'type' | 'multiple' | 'range' | 'options' | 'referenceKind' | 'recurrence' | 'calendarId'
> {
  id: string;
  tableId: string;
  columnName: string;
  type: TableFieldType;
  /** The Snaglet item kind a relation links to; null for every other field. */
  referenceKind: TableReferenceKind | null;
  /**
   * A relation holding an ordered `string[]` of entry UUIDs (stored as
   * `uuid[]`, no FK) or Snaglet item ids (`text[]`), or a multi-select holding
   * option labels (`text[]`).
   */
  multiple: boolean;
  /**
   * A date field stored as `daterange` or a datetime field stored as
   * `tstzrange`: its value is `start/end` (a date range's end day included)
   * or a single start. False for every other field.
   */
  range: boolean;
  /** A select's options in display order; null for every other type. */
  options: TableSelectOption[] | null;
  /**
   * Present only on a repeating date or datetime field: its repeat setting.
   * Absent (or null) means the field does not repeat. The server sends the
   * key only when set, so other fields' payloads are unchanged.
   */
  recurrence?: TableFieldRecurrence | null;
  /**
   * Present only on a date/datetime field shown on a calendar: that
   * calendar's id. Absent means not on a calendar (other payloads unchanged).
   */
  calendarId?: string | null;
  position: number;
  managed: boolean;
  revision: number;
  /**
   * Grid column shown as a narrow strip. A presentation-only view flag, not
   * schema: toggling it bumps no revision and leaves the entry schemaVersion.
   */
  collapsed: boolean;
  /**
   * Present only when the grid column has a set width: whole CSS px from
   * {@link TABLE_FIELD_WIDTH_MIN} to {@link TABLE_FIELD_WIDTH_MAX}. Absent (or
   * null) means auto. A view flag like `collapsed`: no revision, not in the
   * entry schemaVersion, and a collapsed column ignores it.
   */
  width?: number | null;
  /**
   * The table's Name field: its value names an entry in chips, links and
   * search. At most one per table, always text; set only by Snaglet when it
   * creates the table, never through the create/update APIs. Null and ''
   * both mean unnamed.
   */
  isTitle: boolean;
  /**
   * Present only for a field that is not active: archived (kept, restorable)
   * or deleted (kept while undoable). Such a field is in no entry payload,
   * schemaVersion or field list, and its column no longer has its name.
   */
  state?: 'archived' | 'deleted';
  /** When it was archived or deleted; present with `state`. */
  archivedAt?: string;
}

export interface TableFieldsResponse {
  fields: TableField[];
}

export interface CreateTableFieldRequest extends TableFieldDefinition {
  /** Client-minted stable id for idempotent create retries. */
  id: string;
  /**
   * Take this field's display slot (managed fields included), shifting it and
   * every later field one later; omit to append. Exact replays skip placement.
   */
  beforeFieldId?: string;
}

export interface UpdateTableFieldRequest extends TableFieldDefinition {
  expectedRevision: number;
}

export interface ReorderTableFieldsRequest {
  /** Every field id of the table (managed included), in the new display order. */
  fieldIds: string[];
}

/**
 * Per-field view preferences; last write wins, so no revision is required.
 * Send at least one. `width: null` returns the column to auto.
 */
export interface UpdateTableFieldViewRequest {
  collapsed?: boolean;
  width?: number | null;
}

/**
 * `PUT /api/tables/:id/fields/:fieldId/calendar`: show any date or datetime
 * field of a custom table on a calendar, managed `created_at` included, or
 * take it off (null). `'default'` binds to the Default calendar, creating it
 * when needed. Revision-checked like a field edit (and it bumps the revision),
 * but no step in table history: the calendar's undo stack reverses it.
 */
export interface SetTableFieldCalendarRequest {
  calendarId: string | 'default' | null;
  expectedRevision: number;
}

export interface TableFieldResponse {
  field: TableField;
}
