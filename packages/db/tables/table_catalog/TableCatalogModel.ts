import { createHash } from 'node:crypto';
import { Model } from '@snaglet/db/Model';
import type { DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { CUSTOM_TABLES_SCHEMA } from '@snaglet/db/runtime/postgres/readerRole';
import { Projects } from '@snaglet/db/tables/projects';
import {
  BUILTIN_TABLE_ID_PREFIX,
  TABLE_LIFECYCLE_STATES,
  TABLE_ORIGINS,
  TABLE_PROJECT_FILTER_NONE,
  type TableCatalogEntry,
  type TableLifecycleState,
  type TableOrigin,
  type TableProjectFilter,
} from '@snaglet/shared/types';

/**
 * One `public.table_catalog` row. `tableName` is the physical table inside
 * the origin's schema (see {@link schemaForOrigin}); it stays server-side and
 * never appears in {@link TableCatalogEntry}.
 */
export interface TableCatalogRow {
  id: string;
  /** Display name; an archived or deleted table keeps its old one here. */
  name: string;
  /** Physical name; a retired table's is its tombstone (see {@link tombstoneName}). */
  tableName: string;
  origin: TableOrigin;
  /**
   * Optional project home — a container with `category='project'` — or null
   * for a workspace-wide table. Always null for built-in tables.
   */
  projectId: string | null;
  /**
   * Manual position within the `projectId` bucket, ascending. Built-in tables
   * are not reorderable and keep 0.
   */
  sortOrder: number;
  createdAt: string;
  state: TableLifecycleState;
  /** When it was archived or deleted (null while active). */
  stateChangedAt: string | null;
  /** The history step keeping a deleted table (null otherwise). */
  heldBy: string | null;
}

export interface RegisterCustomTableInput {
  id: string;
  name: string;
  tableName: string;
  /** Project home (a live project container); null or omitted = workspace-wide. */
  projectId?: string | null;
}

/**
 * Where {@link TableCatalogModelClass.place} puts a custom table. `projectId`
 * omitted keeps the current home; `sortOrder` omitted means the bottom on a
 * project change and "leave it where it is" otherwise.
 */
export interface TablePlacementInput {
  projectId?: string | null;
  sortOrder?: number;
}

/** A placed table and every sibling the placement shifted down. */
export interface TablePlacementResult {
  table: TableCatalogRow;
  shifted: TableCatalogRow[];
}

export interface ListTablesOptions {
  origin?: TableOrigin;
  /** Defaults to `active`. */
  state?: TableLifecycleState;
  /**
   * A project container id lists that project's tables;
   * `TABLE_PROJECT_FILTER_NONE` ('none') lists workspace-wide tables (no
   * project home); omitted lists every table.
   */
  projectId?: TableProjectFilter;
}

export { CUSTOM_TABLES_SCHEMA };

/** Matches the `table_catalog_table_name_check` constraint. */
export const PHYSICAL_TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function schemaForOrigin(origin: TableOrigin): 'public' | typeof CUSTOM_TABLES_SCHEMA {
  return origin === 'builtin' ? 'public' : CUSTOM_TABLES_SCHEMA;
}

export function isTableOrigin(value: unknown): value is TableOrigin {
  return typeof value === 'string' && (TABLE_ORIGINS as readonly string[]).includes(value);
}

export function isTableLifecycleState(value: unknown): value is TableLifecycleState {
  return typeof value === 'string' && (TABLE_LIFECYCLE_STATES as readonly string[]).includes(value);
}

interface RawTableCatalogRow {
  id: string;
  name: string;
  table_name: string;
  origin: string;
  project_id: string | null;
  sort_order: number;
  created_at: string;
  state: string;
  state_changed_at: string | null;
  held_by: string | null;
}

function rawToRow(raw: RawTableCatalogRow): TableCatalogRow {
  if (!isTableOrigin(raw.origin)) {
    throw new Error(`table_catalog row ${raw.id} has unknown origin ${raw.origin}`);
  }
  if (!isTableLifecycleState(raw.state)) {
    throw new Error(`table_catalog row ${raw.id} has unknown state ${raw.state}`);
  }
  return {
    id: raw.id,
    name: raw.name,
    tableName: raw.table_name,
    origin: raw.origin,
    projectId: raw.project_id,
    sortOrder: raw.sort_order,
    createdAt: raw.created_at,
    state: raw.state,
    stateChangedAt: raw.state_changed_at,
    heldBy: raw.held_by,
  };
}

/**
 * Project a catalog row onto the wire entry (drops the physical name). An
 * active table's entry has no lifecycle keys, so its shape is unchanged.
 */
export function toTableCatalogEntry(row: TableCatalogRow): TableCatalogEntry {
  const entry: TableCatalogEntry = {
    id: row.id,
    name: row.name,
    origin: row.origin,
    projectId: row.projectId,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
  };
  if (row.state === 'active') return entry;
  return {
    ...entry,
    state: row.state,
    ...(row.stateChangedAt ? { archivedAt: row.stateChangedAt } : {}),
  };
}

/**
 * The physical name a retired (archived or deleted) table or field column
 * takes, named after its stable id so the display name is free at once:
 * `_snaglet_` plus the id with every other character `_`, or an md5 of the id when
 * that would not fit (matches the tombstone-name CHECKs).
 */
export function tombstoneName(id: string): string {
  const plain = `_snaglet_${id.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  if (plain.length <= 63 && /^[a-z0-9-]+$/.test(id)) return plain;
  return `_snaglet_${createHash('md5').update(id).digest('hex')}`;
}

const SELECT_COLUMNS =
  'id, name, table_name, origin, project_id, sort_order, created_at, state, state_changed_at, held_by';

/** Reject a table slot the integer `sort_order` column would refuse, or a negative one. */
function assertTableSlot(value: unknown): asserts value is number | undefined {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Table sortOrder must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

/**
 * SQL for the slot after the last live custom table in the `project` bucket
 * (an SQL expression; NULL = workspace-wide), leaving out the table whose id
 * is the `except` expression when given.
 */
function bottomSlotSql(project: string, except?: string): string {
  return `(SELECT COALESCE(MAX(sort_order), -1) + 1
             FROM public.table_catalog
            WHERE origin = 'custom' AND state = 'active'
              AND project_id IS NOT DISTINCT FROM ${project}${except ? ` AND id <> ${except}` : ''})`;
}

/**
 * System column holding each custom-table entry's row order.
 * Keys share the epoch-millisecond domain of `created_at`, so the default puts
 * a new row last; it is never registered as a field.
 */
export const ENTRY_POSITION_COLUMN = 'position';

/** Stable prefix for objects named after a custom table (its key and indexes). */
function tableObjectKey(tableId: string): string {
  return tableId.replace(/-/g, '_');
}

class TableCatalogModelClass extends Model<TableCatalogRow> {
  constructor() {
    super({
      table: 'table_catalog',
      primaryKey: 'id',
      columnMap: { tableName: 'table_name', createdAt: 'created_at' },
      updatedAtColumn: null,
    });
  }

  /**
   * Catalog rows in one lifecycle state (default: active), optionally filtered
   * by origin. Deterministic order: builtin before custom (`ORDER BY origin`),
   * then the manual `sort_order`, then case-insensitive name, then id as the
   * tiebreaker; archived and deleted tables list newest first instead.
   */
  async listTables(
    opts: ListTablesOptions = {},
    runner: DbQueryable = this.pool
  ): Promise<TableCatalogRow[]> {
    const params: unknown[] = [opts.state ?? 'active'];
    let where = 'WHERE state = $1';
    if (opts.origin !== undefined) {
      params.push(opts.origin);
      where += ` AND origin = $${params.length}`;
    }
    if (opts.projectId === TABLE_PROJECT_FILTER_NONE) {
      where += ' AND project_id IS NULL';
    } else if (opts.projectId !== undefined) {
      params.push(opts.projectId);
      where += ` AND project_id = $${params.length}`;
    }
    const order =
      (opts.state ?? 'active') === 'active'
        ? 'origin ASC, sort_order ASC, lower(name) ASC, id ASC'
        : 'state_changed_at DESC NULLS LAST, id ASC';
    const { rows } = await runner.query<RawTableCatalogRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM public.table_catalog
         ${where}
        ORDER BY ${order}`,
      params
    );
    return rows.map(rawToRow);
  }

  override async findById(
    id: string | number,
    runner: DbQueryable = this.pool
  ): Promise<TableCatalogRow | null> {
    const { rows } = await runner.query<RawTableCatalogRow>(
      `SELECT ${SELECT_COLUMNS} FROM public.table_catalog WHERE id = $1`,
      [String(id)]
    );
    const raw = rows[0];
    return raw ? rawToRow(raw) : null;
  }

  async findByTable(
    origin: TableOrigin,
    tableName: string,
    runner: DbQueryable = this.pool
  ): Promise<TableCatalogRow | null> {
    const { rows } = await runner.query<RawTableCatalogRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM public.table_catalog
        WHERE origin = $1 AND table_name = $2`,
      [origin, tableName]
    );
    const raw = rows[0];
    return raw ? rawToRow(raw) : null;
  }

  /**
   * Case-insensitive display-name lookup across both origins. Archived and
   * deleted tables have given their names up, so only active tables match.
   */
  async findByName(name: string, runner: DbQueryable = this.pool): Promise<TableCatalogRow | null> {
    const { rows } = await runner.query<RawTableCatalogRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM public.table_catalog
        WHERE lower(name) = lower($1) AND state = 'active'`,
      [name]
    );
    const raw = rows[0];
    return raw ? rawToRow(raw) : null;
  }

  /**
   * Insert a `custom` catalog row in project `projectId` (null or omitted =
   * workspace-wide), at the bottom of that list. A project is checked first
   * by `Projects.assertProjectContainer` (404 unknown, 400 not a live
   * project), which holds the project's node row until the write commits, as
   * {@link place} does; the database repeats the category check in
   * `trg_table_catalog_project_scope_guard`. Pass the caller's transaction as
   * `runner` so the row commits (or rolls back) with the physical table it
   * describes; this method never opens or commits a transaction of its own.
   * Unique violations (id, name, table) surface as the driver's error for the
   * caller to classify.
   */
  async registerCustom(
    input: RegisterCustomTableInput,
    runner: DbQueryable = this.pool
  ): Promise<TableCatalogRow> {
    if (input.id.startsWith(BUILTIN_TABLE_ID_PREFIX)) {
      throw new Error(`Custom table id may not use the reserved prefix: ${input.id}`);
    }
    if (!PHYSICAL_TABLE_NAME_PATTERN.test(input.tableName)) {
      throw new Error(`Invalid physical table name: ${input.tableName}`);
    }
    const projectId = input.projectId ?? null;
    await Projects.assertProjectContainer(projectId, runner);
    const { rows } = await runner.query<RawTableCatalogRow>(
      `INSERT INTO public.table_catalog (id, name, table_name, origin, project_id, sort_order)
       VALUES ($1, $2, $3, 'custom', $4, ${bottomSlotSql('$4')})
       RETURNING ${SELECT_COLUMNS}`,
      [input.id, input.name, input.tableName, projectId]
    );
    const raw = rows[0];
    if (!raw) throw new Error(`table_catalog insert returned no row for ${input.id}`);
    return rawToRow(raw);
  }

  /**
   * Rename a `custom` table, only while it still reads `expectedName` (exact
   * match): the physical `user_tables` table is renamed and the catalog row
   * follows, so the name stays the real table name. Returns the updated row, or
   * null when no custom row with that id has that name — the caller re-reads to
   * tell a missing, built-in or concurrently renamed table apart. The catalog id
   * never changes. Must run inside the caller's transaction (`runner`); a name
   * taken by another table surfaces as the driver's unique or duplicate-table
   * violation.
   */
  async renameCustom(
    id: string,
    name: string,
    expectedName: string,
    runner: DbQueryable
  ): Promise<TableCatalogRow | null> {
    if (!PHYSICAL_TABLE_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid physical table name: ${name}`);
    }
    const { rows: current } = await runner.query<{ table_name: string }>(
      `SELECT table_name FROM public.table_catalog
        WHERE id = $1 AND origin = 'custom' AND state = 'active' AND name = $2 FOR UPDATE`,
      [id, expectedName]
    );
    const from = current[0]?.table_name;
    if (!from) return null;
    if (from !== name) {
      await runner.query(
        `ALTER TABLE ${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(from)} RENAME TO ${quoteIdentifier(name)}`
      );
    }
    const { rows } = await runner.query<RawTableCatalogRow>(
      `UPDATE public.table_catalog
          SET name = $2, table_name = $2
        WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, name]
    );
    const raw = rows[0];
    return raw ? rawToRow(raw) : null;
  }

  /**
   * Move a live custom table into project `projectId`, or out to the
   * workspace level with null — the bottom of that list. Shorthand for
   * {@link place} with no slot; returns the placed row (the unchanged one
   * when it already has that home), or null as {@link place} does.
   */
  async setProject(
    id: string,
    projectId: string | null,
    runner: DbQueryable
  ): Promise<TableCatalogRow | null> {
    return (await this.place(id, { projectId }, runner))?.table ?? null;
  }

  /**
   * Atomic "drop to position" for a live custom table, inside the caller's
   * transaction (`runner`): put it at `sortOrder` in the target bucket
   * (`projectId`, null = workspace-wide; omitted = its current home),
   * shifting every live custom sibling at that slot or later down by one — the
   * same contract as `ContainerModel.moveTo`, scoped by `project_id`. A
   * project change without a slot lands at the bottom (after the last live
   * custom table there); neither field changing anything is a no-op.
   *
   * The catalog row is locked FOR UPDATE and the write applies only while the
   * row is still `custom` and `active`, so a concurrent archive is never
   * overtaken. A target other than the current home is checked by
   * `Projects.assertProjectContainer` (404 unknown, 400 not a live project),
   * which holds the project's node row until the write commits; the database
   * repeats the category check in `trg_table_catalog_project_scope_guard`.
   * Returns the placed row plus every sibling the shift moved (so the caller
   * can announce each), or null when no live custom row has that id — the
   * caller re-reads to tell a missing, built-in, archived or deleted table
   * apart and owns the wording of that refusal.
   */
  async place(
    id: string,
    placement: TablePlacementInput,
    runner: DbQueryable
  ): Promise<TablePlacementResult | null> {
    assertTableSlot(placement.sortOrder);
    const { rows: locked } = await runner.query<RawTableCatalogRow>(
      `SELECT ${SELECT_COLUMNS} FROM public.table_catalog WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const current = locked[0] ? rawToRow(locked[0]) : null;
    if (!current || current.origin !== 'custom' || current.state !== 'active') return null;
    const target = placement.projectId !== undefined ? placement.projectId : current.projectId;
    const projectChanged = target !== current.projectId;
    if (!projectChanged && placement.sortOrder === undefined) {
      return { table: current, shifted: [] };
    }
    if (projectChanged) await Projects.assertProjectContainer(target, runner);

    if (placement.sortOrder === undefined) {
      const { rows } = await runner.query<RawTableCatalogRow>(
        `UPDATE public.table_catalog
            SET project_id = $2, sort_order = ${bottomSlotSql('$2', '$1')}
          WHERE id = $1 AND origin = 'custom' AND state = 'active'
         RETURNING ${SELECT_COLUMNS}`,
        [id, target]
      );
      const raw = rows[0];
      return raw ? { table: rawToRow(raw), shifted: [] } : null;
    }

    // One statement: the shift and the placement read the same snapshot, so
    // the shift's `id <> $1` leaves the placed row to the second UPDATE. An
    // unchanged home is not rewritten, so the scope guard does not re-run.
    const sets = projectChanged ? 'project_id = $2, sort_order = $3' : 'sort_order = $3';
    const { rows } = await runner.query<RawTableCatalogRow & { placed: boolean }>(
      `WITH shifted AS (
         UPDATE public.table_catalog
            SET sort_order = sort_order + 1
          WHERE origin = 'custom' AND state = 'active'
            AND project_id IS NOT DISTINCT FROM $2
            AND id <> $1
            AND sort_order >= $3
         RETURNING ${SELECT_COLUMNS}
       ),
       placed AS (
         UPDATE public.table_catalog
            SET ${sets}
          WHERE id = $1 AND origin = 'custom' AND state = 'active'
         RETURNING ${SELECT_COLUMNS}
       )
       SELECT ${SELECT_COLUMNS}, true AS placed FROM placed
       UNION ALL
       SELECT ${SELECT_COLUMNS}, false AS placed FROM shifted
       ORDER BY placed DESC, sort_order ASC, id ASC`,
      [id, target, placement.sortOrder]
    );
    const placedRaw = rows.find((row) => row.placed);
    if (!placedRaw) return null;
    return {
      table: rawToRow(placedRaw),
      shifted: rows.filter((row) => !row.placed).map(rawToRow),
    };
  }

  /**
   * Create the physical `user_tables.<tableName>` table with its system columns:
   * `id`, `created_at`, and the indexed row-order `position`. `tableName` is
   * the table's validated snake_case name. The primary key and index are named
   * after the stable `tableId`, so later renames leave nothing stale behind.
   * Pass the caller's transaction as `runner`.
   */
  async createCustomPhysicalTable(
    tableName: string,
    tableId: string,
    runner: DbQueryable
  ): Promise<void> {
    if (!PHYSICAL_TABLE_NAME_PATTERN.test(tableName)) {
      throw new Error(`Invalid physical table name: ${tableName}`);
    }
    const table = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(tableName)}`;
    const position = quoteIdentifier(ENTRY_POSITION_COLUMN);
    const key = tableObjectKey(tableId);
    await runner.query(
      `CREATE TABLE ${table} (
         id uuid CONSTRAINT ${quoteIdentifier(`${key}_pkey`)} PRIMARY KEY DEFAULT gen_random_uuid(),
         created_at timestamptz NOT NULL DEFAULT now(),
         ${position} double precision NOT NULL DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)
       )`
    );
    await runner.query(
      `CREATE INDEX ${quoteIdentifier(`${key}_position_idx`)} ON ${table} (${position}, created_at, id)`
    );
  }

  /** Physical columns of a catalog row's table, in ordinal order. */
  async physicalColumns(
    row: Pick<TableCatalogRow, 'origin' | 'tableName'>,
    runner: DbQueryable = this.pool
  ): Promise<PhysicalColumn[]> {
    const { rows } = await runner.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [schemaForOrigin(row.origin), row.tableName]
    );
    return rows.map((column) => ({
      name: column.column_name,
      dataType: column.data_type,
      nullable: column.is_nullable === 'YES',
    }));
  }

  /**
   * Exact row count of a catalog row's table. Counting is metadata, never row
   * contents, so it is allowed even for the credential tables that
   * `IMMUTABLE_DATABASE_TABLES` closes to reads.
   */
  async physicalRowCount(
    row: Pick<TableCatalogRow, 'origin' | 'tableName'>,
    runner: DbQueryable = this.pool
  ): Promise<number> {
    const target = `${quoteIdentifier(schemaForOrigin(row.origin))}.${quoteIdentifier(row.tableName)}`;
    const { rows } = await runner.query<{ n: number | bigint }>(
      `SELECT count(*)::int8 AS n FROM ${target}`
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * A custom table's row count, reading at most `cap + 1` rows: past `cap` it
   * reports `cap` and `capped`. A missing physical table counts as empty; on
   * a pool runner only, since the error would abort a caller's transaction.
   */
  async boundedRowCount(
    row: Pick<TableCatalogRow, 'tableName'>,
    cap: number,
    runner: DbQueryable = this.pool
  ): Promise<{ rows: number; capped: boolean }> {
    const target = `${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(row.tableName)}`;
    try {
      const { rows } = await runner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM ONLY ${target} LIMIT $1) AS bounded`,
        [cap + 1]
      );
      const n = Number(rows[0]?.n ?? 0);
      return n > cap ? { rows: cap, capped: true } : { rows: n, capped: false };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === '42P01') return { rows: 0, capped: false };
      throw error;
    }
  }
}

export interface PhysicalColumn {
  name: string;
  /** PostgreSQL `information_schema.columns.data_type`. */
  dataType: string;
  nullable: boolean;
}

export const TableCatalog = new TableCatalogModelClass();
