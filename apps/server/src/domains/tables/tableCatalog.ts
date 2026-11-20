/**
 * Database tables — catalog reads and custom-table creation.
 *
 * The catalog (`public.table_catalog`) lists Snaglet's builtin `public` tables and
 * user-created tables, each of which is one real PostgreSQL table in the
 * `user_tables` schema under a server-generated name (`t_` + 24 hex chars). The
 * display name is data only — it is never interpolated into SQL — and the
 * physical name never leaves the server.
 *
 * Reads are metadata only: columns from `information_schema` and an exact
 * row count. Row contents are never returned by this module.
 */

import { transaction, type DbQueryable } from '@snaglet/db';
import { Projects } from '@snaglet/db/tables/projects';
import { TableFields } from '@snaglet/db/tables/table_fields';
import { TableSemantic } from '@snaglet/db/tables/table_semantic';
import {
  newJournal,
  recordStep,
  stepLabels,
  type HistoryJournal,
} from '@snaglet/db/tables/table_history';
import {
  ENTRY_POSITION_COLUMN,
  TableCatalog,
  toTableCatalogEntry,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import {
  ErrorCode,
  HTTP_STATUS,
  type CreateTableRequest,
  type RenameTableRequest,
  type TableCatalogEntry,
  type TableDetailResponse,
  type TableOrigin,
  type TableProjectFilter,
  type UpdateTablePlacementRequest,
} from '@snaglet/shared/types';
import { AppError, tableNameProblem } from '@snaglet/shared/utils';
import { emitTableCreated, emitTableUpdated } from '@server/realtime/surfaces/tables';
import { afterTableWrite, historyContext } from './tableHistory';
import {
  parseCustomTableId,
  parseTableName,
  parseTableProjectId,
  parseTableSortOrder,
  tableBadRequest,
} from './tableValidation';

/** Server-managed columns every custom table is created with. */
const MANAGED_CUSTOM_COLUMNS: ReadonlySet<string> = new Set(['id', 'created_at']);

const NAME_INDEX = 'table_catalog_name_lower_key';

function conflict(message: string): AppError {
  return new AppError(message, ErrorCode.CONFLICT, HTTP_STATUS.CONFLICT);
}

function notFound(id: string): AppError {
  return new AppError(`Table not found: ${id}`, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
}

/** 409 for a stale rename; `details.table` is the current entry. */
function renamedMeanwhile(current: TableCatalogRow): AppError {
  const table = toTableCatalogEntry(current);
  return new AppError(
    `This table was renamed to "${table.name}"`,
    ErrorCode.CONFLICT,
    HTTP_STATUS.CONFLICT,
    true,
    { table }
  );
}

function archivedTable(row: TableCatalogRow, action = 'rename it'): AppError {
  return new AppError(
    `${row.name} is archived. Restore it to ${action}.`,
    ErrorCode.CONFLICT,
    HTTP_STATUS.CONFLICT,
    true,
    { table: toTableCatalogEntry(row) }
  );
}

function nameTaken(name: string): AppError {
  return conflict(`A table named "${name}" already exists`);
}

/**
 * The physical table name is already taken in user_tables: 42P07, or — when two
 * creates/renames of one name race — a clash on the table's row type, reported
 * as 42710 or as the unique index `pg_type_typname_nsp_index`, before the
 * catalog's own name index can fire.
 */
function isPhysicalNameTaken(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return (
    code === '42P07' ||
    code === '42710' ||
    (code === '23505' && constraint === 'pg_type_typname_nsp_index')
  );
}

function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  if (code !== '23505') return null;
  return typeof constraint === 'string' ? constraint : '';
}

/** Idempotent-replay decision for a create whose id already has a row. */
function replayOrConflict(existing: TableCatalogRow, name: string): CreateTableResult {
  if (existing.state !== 'active')
    throw conflict(`Table ${existing.id} is ${existing.state}; restore it instead of creating it`);
  if (existing.origin !== 'custom' || existing.name !== name) {
    throw conflict(`Table ${existing.id} already exists with a different name`);
  }
  return { table: toTableCatalogEntry(existing), created: false };
}

export interface ListTablesFilter {
  origin?: TableOrigin;
  /** A project container id, or `TABLE_PROJECT_FILTER_NONE` for workspace-wide tables. */
  projectId?: TableProjectFilter;
}

export async function listTables(filter: ListTablesFilter = {}): Promise<TableCatalogEntry[]> {
  const rows = await TableCatalog.listTables(filter);
  return rows.map(toTableCatalogEntry);
}

/**
 * Metadata for one table. An archived table answers too (its entry carries
 * `state: 'archived'`, and its columns keep their names), so an open pane can
 * show it as archived with Restore; a deleted one is a 404.
 */
export async function getTableDetail(id: string): Promise<TableDetailResponse> {
  const row = await TableCatalog.findById(id);
  if (!row || row.state === 'deleted') throw notFound(id);

  const physical = await TableCatalog.physicalColumns(row);
  if (physical.length === 0) {
    throw new AppError(
      `Table ${row.id} has no physical table`,
      ErrorCode.INTERNAL_ERROR,
      HTTP_STATUS.INTERNAL_SERVER_ERROR
    );
  }
  const rowCount = await TableCatalog.physicalRowCount(row);
  return {
    table: toTableCatalogEntry(row),
    // A custom table's `position` holds row order, and `_snaglet_…` columns keep
    // archived or deleted fields' data; neither is a column to show.
    columns: physical
      .filter(
        (column) =>
          row.origin !== 'custom' ||
          (column.name !== ENTRY_POSITION_COLUMN && !column.name.startsWith('_snaglet_'))
      )
      .map((column) => ({
        ...column,
        managed: row.origin === 'custom' && MANAGED_CUSTOM_COLUMNS.has(column.name),
      })),
    rowCount,
  };
}

export interface CreateTableResult {
  table: TableCatalogEntry;
  /** False on an idempotent replay of an already-created id. */
  created: boolean;
}

/**
 * A new custom table's physical table, catalog row and initial fields, in
 * `tx`: in project `projectId` (checked by the catalog insert: 404 unknown,
 * 400 not a live project) or workspace-wide with null, at the bottom of that
 * list.
 */
async function buildCustomTable(
  id: string,
  name: string,
  projectId: string | null,
  tx: DbQueryable,
  journal?: HistoryJournal
): Promise<TableCatalogRow> {
  // The validated name is the real table name in user_tables.
  await TableCatalog.createCustomPhysicalTable(name, id, tx);
  const table = await TableCatalog.registerCustom({ id, name, tableName: name, projectId }, tx);
  // The Name field (`name`, position 0), then managed `id` and `created_at`.
  await TableFields.registerInitialFields(id, tx);
  // Search by meaning is on by default; a new table has no rows, so it is
  // within the cap (services/tableSemantic/defaultOn.ts). Settings only: the
  // embedding worker builds vectors as rows arrive.
  await TableSemantic.enableIfUnset(id, tx);
  // Undoing a create deletes the table (held by the step), so redo can restore it.
  journal?.ops.push({ op: 'table.state', tableId: id, name, before: 'deleted', after: 'active' });
  return table;
}

/**
 * {@link createTable} inside the caller's transaction, without replays: the
 * name must pass the creation policy (400) and be free (409), and a
 * `projectId` must be a live project (404 unknown, 400 not one); null makes
 * it workspace-wide. Emits nothing; the caller emits `table.created` once it
 * commits.
 */
export async function createTableInTx(
  id: string,
  name: string,
  projectId: string | null,
  tx: DbQueryable,
  journal?: HistoryJournal
): Promise<TableCatalogRow> {
  const tableId = parseCustomTableId(id);
  const tableName = parseTableName(name);
  const problem = tableNameProblem(tableName);
  if (problem) throw tableBadRequest(problem);
  if (await TableCatalog.findByName(tableName, tx)) throw nameTaken(tableName);
  try {
    return await buildCustomTable(tableId, tableName, projectId, tx, journal);
  } catch (err) {
    if (uniqueViolationConstraint(err) === NAME_INDEX || isPhysicalNameTaken(err))
      throw nameTaken(tableName);
    throw err;
  }
}

/**
 * Create a custom table: one `user_tables` table, its catalog row and its initial
 * fields (the Name field plus managed `id`/`created_at`), in one
 * transaction. `projectId` puts it in that project (a live container with
 * `category = 'project'`: 404 unknown, 400 a folder, a thread or an archived
 * project); null or absent makes it workspace-wide. Either way it lands at
 * the bottom of that list inside the same transaction, so undoing the create
 * deletes the table and redoing it restores the table in that project.
 * Replaying the same `{id, name}` returns the existing entry with
 * `created: false` and ignores `projectId` (the table stays where it is); the
 * same id with another name, or a name already used by any table
 * (case-insensitive), is a 409. Concurrent creates of one id race on the
 * catalog primary key — the loser's transaction (and its physical table)
 * rolls back and it resolves as a replay. `table.created` carries the entry
 * with its `projectId` and `sortOrder`.
 */
export async function createTable(input: CreateTableRequest): Promise<CreateTableResult> {
  const id = parseCustomTableId(input.id);
  const name = parseTableName(input.name);
  const projectId = input.projectId === undefined ? null : parseTableProjectId(input.projectId);

  const existing = await TableCatalog.findById(id);
  if (existing) return replayOrConflict(existing, name);
  const problem = tableNameProblem(name);
  if (problem) throw tableBadRequest(problem);
  const nameOwner = await TableCatalog.findByName(name);
  // A concurrent submit of this same id may commit between the two reads.
  if (nameOwner) {
    if (nameOwner.id === id) return replayOrConflict(nameOwner, name);
    throw nameTaken(name);
  }

  const history = historyContext();
  let row: TableCatalogRow;
  try {
    row = await transaction(async (tx) => {
      const journal = newJournal();
      const created = await buildCustomTable(id, name, projectId, tx, journal);
      await recordStep(tx, history.actor, journal, stepLabels.tableCreate(name));
      return created;
    });
  } catch (err) {
    const constraint = uniqueViolationConstraint(err);
    if (constraint === null && !isPhysicalNameTaken(err)) throw err;
    const winner = await TableCatalog.findById(id);
    if (winner) return replayOrConflict(winner, name);
    if (constraint === NAME_INDEX || isPhysicalNameTaken(err)) throw nameTaken(name);
    throw err;
  }

  const table = toTableCatalogEntry(row);
  emitTableCreated(table);
  await afterTableWrite(history.actor);
  return { table, created: true };
}

/**
 * Rename a custom table: its real `user_tables` table is renamed and the catalog
 * row follows in one transaction. The catalog id, field ids and relations
 * (foreign keys follow the table) are unchanged. Built-in names are
 * seed-managed and refused.
 * `expectedName` is the name the caller last saw: if the table has been
 * renamed since, the 409 carries the current entry instead of overwriting it.
 * Re-submitting the current name is a no-op that emits nothing.
 */
export async function renameTable(
  id: string,
  input: RenameTableRequest
): Promise<TableCatalogEntry> {
  const name = parseTableName(input.name);
  const expectedName = parseTableName(input.expectedName);

  const current = await TableCatalog.findById(id);
  if (!current || current.state === 'deleted') throw notFound(id);
  if (current.origin !== 'custom') {
    throw new AppError(
      'Snaglet tables cannot be renamed',
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  }
  if (current.state === 'archived') throw archivedTable(current);
  if (current.name !== expectedName) throw renamedMeanwhile(current);
  if (name === current.name) return toTableCatalogEntry(current);
  const problem = tableNameProblem(name);
  if (problem) throw tableBadRequest(problem);

  const history = historyContext();
  let row: TableCatalogRow | null;
  try {
    row = await transaction(async (tx) => {
      const renamed = await TableCatalog.renameCustom(id, name, expectedName, tx);
      if (!renamed) return null;
      const journal = newJournal();
      journal.ops.push({ op: 'table.name', tableId: id, before: expectedName, after: name });
      await recordStep(tx, history.actor, journal, stepLabels.tableRename(expectedName, name));
      return renamed;
    });
  } catch (err) {
    if (uniqueViolationConstraint(err) === NAME_INDEX || isPhysicalNameTaken(err))
      throw nameTaken(name);
    throw err;
  }
  if (!row) {
    // Renamed (or removed) between the read and the conditional update.
    const latest = await TableCatalog.findById(id);
    if (!latest) throw notFound(id);
    throw renamedMeanwhile(latest);
  }

  const table = toTableCatalogEntry(row);
  emitTableUpdated(table);
  await afterTableWrite(history.actor);
  return table;
}

/** 400 for placing a built-in table, worded for the field that was sent. */
function builtinNotPlaceable(
  row: TableCatalogRow,
  placement: UpdateTablePlacementRequest
): AppError {
  return tableBadRequest(
    placement.projectId !== undefined
      ? `${row.name} is a Snaglet table; Snaglet tables are workspace-wide`
      : `${row.name} is a Snaglet table; Snaglet tables keep their built-in order`
  );
}

/** Validate each field sent; a body with neither is a 400. */
function parseTablePlacement(placement: UpdateTablePlacementRequest): UpdateTablePlacementRequest {
  const parsed: UpdateTablePlacementRequest = {};
  if (placement.projectId !== undefined) {
    parsed.projectId = parseTableProjectId(placement.projectId);
  }
  if (placement.sortOrder !== undefined) {
    parsed.sortOrder = parseTableSortOrder(placement.sortOrder);
  }
  if (parsed.projectId === undefined && parsed.sortOrder === undefined) {
    throw tableBadRequest('projectId, sortOrder, or both is required');
  }
  return parsed;
}

/**
 * Everything {@link updateTablePlacement} checks before it writes, for a
 * caller that batches the placement with another write (the PATCH rename)
 * and must refuse the whole body before any of it applies: the table is a
 * live custom table (404 unknown or deleted, 400 built-in, 409 archived),
 * `sortOrder` (when sent) is a non-negative integer, and `projectId` (when
 * sent) is null, the table's current home, or a live project container
 * (`Projects.assertProjectContainer`: 404 unknown, 400 a folder, a thread or
 * an archived project). Returns the table's current row.
 */
export async function assertTablePlacement(
  id: string,
  placement: UpdateTablePlacementRequest
): Promise<TableCatalogRow> {
  const target = parseTablePlacement(placement);
  const current = await TableCatalog.findById(id);
  if (!current || current.state === 'deleted') throw notFound(id);
  if (current.origin !== 'custom') throw builtinNotPlaceable(current, target);
  if (current.state === 'archived') throw archivedTable(current, 'move it');
  // Re-submitting the current home never looks at the project, so a table
  // stays linked to a project that has since been archived.
  if (target.projectId !== undefined && current.projectId !== target.projectId) {
    await Projects.assertProjectContainer(target.projectId);
  }
  return current;
}

/**
 * Place a custom table: move it into a project (a live container with
 * `category = 'project'`) or out to the workspace level (`null`), and/or put
 * it at slot `sortOrder` of that list, where every live custom table at that
 * slot or later shifts down by one. A project change without a slot lands at
 * the bottom. Placement is not content: it is not a step in anyone's undo
 * history and needs no concurrency token — the last write wins. The checks
 * are {@link assertTablePlacement}'s; the model then locks the catalog row
 * and writes only while the table is still a live custom table, so a table
 * archived between the check and the write is refused (409), never placed.
 * Re-submitting the current home with no slot is a no-op that emits nothing;
 * otherwise `table.updated` goes out for the placed table and for every
 * sibling the shift moved, so a client store stays in order without a
 * refetch.
 */
export async function updateTablePlacement(
  id: string,
  placement: UpdateTablePlacementRequest
): Promise<TableCatalogEntry> {
  const target = parseTablePlacement(placement);
  const current = await assertTablePlacement(id, target);
  const projectChanged = target.projectId !== undefined && target.projectId !== current.projectId;
  if (!projectChanged && target.sortOrder === undefined) return toTableCatalogEntry(current);

  const result = await transaction((tx) => TableCatalog.place(id, target, tx));
  if (!result) {
    // It stopped being a live custom table after the check above.
    const latest = await TableCatalog.findById(id);
    if (!latest || latest.state === 'deleted') throw notFound(id);
    if (latest.origin !== 'custom') throw builtinNotPlaceable(latest, target);
    if (latest.state === 'archived') throw archivedTable(latest, 'move it');
    throw conflict(`${latest.name} changed while it was being moved; try again`);
  }
  const table = toTableCatalogEntry(result.table);
  emitTableUpdated(table);
  for (const shifted of result.shifted) emitTableUpdated(toTableCatalogEntry(shifted));
  return table;
}

/**
 * {@link renameTable} inside the caller's transaction, which already holds the
 * table's catalog row FOR UPDATE, so no `expectedName` is needed. The current
 * name is a no-op (`renamed: false`). Emits nothing; the caller emits
 * `table.updated` once it commits.
 */
export async function renameTableInTx(
  id: string,
  name: string,
  tx: DbQueryable,
  journal?: HistoryJournal
): Promise<{ table: TableCatalogRow; renamed: boolean }> {
  const next = parseTableName(name);
  const current = await TableCatalog.findById(id, tx);
  if (!current || current.state === 'deleted') throw notFound(id);
  if (current.origin !== 'custom') {
    throw new AppError(
      'Snaglet tables cannot be renamed',
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  }
  if (current.state === 'archived') throw archivedTable(current);
  if (next === current.name) return { table: current, renamed: false };
  const problem = tableNameProblem(next);
  if (problem) throw tableBadRequest(problem);
  const owner = await TableCatalog.findByName(next, tx);
  if (owner && owner.id !== id) throw nameTaken(next);
  let row: TableCatalogRow | null;
  try {
    row = await TableCatalog.renameCustom(id, next, current.name, tx);
  } catch (err) {
    if (uniqueViolationConstraint(err) === NAME_INDEX || isPhysicalNameTaken(err))
      throw nameTaken(next);
    throw err;
  }
  if (!row) throw renamedMeanwhile(current);
  journal?.ops.push({ op: 'table.name', tableId: id, before: current.name, after: next });
  return { table: row, renamed: true };
}
