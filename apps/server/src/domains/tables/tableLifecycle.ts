/**
 * Archive, restore and delete for custom tables and their fields, and the
 * Name-field choice. Every change is one step in the caller's undo history.
 *
 * - Archive hides a table or field and frees its name; it is kept
 *   indefinitely and restores any time (under a new name if the old one was
 *   taken meanwhile). Relation fields elsewhere keep their stored ids; the
 *   archived target just shows as unavailable (names and search leave it
 *   out).
 * - Delete also hides and frees the name at once, but keeps the data only
 *   while the deleting step is in its actor's history (the newest 100 steps);
 *   undo brings it back exactly, and once the step falls off the column or
 *   table is dropped. Deleting a table other tables link to deletes those
 *   relation fields in the same step, on `clearReferences` confirmation.
 */
import {
  TableCatalog,
  toTableCatalogEntry,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import { TableFields } from '@snaglet/db/tables/table_fields';
import { TableLifecycle, linkedFields, type HistoryActor } from '@snaglet/db/tables/table_history';
import { getDb, type DbQueryable } from '@snaglet/db';
import {
  ErrorCode,
  HTTP_STATUS,
  type ArchiveTableCounts,
  type ArchivedTableFieldsResponse,
  type ArchivedTablesResponse,
  type TableField,
  type TableFieldLifecycleResponse,
  type TableFieldsResponse,
  type TableLifecycleResponse,
  type TableLinkedField,
} from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import {
  emitTableFieldsChanged,
  emitTableHistoryChanged,
  emitTableRemoved,
  emitTableRestored,
} from '@server/realtime/surfaces/tables';
import { assertNoArchiveSweep } from '@server/services/ArchiveSweepGuard';
import { afterTableWrite, historyContext } from './tableHistory';
import { tableBadRequest } from './tableValidation';

function object(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw tableBadRequest('Request must be an object.');
  return input as Record<string, unknown>;
}

function optionalName(input: unknown): string | undefined {
  const name = object(input).name;
  if (name === undefined || name === null) return undefined;
  if (typeof name !== 'string' || !name.trim()) throw tableBadRequest('name must be a name.');
  return name.trim();
}

/** A custom table in any state but deleted: 404 unknown or deleted, 403 built-in. */
export async function customTableRow(id: string): Promise<TableCatalogRow> {
  const row = await TableCatalog.findById(id);
  if (!row || row.state === 'deleted')
    throw new AppError(`Table not found: ${id}`, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  if (row.origin !== 'custom')
    throw new AppError(
      'Snaglet tables cannot be archived or deleted',
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  return row;
}

/** Archive a custom table (idempotent). Emits `table.removed` once it commits. */
export async function archiveTable(id: string): Promise<TableLifecycleResponse> {
  await customTableRow(id);
  const history = historyContext();
  const result = await TableLifecycle.archiveTable(id, history);
  if (result.changed) {
    emitTableRemoved(id, 'archived');
    await afterTableWrite(history.actor);
  }
  return { table: toTableCatalogEntry(result.item), changed: result.changed };
}

/** Restore an archived table, optionally under a new `name` (idempotent for an active one). */
export async function restoreTable(id: string, input: unknown): Promise<TableLifecycleResponse> {
  assertNoArchiveSweep();
  const name = optionalName(input);
  await customTableRow(id);
  const history = historyContext();
  const result = await TableLifecycle.restoreTable(id, name, history);
  if (result.changed) {
    emitTableRestored(toTableCatalogEntry(result.item));
    await afterTableWrite(history.actor);
  }
  return { table: toTableCatalogEntry(result.item), changed: result.changed };
}

/**
 * Delete an active or archived custom table; undoable while the step is in
 * the caller's history. Relation fields of other tables that link to it are a
 * 409 (`details.linkedFields`) unless `clearReferences` is true, which
 * deletes them in the same step.
 */
export async function deleteTable(id: string, input: unknown): Promise<TableLifecycleResponse> {
  const clearReferences = object(input).clearReferences;
  if (clearReferences !== undefined && typeof clearReferences !== 'boolean')
    throw tableBadRequest('clearReferences must be a boolean.');
  await customTableRow(id);
  const history = historyContext();
  const result = await TableLifecycle.deleteTable(id, { clearReferences }, history);
  emitTableRemoved(id, 'deleted');
  for (const tableId of new Set(result.linked.map((field) => field.tableId)))
    emitTableFieldsChanged(tableId);
  await afterTableWrite(history.actor);
  return {
    table: toTableCatalogEntry(result.item),
    changed: result.changed,
    deletedLinkedFields: result.linked,
  };
}

/** What deleting projects for good did to their custom tables. */
export interface ProjectTablesDrop {
  dropped: TableCatalogRow[];
  /** Kept (TTL sweeps): other tables still link to them; now workspace-wide. */
  kept: string[];
  /** Relation fields of other tables dropped with them (`clear`), or kept to. */
  linked: TableLinkedField[];
  historyActors: HistoryActor[];
}

/**
 * Project containers at or below `rootId` in the folder tree: the projects a
 * delete of `rootId` takes with it.
 */
async function projectsInSubtree(rootId: string, tx: DbQueryable): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM public.nodes WHERE id = $1
       UNION ALL
       SELECT child.id FROM public.nodes child JOIN subtree s ON child.container_id = s.id
     )
     SELECT c.id FROM public.containers c WHERE c.id IN (SELECT id FROM subtree)
        AND c.category = 'project'
      ORDER BY c.id`,
    [rootId]
  );
  return rows.map((row) => row.id);
}

/**
 * Project containers an archive sweep up to `before` (a timestamptz) is about
 * to delete: containers archived before it and every container below them.
 * Their rows stay share-locked to the end of `tx`, so none is restored while
 * its tables go; one restored before the lock was granted is left out.
 */
async function projectsExpiring(before: string, tx: DbQueryable): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM public.nodes
        WHERE type = 'container' AND archived = true
          AND archived_at < $1::timestamptz
       UNION
       SELECT child.id FROM public.nodes child JOIN subtree s ON child.container_id = s.id
     )
     SELECT project.id
       FROM public.nodes project
       JOIN public.containers c ON c.id = project.id
      WHERE project.id IN (SELECT id FROM subtree)
        AND c.category = 'project' AND project.archived = true
      ORDER BY project.id
        FOR SHARE OF project`,
    [before]
  );
  return rows.map((row) => row.id);
}

/** Custom tables an archive sweep up to one `due` time (exclusive) adds. */
export interface ExpiringTableGroup {
  /** The earliest `archived_at` (timestamptz text) that takes these tables. */
  due: string;
  tables: number;
}

/**
 * The custom tables a sweep up to `before` would drop, grouped by the time
 * whose sweep first takes them: the earliest archive time among their
 * project's expired archived containers (itself or one above it). A sweep up
 * to any group's `due` takes exactly the groups before it. Earliest first.
 */
export async function expiringTableGroups(before: string): Promise<ExpiringTableGroup[]> {
  const { rows } = await getDb().query<ExpiringTableGroup>(
    `WITH RECURSIVE expiring AS (
       SELECT id, archived_at AS due FROM public.nodes
        WHERE type = 'container' AND archived = true
          AND archived_at < $1::timestamptz
       UNION ALL
       SELECT child.id, parent.due
         FROM public.nodes child JOIN expiring parent ON child.container_id = parent.id
     ),
     projects AS (
       SELECT expiring.id, min(expiring.due) AS due
         FROM expiring JOIN public.containers c ON c.id = expiring.id AND c.category = 'project'
        GROUP BY expiring.id
     )
     SELECT projects.due::text AS due, count(*)::int AS tables
       FROM projects
       JOIN public.nodes AS project ON project.id = projects.id
       JOIN public.table_catalog AS catalog ON catalog.project_id = projects.id
      WHERE catalog.origin = 'custom' AND (project.archived = false OR catalog.state <> 'active')
      GROUP BY projects.due
      ORDER BY projects.due`,
    [before]
  );
  return rows;
}

/**
 * Before a container is deleted for good, in its transaction: drop the custom
 * tables homed in the projects it takes with it (itself and any inside it).
 * Relation fields of other tables that link to them are a 409 (nothing
 * changes) unless `clearReferences`, which drops them too. Call
 * {@link announceProjectTablesDrop} once the transaction commits.
 */
export async function dropTablesOfDeletedContainer(
  rootId: string,
  opts: { clearReferences?: boolean },
  tx: DbQueryable
): Promise<ProjectTablesDrop> {
  const projects = await projectsInSubtree(rootId, tx);
  return TableLifecycle.dropProjectTablesInTx(
    projects,
    opts.clearReferences === true ? 'clear' : 'refuse',
    tx
  );
}

/**
 * Before an archive sweep up to `before` (a timestamptz) deletes nodes, in
 * its transaction: drop the custom tables of the projects it is about to
 * delete, at most `limit` of them (`remaining` counts the rest). A table that
 * other tables still link to is kept (a sweep never changes another table's
 * schema); the project's delete leaves it workspace-wide, still archived,
 * for an explicit delete from the archive.
 */
export async function dropTablesOfExpiringProjects(
  before: string,
  tx: DbQueryable,
  opts: { limit?: number } = {}
): Promise<ProjectTablesDrop & { remaining: number; droppedFields: number }> {
  const projects = await projectsExpiring(before, tx);
  return TableLifecycle.dropProjectTablesInTx(projects, 'keep', tx, opts);
}

/** After the transaction of a project-tables drop commits: tell clients. */
export function announceProjectTablesDrop(drop: ProjectTablesDrop): void {
  for (const table of drop.dropped) emitTableRemoved(table.id, 'deleted');
  const dropped = new Set(drop.dropped.map((table) => table.id));
  for (const tableId of new Set(drop.linked.map((field) => field.tableId)))
    if (!dropped.has(tableId)) emitTableFieldsChanged(tableId);
  for (const actor of drop.historyActors) emitTableHistoryChanged(actor);
}

/**
 * Drop an archived table for good (the archive's "delete forever"; not
 * undoable). Relation fields of other tables that link to it are a 409
 * (`details.linkedFields`) unless `clearReferences`, which drops them too.
 * History steps that needed them go too; their stacks hear
 * `table.history.changed`.
 */
export async function purgeArchivedTable(
  id: string,
  opts: { clearReferences?: boolean } = {}
): Promise<{ table: TableCatalogRow; linked: TableLinkedField[] }> {
  await customTableRow(id);
  const { historyActors, ...result } = await TableLifecycle.purgeTable(id, opts);
  emitTableRemoved(id, 'deleted');
  for (const tableId of new Set(result.linked.map((field) => field.tableId)))
    emitTableFieldsChanged(tableId);
  for (const actor of historyActors) emitTableHistoryChanged({ kind: actor.kind, id: actor.id });
  return result;
}

export async function listArchivedTables(): Promise<ArchivedTablesResponse> {
  return { tables: (await TableLifecycle.listArchivedTables()).map(toTableCatalogEntry) };
}

/** What archiving a table affects, for the archive confirmation. */
export async function archiveTableCounts(
  id: string
): Promise<{ table: TableCatalogRow; counts: ArchiveTableCounts }> {
  const row = await customTableRow(id);
  const fields = (await TableFields.listFields(id)).filter((field) => !field.managed);
  const entries = await TableCatalog.physicalRowCount(row);
  const linked = (await linkedFields(id, getDb())).filter((field) => field.state === 'active');
  return {
    table: row,
    counts: { entries, fields: fields.length, linked_fields: linked.length },
  };
}

function fieldResponse(result: { item: TableFieldLifecycleResponse['field']; changed: boolean }) {
  return { field: result.item, changed: result.changed };
}

export async function archiveTableField(
  tableId: string,
  fieldId: string
): Promise<TableFieldLifecycleResponse> {
  const history = historyContext();
  const result = await TableLifecycle.archiveField(tableId, fieldId, history);
  if (result.changed) {
    emitTableFieldsChanged(tableId);
    await afterTableWrite(history.actor);
  }
  return fieldResponse(result);
}

/** Delete a field (active or archived); undoable while the step is in the caller's history. */
export async function deleteTableField(
  tableId: string,
  fieldId: string
): Promise<TableFieldLifecycleResponse> {
  const history = historyContext();
  const result = await TableLifecycle.deleteField(tableId, fieldId, history);
  if (result.changed) {
    emitTableFieldsChanged(tableId);
    await afterTableWrite(history.actor);
  }
  return fieldResponse(result);
}

export async function restoreTableField(
  tableId: string,
  fieldId: string,
  input: unknown
): Promise<TableFieldLifecycleResponse & { madeOptional: boolean }> {
  const name = optionalName(input);
  const history = historyContext();
  const result = await TableLifecycle.restoreField(tableId, fieldId, name, history);
  if (result.changed) {
    emitTableFieldsChanged(tableId);
    await afterTableWrite(history.actor);
  }
  return { ...fieldResponse(result), madeOptional: result.madeOptional };
}

export async function listArchivedTableFields(
  tableId: string
): Promise<ArchivedTableFieldsResponse> {
  await customTableRow(tableId);
  return { fields: await TableLifecycle.listArchivedFields(tableId) };
}

/** Archived fields of every custom table (active or archived), newest first, for the archive listing. */
export async function listAllArchivedTableFields(): Promise<
  Array<{ field: TableField; table: TableCatalogRow }>
> {
  return TableLifecycle.listArchivedFieldsOfCustomTables();
}

/**
 * Drop a custom field for good, with every value in it (the archive's
 * "delete forever" and the header's "Delete forever"; not undoable). Any
 * state: an active column goes at once, an archived one leaves the archive.
 * History steps that needed it go too; their stacks hear
 * `table.history.changed`.
 */
export async function purgeTableField(
  tableId: string,
  fieldId: string
): Promise<TableFieldLifecycleResponse> {
  await customTableRow(tableId);
  const { field, historyActors } = await TableLifecycle.purgeField(tableId, fieldId);
  emitTableFieldsChanged(tableId);
  for (const actor of historyActors) emitTableHistoryChanged({ kind: actor.kind, id: actor.id });
  return { field, changed: true };
}

/** PUT /api/tables/:id/title { fieldId } — any active text field can be the Name field. */
export async function setTableTitleField(
  tableId: string,
  input: unknown
): Promise<TableFieldsResponse> {
  const fieldId = object(input).fieldId;
  if (typeof fieldId !== 'string' || !fieldId.trim())
    throw tableBadRequest('Request body must be { fieldId: string }.');
  const history = historyContext();
  const result = await TableLifecycle.setTitleField(tableId, fieldId, history);
  if (result.changed) {
    emitTableFieldsChanged(tableId);
    await afterTableWrite(history.actor);
  }
  return { fields: result.item };
}
