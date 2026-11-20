/**
 * Database tables — wire schema shared by the server table routes and the
 * desktop Database sidebar/pane.
 *
 * `public.table_catalog` lists both Snaglet's own tables (`builtin`, seeded by
 * migration, schema migration-managed) and user-created tables (`custom`, one
 * real PostgreSQL table each in the dedicated `user_tables` schema). A catalog
 * id is a stable table identity — it is not a workspace node id, and the
 * physical table name never crosses the wire.
 */

export const TABLE_ORIGINS = ['builtin', 'custom'] as const;
export type TableOrigin = (typeof TABLE_ORIGINS)[number];

/** Prefix every seeded built-in id carries; custom ids may never use it. */
export const BUILTIN_TABLE_ID_PREFIX = 'table-builtin-';

/**
 * Custom table ids are `generateId('table')` values, minted by the client when
 * a draft opens so a retried create is idempotent.
 */
export const CUSTOM_TABLE_ID_PATTERN = /^table-\d{13}-[a-z0-9]{1,12}$/;

/**
 * Any catalog id: a seeded built-in (`table-builtin-<slug>`) or a custom id.
 * Table chips are `table:<catalog id>` links; id-only chip inputs store the
 * bare catalog id. Catalog ids are never workspace node ids.
 */
export const TABLE_CATALOG_ID_PATTERN = /^table-(?:builtin-[a-z][a-z0-9-]*|\d{13}-[a-z0-9]{1,12})$/;

export function isTableCatalogId(value: string): boolean {
  return TABLE_CATALOG_ID_PATTERN.test(value);
}

/** Display-name bounds (trimmed). Names are unique case-insensitively. */
export const TABLE_NAME_MAX_LENGTH = 63;

/**
 * A custom table or field's lifecycle. `archived` is hidden and kept until
 * restored; `deleted` is hidden and kept only while the step that deleted it
 * is still in its actor's undo history.
 */
export const TABLE_LIFECYCLE_STATES = ['active', 'archived', 'deleted'] as const;
export type TableLifecycleState = (typeof TABLE_LIFECYCLE_STATES)[number];

/**
 * Project filter for listing tables: a project container id, or
 * {@link TABLE_PROJECT_FILTER_NONE} for tables with no project home.
 */
export const TABLE_PROJECT_FILTER_NONE = 'none';
export type TableProjectFilter = string | typeof TABLE_PROJECT_FILTER_NONE;

/** One catalog row as every read returns it. */
export interface TableCatalogEntry {
  id: string;
  /** Friendly display name. */
  name: string;
  origin: TableOrigin;
  /**
   * Optional project home: a container id with `category = 'project'`, or
   * null for a workspace-wide table. Always null for built-in tables.
   */
  projectId: string | null;
  /**
   * Manual position within its project's table list (or the workspace-wide
   * list), ascending. Lists show built-in tables first, then this order, then
   * name. Built-in tables are not reorderable and always carry 0.
   */
  sortOrder: number;
  createdAt: string;
  /** Present only for a table that is not active (archived, or deleted but undoable). */
  state?: Exclude<TableLifecycleState, 'active'>;
  /** When it was archived or deleted; present with `state`. */
  archivedAt?: string;
}

/** A physical column, from PostgreSQL introspection. */
export interface TableColumnSummary {
  name: string;
  /** PostgreSQL `data_type` as reported by information_schema. */
  dataType: string;
  nullable: boolean;
  /** True for server-managed columns (a custom table's `id` / `created_at`). */
  managed: boolean;
}

/** GET /api/tables */
export interface TableListResponse {
  tables: TableCatalogEntry[];
}

/** GET /api/tables/:id — metadata only; never row contents. */
export interface TableDetailResponse {
  table: TableCatalogEntry;
  columns: TableColumnSummary[];
  rowCount: number;
}

/** POST /api/tables */
export interface CreateTableRequest {
  /** Client-minted custom id (see CUSTOM_TABLE_ID_PATTERN). */
  id: string;
  /** Display name; new tables must pass the shared tableNameProblem policy. */
  name: string;
  /**
   * Project home for the new table: a live container with
   * `category = 'project'` (an unknown id is a 404; a folder, a thread or an
   * archived project a 400), or null / absent for a workspace-wide table.
   * The table lands at the bottom of that list, in the same transaction as
   * the create. An idempotent replay of an existing id ignores it and
   * returns the table where it is.
   */
  projectId?: string | null;
}

/** POST /api/tables — 201 on create, 200 on an idempotent replay. */
export interface CreateTableResponse {
  table: TableCatalogEntry;
}

/**
 * PATCH /api/tables/:id — rename a custom table (built-ins are refused).
 * `expectedName` is the name the client last saw; a mismatch is a 409 whose
 * `details.table` carries the current entry, so a stale rename never
 * silently overwrites someone else's.
 */
export interface RenameTableRequest {
  /** New display name; must pass the shared tableNameProblem policy. */
  name: string;
  expectedName: string;
}

/** PATCH /api/tables/:id */
export interface RenameTableResponse {
  table: TableCatalogEntry;
}

/**
 * PATCH /api/tables/:id — place a custom table. At least one field:
 *   - `projectId`: move it into a project, or out to the workspace level
 *     (`null`). Without `sortOrder` it lands at the bottom of that list.
 *   - `sortOrder`: a non-negative slot in the (target) list; every live
 *     custom table at that slot or later shifts down by one, and each one
 *     that moved is announced with its own `table.updated`.
 * Built-in tables are refused (400); a `projectId` that is not a live project
 * container is a 400 (404 unknown); an archived table is a 409.
 */
export interface UpdateTablePlacementRequest {
  projectId?: string | null;
  sortOrder?: number;
}

/** PATCH /api/tables/:id with a placement body. */
export interface SetTableProjectResponse {
  table: TableCatalogEntry;
}
