/**
 * Database tables — archive, delete and undo history (wire contract).
 *
 * Every committed change to a custom table's entries, fields or lifecycle is
 * one step in its actor's own linear history: the human user and each agent
 * (and each external MCP client) has a separate stack of the newest
 * {@link TABLE_HISTORY_DEPTH} steps. Undo reverts the actor's newest done
 * step, redo re-applies the oldest undone one, and any new step discards the
 * undone ones. See docs/architecture.md.
 */

import type { TableCatalogEntry, TableLifecycleState } from './tables';
import type { TableField } from './table-fields';

/** Steps kept per actor; older steps are pruned and their deleted data purged. */
export const TABLE_HISTORY_DEPTH = 100;

/** Who a history stack belongs to (the realtime `Actor` kinds). */
export const TABLE_HISTORY_ACTOR_KINDS = ['user', 'agent', 'external', 'system'] as const;
export type TableHistoryActorKind = (typeof TABLE_HISTORY_ACTOR_KINDS)[number];

export interface TableHistoryActor {
  kind: TableHistoryActorKind;
  /** users.id for `user`, agents.id for `agent`, members.id for `external`, `system`. */
  id: string;
  name?: string | null;
}

/** What a step did, for icons and grouping; `label` is the human summary. */
export const TABLE_HISTORY_STEP_KINDS = [
  'entry.create',
  'entry.update',
  'entry.delete',
  'entry.write',
  'field.create',
  'field.update',
  'field.reorder',
  'field.archive',
  'field.restore',
  'field.delete',
  'field.title',
  'table.create',
  'table.rename',
  'table.archive',
  'table.restore',
  'table.delete',
  'table.schema',
] as const;
export type TableHistoryStepKind = (typeof TABLE_HISTORY_STEP_KINDS)[number];

export interface TableHistoryStep {
  id: string;
  actor: TableHistoryActor;
  kind: TableHistoryStepKind;
  /** e.g. `Delete 3 entries from reading_list`. */
  label: string;
  /** Catalog ids of the tables the step touched. */
  tableIds: string[];
  /** `done` can be undone; `undone` can be redone. */
  state: 'done' | 'undone';
  /** Position in the actor's stack; higher is newer. */
  seq: number;
  createdAt: string;
  /** When it was recorded, undone or redone last. */
  updatedAt: string;
}

/**
 * GET /api/tables/history — one actor's stack, newest first (default: the
 * caller's). With `?actor=all`, the newest steps of every actor instead, with
 * `undo`/`redo` left null.
 */
export interface TableHistoryResponse {
  actor: TableHistoryActor | null;
  steps: TableHistoryStep[];
  /** The step undo would revert next, or null. */
  undo: TableHistoryStep | null;
  /** The step redo would re-apply next, or null. */
  redo: TableHistoryStep | null;
  depth: number;
}

/**
 * POST /api/tables/history/undo and /redo. Omit `actor` to use the caller's
 * own stack; name another actor (e.g. an agent) to step theirs. `stepId` is
 * the step the client showed: if the stack's next step differs, the request
 * is a 409 carrying the current one, so a stale button never reverts
 * something else. `names` renames restored fields or tables (keyed by field
 * or table id) when their old name has been taken since.
 */
export interface TableHistoryStepRequest {
  actor?: { kind: TableHistoryActorKind; id: string };
  stepId?: string;
  names?: Record<string, string>;
}

export interface TableHistoryStepResponse {
  step: TableHistoryStep;
  undo: TableHistoryStep | null;
  redo: TableHistoryStep | null;
}

/**
 * `details` of a 409 from undo or redo. Nothing is changed. `stale`: the
 * stack's next step is not `stepId` (`step` is the current one). `conflict`:
 * something the step touches changed since (`conflicts` says what).
 * `nameTaken`: a restored field or table's name is used now; retry with
 * `names` (`names` lists what needs one). `discarded`: a table or field the
 * step needs was permanently deleted, so the step (`step`) was removed from
 * the history instead; nothing else changed, and the next press reaches the
 * step beyond it.
 */
export type TableHistoryConflictDetails = {
  reason: 'stale' | 'conflict' | 'nameTaken' | 'empty' | 'discarded';
  step?: TableHistoryStep | null;
  conflicts?: TableHistoryConflict[];
  names?: Array<{ kind: 'field' | 'table'; id: string; tableId: string; name: string }>;
};

export interface TableHistoryConflict {
  kind: 'entry' | 'field' | 'table' | 'order' | 'title';
  tableId: string;
  /** Entry, field or table id. */
  id: string;
  message: string;
}

/** A relation field in another table that points at a table being deleted. */
export interface TableLinkedField {
  tableId: string;
  tableName: string;
  fieldId: string;
  fieldName: string;
  /** The linking field's own lifecycle state. */
  state: Exclude<TableLifecycleState, 'deleted'>;
}

/** POST /api/tables/:id/delete — `clearReferences` confirms deleting linked relation fields. */
export interface DeleteTableRequest {
  clearReferences?: boolean;
}

/** POST /api/tables/:id/restore and /fields/:fieldId/restore; `name` when the old one is taken. */
export interface RestoreTableItemRequest {
  name?: string;
}

/** POST /api/tables/:id/archive|restore|delete */
export interface TableLifecycleResponse {
  table: TableCatalogEntry;
  /** False when the table was already in that state (nothing recorded). */
  changed: boolean;
  /** Relation fields of other tables deleted along with a deleted table. */
  deletedLinkedFields?: TableLinkedField[];
}

/** GET /api/tables/archived — archived custom tables, newest first. */
export interface ArchivedTablesResponse {
  tables: TableCatalogEntry[];
}

/** POST /api/tables/:id/fields/:fieldId/archive|restore|delete */
export interface TableFieldLifecycleResponse {
  field: TableField;
  changed: boolean;
}

/** GET /api/tables/:id/fields/archived — the table's archived fields, newest first. */
export interface ArchivedTableFieldsResponse {
  fields: TableField[];
}

/** PUT /api/tables/:id/title — make a text field the table's Name field. */
export interface SetTableTitleFieldRequest {
  fieldId: string;
}

/**
 * GET /api/archive/counts/:tableId — what archiving a table affects, for the
 * archive confirmation (tables are not workspace nodes).
 */
export interface ArchiveTableCounts {
  entries: number;
  fields: number;
  /** Relation fields in other tables that link to it; kept, shown as unavailable. */
  linked_fields: number;
}
