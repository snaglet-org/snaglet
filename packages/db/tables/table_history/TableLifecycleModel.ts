/**
 * Archive, restore and delete for custom tables and fields, and choosing a
 * table's Name field. Each call is one transaction under the schema locks
 * and, given a {@link HistoryContext}, records one undoable step in it. The
 * `*InTx` forms add to a caller's transaction and journal (agent batches).
 *
 * Archive keeps an item indefinitely (restore any time). Delete keeps it only
 * while the deleting step is in its actor's history; undo brings it back.
 */
import { getDb, transaction, type DbQueryable } from '@snaglet/db/db';
import { TableCatalog, type TableCatalogRow } from '@snaglet/db/tables/table_catalog';
import {
  TableFields,
  mapFieldDatabaseError,
  type LockedTables,
} from '@snaglet/db/tables/table_fields';
import { ErrorCode, type TableField, type TableLinkedField } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { findField, toField, type RawField } from '../table_fields/fieldRows';
import {
  currentTitleField,
  dropFieldNow,
  dropTableNow,
  linkedFields,
  restoreRetiredField,
  restoreRetiredTable,
  retireField,
  retireTable,
  setTitleField,
  storedDefinition,
} from './lifecycle';
import { uniqueActors } from './forget';
import { newJournal, recordStep, stepLabels, type RecordedStep } from './record';
import type {
  FieldStateOp,
  HistoryActor,
  HistoryContext,
  HistoryJournal,
  HistoryStepSummary,
} from './types';

function notFound(what: 'Table' | 'Field'): AppError {
  return new AppError(`${what} not found`, ErrorCode.NOT_FOUND, 404);
}

function archivedTable(row: TableCatalogRow): AppError {
  return new AppError(
    `${row.name} is archived. Restore it to change it.`,
    ErrorCode.CONFLICT,
    409,
    true,
    { table: { id: row.id, name: row.name, state: row.state } }
  );
}

/** The locked table must be active (archived: 409, deleted: 404). */
export function activeTable(row: TableCatalogRow | undefined): TableCatalogRow {
  if (!row || row.state === 'deleted') throw notFound('Table');
  if (row.state !== 'active') throw archivedTable(row);
  return row;
}

async function fieldOf(
  table: TableCatalogRow,
  fieldId: string,
  tx: DbQueryable
): Promise<RawField> {
  const raw = await findField(fieldId, tx);
  if (!raw || raw.table_id !== table.id) throw notFound('Field');
  return raw;
}

/** A field.state op's record of the field it retires: its revision and definition while active. */
function activeSide(raw: RawField): Pick<FieldStateOp, 'revision' | 'definition'> {
  return raw.state === 'active'
    ? { revision: raw.revision, definition: storedDefinition(toField(raw)) }
    : { revision: null };
}

export interface LifecycleResult<T> {
  item: T;
  changed: boolean;
  step: RecordedStep | null;
}

/**
 * Run `work` in a transaction (or the caller's `outer` one) with a journal
 * and record its step (when anything changed).
 */
async function recorded<T>(
  history: HistoryContext | undefined,
  work: (
    tx: DbQueryable,
    journal: HistoryJournal
  ) => Promise<{ item: T; changed: boolean; summary: HistoryStepSummary }>,
  /** Run in this transaction instead of a new one. */
  outer?: DbQueryable
): Promise<LifecycleResult<T>> {
  const run = async (tx: DbQueryable): Promise<LifecycleResult<T>> => {
    const journal = newJournal();
    const { item, changed, summary } = await work(tx, journal);
    const step = changed && history ? await recordStep(tx, history.actor, journal, summary) : null;
    return { item, changed, step };
  };
  try {
    return outer ? await run(outer) : await transaction(run);
  } catch (error) {
    throw mapFieldDatabaseError(error);
  }
}

/** Custom tables homed in any of `projectIds` in one of `states`, by id. */
async function projectTableIds(
  projectIds: readonly string[],
  states: readonly string[],
  tx: DbQueryable
): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM public.table_catalog
      WHERE origin = 'custom' AND project_id = ANY($1::text[]) AND state = ANY($2::text[])
      ORDER BY id`,
    [[...projectIds], [...states]]
  );
  return rows.map((row) => row.id);
}

/**
 * The tables a delete of projects `$2` takes: every table of a live project,
 * the archived and deleted ones of an archived project; `$1` (or null) narrows
 * it to those ids.
 */
const DOOMED_TABLES_SQL = `SELECT catalog.id
   FROM public.table_catalog AS catalog
   JOIN public.nodes AS project ON project.id = catalog.project_id
  WHERE catalog.origin = 'custom' AND catalog.project_id = ANY($2::text[])
    AND ($1::text[] IS NULL OR catalog.id = ANY($1::text[]))
    AND (project.archived = false OR catalog.state <> 'active')`;

async function stillDoomed(
  ids: readonly string[],
  projectIds: readonly string[],
  tx: DbQueryable
): Promise<Set<string>> {
  const { rows } = await tx.query<{ id: string }>(DOOMED_TABLES_SQL, [[...ids], [...projectIds]]);
  return new Set(rows.map((row) => row.id));
}

/** Tables other than `id` whose relation fields point at it. */
function linkOwners(linksTo: ReadonlyMap<string, TableLinkedField[]>, id: string): Set<string> {
  return new Set(
    (linksTo.get(id) ?? []).map((field) => field.tableId).filter((owner) => owner !== id)
  );
}

/**
 * The tables one drop takes. Without `limit`, all of them. With it, tables
 * fewer others link to first, while they and the tables linking to them
 * (locked to drop those fields) number at most `limit`: a table linked from
 * many waits until those are gone. Empty when every table has too many.
 */
function chooseBatch(
  doomed: readonly string[],
  owners: (id: string) => Set<string>,
  limit: number | undefined
): Set<string> {
  if (limit === undefined) return new Set(doomed);
  const batch = new Set<string>();
  const locked = new Set<string>();
  for (const id of [...doomed].sort((a, b) => owners(a).size - owners(b).size)) {
    const adds = [id, ...owners(id)].filter((table) => !locked.has(table));
    if (locked.size + adds.length > limit) continue;
    batch.add(id);
    for (const table of adds) locked.add(table);
  }
  return batch;
}

class TableLifecycleModelClass {
  /** Archived custom tables, newest first. */
  async listArchivedTables(): Promise<TableCatalogRow[]> {
    return TableCatalog.listTables({ origin: 'custom', state: 'archived' });
  }

  /**
   * Every archived field of every custom table that is not deleted (the
   * table itself may be active or archived), newest first, with its table.
   * Backs the Archived drawer's listing.
   */
  async listArchivedFieldsOfCustomTables(): Promise<
    Array<{ field: TableField; table: TableCatalogRow }>
  > {
    const db = getDb();
    const { rows } = await db.query<RawField>(
      `SELECT f.* FROM public.table_fields AS f
         JOIN public.table_catalog AS c ON c.id = f.table_id
        WHERE f.state = 'archived' AND c.origin = 'custom' AND c.state <> 'deleted'
        ORDER BY f.state_changed_at DESC NULLS LAST, f.id`
    );
    const tables = new Map<string, TableCatalogRow>();
    const listed: Array<{ field: TableField; table: TableCatalogRow }> = [];
    for (const raw of rows) {
      let table = tables.get(raw.table_id);
      if (!table) {
        table = (await TableCatalog.findById(raw.table_id)) ?? undefined;
        if (!table) continue;
        tables.set(raw.table_id, table);
      }
      listed.push({ field: toField(raw), table });
    }
    return listed;
  }

  /**
   * Drop a custom field for good right now, in any state (the archive's
   * "delete forever"; not undoable): its column and values, its metadata,
   * and every history step that needed it. Managed fields are a 403. The
   * table may be active or archived (deleted: 404). Returns the field as it
   * was and the undo stacks that lost steps.
   */
  async purgeField(
    tableId: string,
    fieldId: string
  ): Promise<{ field: TableField; historyActors: HistoryActor[] }> {
    try {
      return await transaction(async (tx) => {
        const tables = await TableFields.lockTables([tableId], tx);
        const table = tables.get(tableId);
        if (!table || table.state === 'deleted') throw notFound('Table');
        if (table.origin !== 'custom')
          throw new AppError('Snaglet tables cannot be changed', ErrorCode.FORBIDDEN, 403);
        const raw = await findField(fieldId, tx);
        if (!raw || raw.table_id !== tableId) throw notFound('Field');
        const historyActors = await dropFieldNow(table, fieldId, tx);
        return { field: toField(raw), historyActors: uniqueActors(historyActors) };
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }

  /** A custom table's archived fields, newest first (404 for an unknown or deleted table). */
  async listArchivedFields(tableId: string, runner?: DbQueryable): Promise<TableField[]> {
    const run = async (tx: DbQueryable) => {
      const row = await TableCatalog.findById(tableId, tx);
      if (!row || row.origin !== 'custom' || row.state === 'deleted') throw notFound('Table');
      const { rows } = await tx.query<RawField>(
        `SELECT * FROM public.table_fields WHERE table_id = $1 AND state = 'archived'
          ORDER BY state_changed_at DESC NULLS LAST, id`,
        [tableId]
      );
      return rows.map(toField);
    };
    return runner ? run(runner) : transaction(run);
  }

  // fields

  /** Archive (or delete) an active field in a caller's transaction holding the table's lock. */
  async retireFieldInTx(
    tables: LockedTables,
    tableId: string,
    fieldId: string,
    state: 'archived' | 'deleted',
    journal: HistoryJournal,
    tx: DbQueryable
  ): Promise<{ field: TableField; changed: boolean }> {
    const table = activeTable(tables.get(tableId));
    const raw = await fieldOf(table, fieldId, tx);
    if (raw.state === state) return { field: toField(raw), changed: false };
    if (raw.state === 'deleted') throw notFound('Field');
    const field = await retireField(table, fieldId, state, journal.stepId, tx);
    journal.ops.push({
      op: 'field.state',
      tableId,
      fieldId,
      name: raw.name,
      before: raw.state,
      after: state,
      ...activeSide(raw),
    });
    return { field, changed: true };
  }

  /** Restore an archived field in a caller's transaction holding the table's lock. */
  async restoreFieldInTx(
    tables: LockedTables,
    tableId: string,
    fieldId: string,
    name: string | undefined,
    journal: HistoryJournal,
    tx: DbQueryable
  ): Promise<{ field: TableField; changed: boolean; madeOptional: boolean }> {
    const table = activeTable(tables.get(tableId));
    const raw = await fieldOf(table, fieldId, tx);
    if (raw.state === 'deleted') throw notFound('Field');
    if (raw.state === 'active') return { field: toField(raw), changed: false, madeOptional: false };
    const restored = await restoreRetiredField(table, fieldId, name, tx);
    journal.ops.push({
      op: 'field.state',
      tableId,
      fieldId,
      name: restored.field.name,
      before: 'archived',
      after: 'active',
      revision: restored.field.revision,
      definition: storedDefinition(restored.field),
    });
    return { field: restored.field, changed: true, madeOptional: restored.madeOptional };
  }

  /** Make a text field the Name field in a caller's transaction holding the table's lock. */
  async setTitleFieldInTx(
    tables: LockedTables,
    tableId: string,
    fieldId: string,
    journal: HistoryJournal,
    tx: DbQueryable
  ): Promise<boolean> {
    activeTable(tables.get(tableId));
    const before = await currentTitleField(tableId, tx);
    if (before === fieldId) return false;
    await setTitleField(tableId, fieldId, tx);
    journal.ops.push({ op: 'field.title', tableId, before, after: fieldId });
    return true;
  }

  async archiveField(
    tableId: string,
    fieldId: string,
    history?: HistoryContext
  ): Promise<LifecycleResult<TableField>> {
    return this.retireField(tableId, fieldId, 'archived', history);
  }

  async deleteField(
    tableId: string,
    fieldId: string,
    history?: HistoryContext
  ): Promise<LifecycleResult<TableField>> {
    return this.retireField(tableId, fieldId, 'deleted', history);
  }

  private async retireField(
    tableId: string,
    fieldId: string,
    state: 'archived' | 'deleted',
    history?: HistoryContext
  ): Promise<LifecycleResult<TableField>> {
    return recorded(history, async (tx, journal) => {
      const tables = await TableFields.lockTables([tableId], tx);
      const { field, changed } = await this.retireFieldInTx(
        tables,
        tableId,
        fieldId,
        state,
        journal,
        tx
      );
      const table = activeTable(tables.get(tableId)).name;
      return {
        item: field,
        changed,
        summary:
          state === 'archived'
            ? stepLabels.fieldArchive(table, field.name)
            : stepLabels.fieldDelete(table, field.name),
      };
    });
  }

  async restoreField(
    tableId: string,
    fieldId: string,
    name: string | undefined,
    history?: HistoryContext
  ): Promise<LifecycleResult<TableField> & { madeOptional: boolean }> {
    let madeOptional = false;
    const result = await recorded(history, async (tx, journal) => {
      const tables = await TableFields.lockTables([tableId], tx);
      const restored = await this.restoreFieldInTx(tables, tableId, fieldId, name, journal, tx);
      madeOptional = restored.madeOptional;
      return {
        item: restored.field,
        changed: restored.changed,
        summary: stepLabels.fieldRestore(
          activeTable(tables.get(tableId)).name,
          restored.field.name
        ),
      };
    });
    return { ...result, madeOptional };
  }

  async setTitleField(
    tableId: string,
    fieldId: string,
    history?: HistoryContext
  ): Promise<LifecycleResult<TableField[]>> {
    return recorded(history, async (tx, journal) => {
      const tables = await TableFields.lockTables([tableId], tx);
      const changed = await this.setTitleFieldInTx(tables, tableId, fieldId, journal, tx);
      const fields = await TableFields.listFields(tableId, tx);
      const title = fields.find((field) => field.id === fieldId)?.name ?? fieldId;
      return {
        item: fields,
        changed,
        summary: stepLabels.fieldTitle(activeTable(tables.get(tableId)).name, title),
      };
    });
  }

  // tables

  /** Archive an active table in a caller's transaction holding its lock. */
  async archiveTableInTx(
    tables: LockedTables,
    tableId: string,
    journal: HistoryJournal,
    tx: DbQueryable
  ): Promise<{ table: TableCatalogRow; changed: boolean }> {
    const row = tables.get(tableId);
    if (!row || row.state === 'deleted') throw notFound('Table');
    if (row.state === 'archived') return { table: row, changed: false };
    const table = await retireTable(row, 'archived', null, tx);
    tables.set(tableId, table);
    journal.ops.push({
      op: 'table.state',
      tableId,
      name: row.name,
      before: 'active',
      after: 'archived',
    });
    return { table, changed: true };
  }

  /**
   * Delete an active or archived table in a caller's transaction, which holds
   * the locks of the table and of every table with a relation field linking
   * to it. Those relation fields are deleted in the same step when
   * `clearReferences` is true; otherwise they are a 409 listing them.
   */
  async deleteTableInTx(
    tables: LockedTables,
    tableId: string,
    clearReferences: boolean,
    journal: HistoryJournal,
    tx: DbQueryable
  ): Promise<{ table: TableCatalogRow; changed: boolean; linked: TableLinkedField[] }> {
    const row = tables.get(tableId);
    if (!row || row.state === 'deleted') throw notFound('Table');
    const linked = await linkedFields(tableId, tx);
    if (linked.length && !clearReferences)
      throw new AppError(
        `${linked.length === 1 ? 'A relation field links' : `${linked.length} relation fields link`} to ${row.name}: ${linked
          .map((field) => `${field.tableName}.${field.fieldName}`)
          .join(', ')}. Confirm to delete ${linked.length === 1 ? 'it' : 'them'} with the table.`,
        ErrorCode.CONFLICT,
        409,
        true,
        { linkedFields: linked }
      );
    for (const field of linked) {
      const owner = tables.get(field.tableId);
      if (!owner)
        throw new AppError(
          'The linked tables changed while this delete was prepared. Nothing was deleted; try again.',
          ErrorCode.CONFLICT,
          409
        );
      const raw = await fieldOf(owner, field.fieldId, tx);
      await retireField(owner, field.fieldId, 'deleted', journal.stepId, tx);
      journal.ops.push({
        op: 'field.state',
        tableId: field.tableId,
        fieldId: field.fieldId,
        name: raw.name,
        before: raw.state,
        after: 'deleted',
        ...activeSide(raw),
      });
    }
    const table = await retireTable(row, 'deleted', journal.stepId, tx);
    tables.set(tableId, table);
    journal.ops.push({
      op: 'table.state',
      tableId,
      name: row.name,
      before: row.state,
      after: 'deleted',
    });
    return { table, changed: true, linked };
  }

  /** Restore an archived table in a caller's transaction holding its lock. */
  async restoreTableInTx(
    tables: LockedTables,
    tableId: string,
    name: string | undefined,
    journal: HistoryJournal,
    tx: DbQueryable
  ): Promise<{ table: TableCatalogRow; changed: boolean }> {
    const row = tables.get(tableId);
    if (!row || row.state === 'deleted') throw notFound('Table');
    if (row.state === 'active') return { table: row, changed: false };
    const table = await restoreRetiredTable(row, name, tx);
    tables.set(tableId, table);
    journal.ops.push({
      op: 'table.state',
      tableId,
      name: table.name,
      before: 'archived',
      after: 'active',
    });
    return { table, changed: true };
  }

  async archiveTable(
    tableId: string,
    history?: HistoryContext
  ): Promise<LifecycleResult<TableCatalogRow>> {
    return recorded(history, async (tx, journal) => {
      const tables = await TableFields.lockTables([tableId], tx);
      const { table, changed } = await this.archiveTableInTx(tables, tableId, journal, tx);
      return { item: table, changed, summary: stepLabels.tableArchive(table.name) };
    });
  }

  async restoreTable(
    tableId: string,
    name: string | undefined,
    history?: HistoryContext
  ): Promise<LifecycleResult<TableCatalogRow>> {
    return recorded(history, async (tx, journal) => {
      const tables = await TableFields.lockTables([tableId], tx);
      const { table, changed } = await this.restoreTableInTx(tables, tableId, name, journal, tx);
      return { item: table, changed, summary: stepLabels.tableRestore(table.name) };
    });
  }

  async deleteTable(
    tableId: string,
    opts: { clearReferences?: boolean },
    history?: HistoryContext
  ): Promise<LifecycleResult<TableCatalogRow> & { linked: TableLinkedField[] }> {
    let linked: TableLinkedField[] = [];
    const result = await recorded(history, async (tx, journal) => {
      const current = await linkedFields(tableId, tx);
      const tables = await TableFields.lockTables(
        [tableId, ...current.map((field) => field.tableId)],
        tx
      );
      const outcome = await this.deleteTableInTx(
        tables,
        tableId,
        opts.clearReferences === true,
        journal,
        tx
      );
      linked = outcome.linked;
      return {
        item: outcome.table,
        changed: outcome.changed,
        summary: stepLabels.tableDelete(outcome.table.name),
      };
    });
    return { ...result, linked };
  }

  // project cohorts

  /**
   * Archive every active custom table homed in `projectIds` as one undoable
   * step, stamping each `state_changed_at` with `stamp` (the projects'
   * `archived_at`), so a later project restore can tell the tables archived
   * with it from ones archived on their own before. Returns the tables it
   * archived. Runs in `tx` when given (the project archive's own
   * transaction), so the two commit together.
   */
  async archiveProjectTables(
    projectIds: readonly string[],
    stamp: string,
    containerName: string,
    history?: HistoryContext,
    tx?: DbQueryable
  ): Promise<LifecycleResult<TableCatalogRow[]>> {
    if (!projectIds.length) return { item: [], changed: false, step: null };
    return recorded(
      history,
      async (tx, journal) => {
        const ids = await projectTableIds(projectIds, ['active'], tx);
        const tables = await TableFields.lockTables(ids, tx);
        const archived: TableCatalogRow[] = [];
        for (const id of ids) {
          const row = tables.get(id);
          // Re-checked under the lock: it may have moved or changed meanwhile.
          if (
            !row ||
            row.state !== 'active' ||
            !row.projectId ||
            !projectIds.includes(row.projectId)
          )
            continue;
          const { changed } = await this.archiveTableInTx(tables, id, journal, tx);
          if (!changed) continue;
          await tx.query(
            'UPDATE public.table_catalog SET state_changed_at = $2::timestamptz WHERE id = $1',
            [id, stamp]
          );
          const stamped = await TableCatalog.findById(id, tx);
          if (stamped) archived.push(stamped);
        }
        return {
          item: archived,
          changed: archived.length > 0,
          summary: stepLabels.projectTablesArchive(containerName, archived.length),
        };
      },
      tx
    );
  }

  /**
   * Restore the tables archived together with `projectIds` (archived, homed
   * in one of them, `state_changed_at` equal to `stamp`) as one undoable
   * step. Tables archived on their own stay archived. A table whose name was
   * taken meanwhile stays archived too and is returned in `skipped`, to be
   * restored under a new name from the archive. Runs in `tx` when given.
   */
  async restoreProjectTables(
    projectIds: readonly string[],
    stamp: string,
    containerName: string,
    history?: HistoryContext,
    tx?: DbQueryable
  ): Promise<LifecycleResult<TableCatalogRow[]> & { skipped: TableCatalogRow[] }> {
    const skipped: TableCatalogRow[] = [];
    if (!projectIds.length) return { item: [], changed: false, step: null, skipped };
    const result = await recorded(
      history,
      async (tx, journal) => {
        const { rows } = await tx.query<{ id: string }>(
          `SELECT id FROM public.table_catalog
          WHERE origin = 'custom' AND state = 'archived'
            AND project_id = ANY($1::text[])
            AND state_changed_at = $2::timestamptz
          ORDER BY id`,
          [[...projectIds], stamp]
        );
        const ids = rows.map((row) => row.id);
        const tables = await TableFields.lockTables(ids, tx);
        const restored: TableCatalogRow[] = [];
        for (const id of ids) {
          const row = tables.get(id);
          if (!row || row.state !== 'archived') continue;
          try {
            const { table, changed } = await this.restoreTableInTx(
              tables,
              id,
              undefined,
              journal,
              tx
            );
            if (changed) restored.push(table);
          } catch (error) {
            // The name check runs before any write, so the transaction is intact.
            if (error instanceof AppError && error.statusCode === 409) {
              skipped.push(row);
              continue;
            }
            throw error;
          }
        }
        return {
          item: restored,
          changed: restored.length > 0,
          summary: stepLabels.projectTablesRestore(containerName, restored.length),
        };
      },
      tx
    );
    return { ...result, skipped };
  }

  /**
   * Drop for good, in the caller's transaction, the custom tables homed in
   * `projectIds`, projects that are being deleted for good; not undoable. A
   * live project takes every table; an archived one takes its archived and
   * deleted tables, while an active one (restored on its own since) is left
   * for the foreign key to make workspace-wide, as a restored node is
   * re-parented out of an archived container. Relation fields between the
   * dropped tables go with them.
   * Relation fields of other tables that link to them are a 409
   * (`details.linkedFields`) under `outsideLinks: 'refuse'` (nothing
   * changed), are dropped too under `'clear'`, and under `'keep'` (the TTL
   * sweep) the linked tables are kept instead and returned in `kept`.
   *
   * `limit` caps the tables locked: the ones dropped and the ones whose
   * relation fields point at them (locked to drop those fields). Tables fewer
   * others link to go first; when every table has too many, only some of the
   * links go (`droppedFields`). `remaining` counts the tables left. Each
   * dropped table holds about a dozen locks until the transaction ends, so a
   * caller with hundreds of tables spreads them over transactions.
   *
   * The tables' catalog rows are locked before they are chosen, and checked
   * again under the schema locks: a table restored meanwhile is not dropped.
   * Restores the caller's lock and statement timeouts afterward, since the
   * schema locks set their own for the rest of the transaction.
   */
  async dropProjectTablesInTx(
    projectIds: readonly string[],
    outsideLinks: 'refuse' | 'clear' | 'keep',
    tx: DbQueryable,
    opts: { limit?: number } = {}
  ): Promise<{
    dropped: TableCatalogRow[];
    kept: string[];
    linked: TableLinkedField[];
    historyActors: HistoryActor[];
    remaining: number;
    droppedFields: number;
  }> {
    const none = {
      dropped: [],
      kept: [],
      linked: [],
      historyActors: [],
      remaining: 0,
      droppedFields: 0,
    };
    if (!projectIds.length) return none;
    const { rows: doomedRows } = await tx.query<{ id: string }>(
      `${DOOMED_TABLES_SQL} ORDER BY catalog.id FOR UPDATE OF catalog`,
      [null, [...projectIds]]
    );
    const ids = doomedRows.map((row) => row.id);
    if (!ids.length) return none;

    const doomed = new Set(ids);
    const linksTo = new Map<string, TableLinkedField[]>();
    for (const id of ids) linksTo.set(id, await linkedFields(id, tx));
    const outsideOf = () =>
      [...doomed].flatMap((id) =>
        (linksTo.get(id) ?? []).filter((field) => !doomed.has(field.tableId))
      );

    const kept: string[] = [];
    let outside = outsideOf();
    if (outside.length && outsideLinks === 'refuse')
      throw new AppError(
        `${outside.length === 1 ? 'A relation field in another table links' : `${outside.length} relation fields in other tables link`} to this project's tables: ${outside
          .map((field) => `${field.tableName}.${field.fieldName}`)
          .join(
            ', '
          )}. Remove ${outside.length === 1 ? 'it' : 'them'}, or confirm to delete ${outside.length === 1 ? 'it' : 'them'} too.`,
        ErrorCode.CONFLICT,
        409,
        true,
        { linkedFields: outside }
      );
    if (outsideLinks === 'keep') {
      // Keeping a linked table can make its own links to others "outside".
      while (outside.length) {
        for (const id of [...doomed])
          if ((linksTo.get(id) ?? []).some((field) => !doomed.has(field.tableId))) {
            doomed.delete(id);
            kept.push(id);
          }
        outside = outsideOf();
      }
      if (!doomed.size) return { ...none, kept };
    }

    const owners = (id: string) => linkOwners(linksTo, id);
    const batch = chooseBatch([...doomed], owners, opts.limit);
    const { rows: timeouts } = await tx.query<{ lock: string; statement: string }>(
      `SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`
    );
    const restoreTimeouts = async () => {
      const restore = timeouts[0];
      if (!restore) return;
      await tx.query(`SELECT set_config('lock_timeout', $1, true)`, [restore.lock]);
      await tx.query(`SELECT set_config('statement_timeout', $1, true)`, [restore.statement]);
    };
    const actors: HistoryActor[] = [];

    if (!batch.size) {
      // Every table has more tables linking to it than one transaction may
      // lock: drop the links of some of them to the one with fewest.
      const target = [...doomed].sort((a, b) => owners(a).size - owners(b).size)[0];
      if (!target) return { ...none, kept };
      const some = [...owners(target)].sort().slice(0, Math.max(1, (opts.limit ?? 1) - 1));
      const tables = await TableFields.lockTables([target, ...some], tx);
      const current = await stillDoomed([target, ...some], projectIds, tx);
      const fields = (linksTo.get(target) ?? []).filter(
        (field) =>
          some.includes(field.tableId) &&
          current.has(target) &&
          (current.has(field.tableId) || !doomed.has(field.tableId))
      );
      for (const field of fields) {
        const owner = tables.get(field.tableId);
        if (owner) actors.push(...(await dropFieldNow(owner, field.fieldId, tx)));
      }
      await restoreTimeouts();
      return {
        ...none,
        kept,
        linked: fields.filter((field) => !doomed.has(field.tableId)),
        historyActors: uniqueActors(actors),
        remaining: doomed.size,
        droppedFields: fields.length,
      };
    }

    const tables = await TableFields.lockTables(
      [...batch, ...[...batch].flatMap((id) => [...owners(id)])],
      tx
    );
    // Under the schema locks: drop only tables that still go with these
    // projects, and none a table left behind links to.
    const current = await stillDoomed([...batch], projectIds, tx);
    const left = [...batch].filter((id) => !current.has(id));
    for (const id of left) {
      batch.delete(id);
      doomed.delete(id);
    }
    for (const id of [...batch]) if (left.some((table) => owners(id).has(table))) batch.delete(id);
    const inside = [...doomed].flatMap((id) =>
      (linksTo.get(id) ?? []).filter(
        (field) => doomed.has(field.tableId) && (batch.has(id) || batch.has(field.tableId))
      )
    );
    const outsideOfBatch = [...batch].flatMap((id) =>
      (linksTo.get(id) ?? []).filter((field) => !doomed.has(field.tableId))
    );
    // Links first: a target dropped before its relation field would leave an
    // active field with no target, which the schema refuses.
    for (const field of [...inside, ...outsideOfBatch]) {
      const owner = tables.get(field.tableId);
      if (owner) actors.push(...(await dropFieldNow(owner, field.fieldId, tx)));
    }
    const dropped: TableCatalogRow[] = [];
    for (const id of batch) {
      const row = tables.get(id);
      if (!row) continue;
      actors.push(...(await dropTableNow(row, tx)));
      dropped.push(row);
    }
    await restoreTimeouts();
    return {
      dropped,
      kept,
      linked: outsideOfBatch,
      historyActors: uniqueActors(actors),
      remaining: doomed.size - dropped.length,
      droppedFields: inside.length + outsideOfBatch.length,
    };
  }

  /**
   * Drop an archived (or deleted, still undoable) table for good now: the
   * archive's "delete forever". Not an undo step. Relation fields of other
   * tables that link to it are a 409 (`details.linkedFields`) unless
   * `clearReferences`, which drops them too. An active table is a 409
   * (archive it first). Every history step that needed the table or those
   * fields goes too, since it could never apply again. Returns what was
   * dropped and the undo stacks that changed.
   */
  async purgeTable(
    tableId: string,
    opts: { clearReferences?: boolean }
  ): Promise<{
    table: TableCatalogRow;
    linked: TableLinkedField[];
    historyActors: HistoryActor[];
  }> {
    try {
      return await transaction(async (tx) => {
        const current = await linkedFields(tableId, tx);
        const tables = await TableFields.lockTables(
          [tableId, ...current.map((field) => field.tableId)],
          tx
        );
        const row = tables.get(tableId);
        if (!row) throw notFound('Table');
        if (row.state === 'active')
          throw new AppError(
            `${row.name} is not archived. Archive it before deleting it for good.`,
            ErrorCode.CONFLICT,
            409
          );
        const linked = await linkedFields(tableId, tx);
        if (linked.length && opts.clearReferences !== true)
          throw new AppError(
            `${linked.length === 1 ? 'A relation field links' : `${linked.length} relation fields link`} to ${row.name}: ${linked
              .map((field) => `${field.tableName}.${field.fieldName}`)
              .join(', ')}. Confirm to delete ${linked.length === 1 ? 'it' : 'them'} too.`,
            ErrorCode.CONFLICT,
            409,
            true,
            { linkedFields: linked }
          );
        const actors: HistoryActor[] = [];
        for (const field of linked) {
          const owner = tables.get(field.tableId);
          if (owner) actors.push(...(await dropFieldNow(owner, field.fieldId, tx)));
        }
        actors.push(...(await dropTableNow(row, tx)));
        return { table: row, linked, historyActors: uniqueActors(actors) };
      });
    } catch (error) {
      throw mapFieldDatabaseError(error);
    }
  }
}

export const TableLifecycle = new TableLifecycleModelClass();
