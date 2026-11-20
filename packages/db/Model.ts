/**
 * Model — Base class for typed table access.
 *
 * Provides standard CRUD, filtering, pagination, and column mapping
 * so that individual table modules only need to declare their schema
 * and add custom queries.
 *
 * Usage:
 *   class Agent extends Model<AgentRow, CreateAgentInput, UpdateAgentInput> {
 *     constructor() {
 *       super({ table: 'agents', primaryKey: 'id' });
 *     }
 *   }
 *   export const AgentModel = new Agent();
 */

import { getDb, type DbQueryable } from './db';
// Minimal query-row shape. The `any` index signature
// (matching pg's own QueryResultRow) is what lets concrete row interfaces
// satisfy the generic constraint on `.query<Row>()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryResultRow = { [column: string]: any };
import { quoteIdentifier, buildFilterClause, type FilterValue } from './sql-utils';
import { clamp } from '@snaglet/shared/utils/math';
import { snakeToCamel } from '@snaglet/shared/utils/strings';

/** Column mapping: camelCase property name → snake_case DB column. */
export type ColumnMap = Record<string, string>;

/** Options for list/find queries. */
export interface ListOptions {
  where?: Record<string, FilterValue>;
  orderBy?: string;
  order?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
  columns?: string[];
}

/** Options for count queries. */
export interface CountOptions {
  where?: Record<string, FilterValue>;
  schemaName?: string;
}

/** Options for schema introspection helpers. */
export interface IntrospectionOptions {
  schemaName?: string;
}

export type DbObjectKind = 'table' | 'view' | 'materialized_view' | 'unknown';

export type ConstraintType =
  | 'primary_key'
  | 'unique'
  | 'foreign_key'
  | 'check'
  | 'exclude'
  | 'unknown';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue: string | null;
}

export interface ConstraintInfo {
  name: string;
  type: ConstraintType;
  definition: string;
}

export interface IndexInfo {
  name: string;
  definition: string;
}

export interface ViewDataSource<Row extends object = Record<string, unknown>> {
  readonly table: string;
  objectKind(opts?: IntrospectionOptions): Promise<DbObjectKind>;
  columns(opts?: IntrospectionOptions): Promise<ColumnInfo[]>;
  constraints(opts?: IntrospectionOptions): Promise<ConstraintInfo[]>;
  indexes(opts?: IntrospectionOptions): Promise<IndexInfo[]>;
  relationDescription(opts?: IntrospectionOptions): Promise<string | null>;
  relationSize(opts?: IntrospectionOptions): Promise<string | null>;
  count(opts?: CountOptions): Promise<number>;
  sample(limit?: number, opts?: IntrospectionOptions): Promise<Row[]>;
}

/** Definition passed to the Model constructor. */
export interface ModelDefinition {
  /** The SQL table name. */
  table: string;
  /** Primary key column (default: 'id'). */
  primaryKey?: string;
  /**
   * camelCase → snake_case column map for input/output translation.
   * Only map columns that differ. Columns not listed are assumed
   * to be the same in both JS and SQL (e.g. `id`, `name`, `role`).
   */
  columnMap?: ColumnMap;
  /**
   * Custom SELECT expression. Use this when the base table needs JOINs
   * or computed columns. Must include FROM and any JOINs.
   * The table alias must be `t`.
   *
   * Example: `SELECT t.*, upc.provider_id FROM agents t LEFT JOIN ...`
   */
  selectExpression?: string;
  /**
   * Columns to include in the default SELECT. If not set, uses `*`.
   * Ignored when `selectExpression` is provided.
   */
  defaultColumns?: string[];
  /** Timestamp column to auto-update on mutations (default: 'updated_at'). Set to null to disable. */
  updatedAtColumn?: string | null;
  /**
   * Timestamp column representing row creation (default: 'created_at'). Set to null to disable.
   * Used by read-path helpers (list/latest/oldest/recentlyUpdated) to pick a default ORDER BY column.
   * When both createdAtColumn and updatedAtColumn are null, ordering falls back to the primary key.
   */
  createdAtColumn?: string | null;
  /**
   * Postgres schema this table lives in. Defaults to 'public'.
   * Used for both information_schema introspection (loadColumns) and all
   * generated CRUD SQL.
   */
  schema?: string;
}

export class Model<
  Row extends object = Record<string, unknown>,
  CreateInput extends object = Record<string, unknown>,
  UpdateInput extends object = Record<string, unknown>,
> implements ViewDataSource<Row> {
  readonly table: string;
  readonly schema: string;
  readonly primaryKey: string;
  private readonly selectExpr: string | null;
  private readonly defaultCols: string;
  private readonly updatedAtCol: string | null;
  private readonly createdAtCol: string | null;

  /**
   * Explicit overrides provided at construction time.
   * These take priority over auto-discovered mappings.
   */
  private readonly columnMapOverrides: ColumnMap;

  /**
   * Lazily populated column maps.
   * Built on first DB call from information_schema + overrides.
   */
  private _columnMap: ColumnMap | null = null;
  private _reverseMap: Record<string, string> | null = null;
  private _jsonbColumns: Set<string> = new Set();
  private _columnInitPromise: Promise<void> | null = null;

  constructor(def: ModelDefinition) {
    this.table = def.table;
    this.schema = def.schema ?? 'public';
    this.primaryKey = def.primaryKey ?? 'id';
    this.columnMapOverrides = def.columnMap ?? {};
    this.updatedAtCol = def.updatedAtColumn === undefined ? 'updated_at' : def.updatedAtColumn;
    this.createdAtCol = def.createdAtColumn === undefined ? 'created_at' : def.createdAtColumn;
    this.selectExpr = def.selectExpression ?? null;

    if (def.defaultColumns && def.defaultColumns.length > 0) {
      this.defaultCols = def.defaultColumns.map((c) => quoteIdentifier(c)).join(', ');
    } else {
      this.defaultCols = '*';
    }
  }

  /** Schema-qualified, quoted table reference (e.g. `"public"."messages"`). */
  protected get qualifiedTable(): string {
    return `${quoteIdentifier(this.schema)}.${quoteIdentifier(this.table)}`;
  }

  /**
   * Ensure column maps are populated. Called once, then cached.
   * Queries information_schema to discover all columns, then builds
   * camelCase↔snake_case mappings automatically.
   */
  protected async ensureColumnMap(): Promise<void> {
    if (this._columnMap) return;
    if (this._columnInitPromise) {
      await this._columnInitPromise;
      return;
    }

    this._columnInitPromise = this._initColumnMap();
    await this._columnInitPromise;
  }

  private async _initColumnMap(): Promise<void> {
    const camelToSnake: ColumnMap = {};
    const snakeToCamelMap: Record<string, string> = {};

    try {
      const { rows } = await this.pool.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
      }>(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = $2
         ORDER BY ordinal_position`,
        [this.table, this.schema]
      );

      for (const row of rows) {
        const camel = snakeToCamel(row.column_name);
        if (camel !== row.column_name) {
          camelToSnake[camel] = row.column_name;
          snakeToCamelMap[row.column_name] = camel;
        }
        if (row.data_type === 'jsonb' || row.udt_name === 'jsonb') {
          this._jsonbColumns.add(row.column_name);
        }
      }
    } catch {
      // If DB isn't available (e.g. during build), fall back to overrides only
    }

    for (const [camel, snake] of Object.entries(this.columnMapOverrides)) {
      camelToSnake[camel] = snake;
      snakeToCamelMap[snake] = camel;
    }

    this._columnMap = camelToSnake;
    this._reverseMap = snakeToCamelMap;
  }

  /** Get the resolved column map (camel → snake). Lazy-safe for sync access after init. */
  get columnMap(): ColumnMap {
    return this._columnMap ?? this.columnMapOverrides;
  }

  /** Get the resolved reverse map (snake → camel). */
  get reverseMap(): Record<string, string> {
    if (this._reverseMap) return this._reverseMap;
    const rev: Record<string, string> = {};
    for (const [camel, snake] of Object.entries(this.columnMapOverrides)) {
      rev[snake] = camel;
    }
    return rev;
  }

  protected get pool(): DbQueryable {
    // Engine-agnostic facade routed through the active adapter. Models must
    // not touch pg.Pool directly; managed and url modes share this surface.
    return getDb();
  }

  /** Convert a camelCase key to its snake_case column name. */
  protected toColumn(key: string): string {
    return (this._columnMap ?? this.columnMapOverrides)[key] ?? key;
  }

  /**
   * Convert a snake_case column to its camelCase key.
   * Falls back to snakeToCamel() when the column isn't in the override map,
   * so this works even before ensureColumnMap() resolves (e.g. tests without DB).
   */
  protected toKey(column: string): string {
    return this.reverseMap[column] ?? snakeToCamel(column);
  }

  /**
   * Transform a raw DB row (snake_case keys) into the consumer-facing shape
   * (camelCase keys). Returns null if the row is null/undefined so callers
   * can chain through `findById`-style nullable returns.
   */
  protected transformRow<T>(row: Record<string, unknown> | null | undefined): T | null {
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[this.toKey(key)] = value;
    }
    return out as T;
  }

  /** Transform an array of raw DB rows into the consumer-facing shape. */
  protected transformRows<T>(rows: Record<string, unknown>[]): T[] {
    return rows.map((r) => this.transformRow<T>(r) as T);
  }

  protected mapConstraintType(raw: string): ConstraintType {
    switch (raw) {
      case 'p':
        return 'primary_key';
      case 'u':
        return 'unique';
      case 'f':
        return 'foreign_key';
      case 'c':
        return 'check';
      case 'x':
        return 'exclude';
      default:
        return 'unknown';
    }
  }

  protected mapObjectKind(raw: string | null | undefined): DbObjectKind {
    if (raw === 'r') return 'table';
    if (raw === 'v') return 'view';
    if (raw === 'm') return 'materialized_view';
    return 'unknown';
  }

  /**
   * Convert a JS input object to a { columns, values, placeholders } triple
   * suitable for INSERT/UPDATE. Skips undefined values.
   */
  protected mapInput(input: object): {
    columns: string[];
    values: unknown[];
    placeholders: string[];
  } {
    const columns: string[] = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const col = this.toColumn(key);
      columns.push(col);
      // Pass arrays as-is (pg driver handles JS arrays as Postgres arrays)
      if (Array.isArray(value) && this._jsonbColumns.has(col)) {
        values.push(JSON.stringify(value));
        placeholders.push(`$${idx}::jsonb`);
      } else if (Array.isArray(value)) {
        values.push(value);
        placeholders.push(`$${idx}`);
      } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        // Serialize plain objects as JSONB
        values.push(JSON.stringify(value));
        placeholders.push(`$${idx}::jsonb`);
      } else {
        values.push(value);
        placeholders.push(`$${idx}`);
      }
      idx++;
    }

    return { columns, values, placeholders };
  }

  private buildSelect(opts?: { columns?: string[] }): string {
    if (this.selectExpr) return this.selectExpr;
    const cols = opts?.columns
      ? opts.columns.map((c) => `t.${quoteIdentifier(c)}`).join(', ')
      : this.defaultCols === '*'
        ? 't.*'
        : this.defaultCols
            .split(', ')
            .map((c) => `t.${c}`)
            .join(', ');
    return `SELECT ${cols} FROM ${this.qualifiedTable} t`;
  }

  /** Find a single row by primary key. */
  async findById(id: string | number): Promise<Row | null> {
    await this.ensureColumnMap();
    const sql = `${this.buildSelect()} WHERE t.${quoteIdentifier(this.primaryKey)} = $1 LIMIT 1`;
    const { rows } = await this.pool.query<QueryResultRow>(sql, [id]);
    return this.transformRow<Row>(rows[0]);
  }

  /** Find a single row matching the given filters. */
  async findOne(where: Record<string, FilterValue>): Promise<Row | null> {
    await this.ensureColumnMap();
    const filter = buildFilterClause(where);
    // Replace unqualified column refs with table-qualified ones
    const sql = `${this.buildSelect()}${filter.sql} LIMIT 1`;
    const { rows } = await this.pool.query<QueryResultRow>(sql, filter.params);
    return this.transformRow<Row>(rows[0]);
  }

  /** List rows with optional filtering, sorting, and pagination. */
  async list(opts?: ListOptions): Promise<Row[]> {
    await this.ensureColumnMap();
    const filter = buildFilterClause(opts?.where);
    const orderCol = opts?.orderBy
      ? quoteIdentifier(opts.orderBy)
      : quoteIdentifier(this.defaultOrderColumn());
    const orderDir = opts?.order ?? 'DESC';
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;

    const sql = `${this.buildSelect(opts)}${filter.sql} ORDER BY ${orderCol} ${orderDir} LIMIT $${filter.nextIndex} OFFSET $${filter.nextIndex + 1}`;
    const { rows } = await this.pool.query<QueryResultRow>(sql, [...filter.params, limit, offset]);
    return this.transformRows<Row>(rows);
  }

  /** Count rows matching optional filters. */
  async count(opts?: CountOptions): Promise<number> {
    await this.ensureColumnMap();
    const filter = buildFilterClause(opts?.where);
    const schemaName = opts?.schemaName ?? this.schema;
    const tableRef = `${quoteIdentifier(schemaName)}.${quoteIdentifier(this.table)}`;
    const sql = `SELECT COUNT(*) AS count FROM ${tableRef} t${filter.sql}`;
    const { rows } = await this.pool.query<{ count: string }>(sql, filter.params);
    return parseInt(rows[0].count, 10);
  }

  /** Insert a new row and return it. */
  async create(input: CreateInput): Promise<Row> {
    await this.ensureColumnMap();
    const { columns, values, placeholders } = this.mapInput(input);
    if (columns.length === 0) throw new Error('create() requires at least one field');

    const sql = `INSERT INTO ${this.qualifiedTable} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    const { rows } = await this.pool.query<QueryResultRow>(sql, values);
    return this.transformRow<Row>(rows[0]) as Row;
  }

  /** Update a row by primary key. Returns the updated row or null if not found. */
  async update(id: string | number, input: UpdateInput): Promise<Row | null> {
    await this.ensureColumnMap();
    const { columns, values } = this.mapInput(input);
    if (columns.length === 0) return this.findById(id);

    const setClauses = columns.map((col, i) => `${col} = $${i + 1}`);
    if (this.updatedAtCol) {
      setClauses.push(`${this.updatedAtCol} = NOW()`);
    }

    values.push(id);
    const sql = `UPDATE ${this.qualifiedTable} SET ${setClauses.join(', ')} WHERE ${quoteIdentifier(this.primaryKey)} = $${values.length} RETURNING *`;
    const { rows } = await this.pool.query<QueryResultRow>(sql, values);
    return this.transformRow<Row>(rows[0]);
  }

  /** Delete a row by primary key. Returns true if a row was deleted. */
  async delete(id: string | number): Promise<boolean> {
    const sql = `DELETE FROM ${this.qualifiedTable} WHERE ${quoteIdentifier(this.primaryKey)} = $1`;
    const { rowCount } = await this.pool.query(sql, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Upsert: insert or update on conflict. Returns the row. */
  async upsert(
    input: CreateInput,
    conflictColumns: string[],
    updateColumns?: string[]
  ): Promise<Row> {
    await this.ensureColumnMap();
    const { columns, values, placeholders } = this.mapInput(input);
    if (columns.length === 0) throw new Error('upsert() requires at least one field');

    const conflict = conflictColumns.join(', ');
    const toUpdate = updateColumns ?? columns.filter((c) => !conflictColumns.includes(c));

    let onConflict: string;
    if (toUpdate.length === 0) {
      onConflict = 'ON CONFLICT DO NOTHING';
    } else {
      const updateSet = toUpdate.map((col) => `${col} = EXCLUDED.${col}`);
      if (this.updatedAtCol) {
        updateSet.push(`${this.updatedAtCol} = NOW()`);
      }
      onConflict = `ON CONFLICT (${conflict}) DO UPDATE SET ${updateSet.join(', ')}`;
    }

    const sql = `INSERT INTO ${this.qualifiedTable} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) ${onConflict} RETURNING *`;
    const { rows } = await this.pool.query<QueryResultRow>(sql, values);
    return this.transformRow<Row>(rows[0]) as Row;
  }

  /**
   * Resolve the default ORDER BY column for read helpers.
   * Prefers createdAtCol, then updatedAtCol, then falls back to the primary key.
   * Tables that opt out of both timestamp columns (e.g. files, whose timestamps live on nodes)
   * get a safe, always-present column to order by.
   */
  protected defaultOrderColumn(): string {
    return this.createdAtCol ?? this.updatedAtCol ?? this.primaryKey;
  }

  /** Get the N most recently created rows. */
  async latest(n: number = 1, opts?: { where?: Record<string, FilterValue> }): Promise<Row[]> {
    return this.list({
      where: opts?.where,
      orderBy: this.createdAtCol ?? this.defaultOrderColumn(),
      order: 'DESC',
      limit: n,
    });
  }

  /** Get the N oldest rows. */
  async oldest(n: number = 1, opts?: { where?: Record<string, FilterValue> }): Promise<Row[]> {
    return this.list({
      where: opts?.where,
      orderBy: this.createdAtCol ?? this.defaultOrderColumn(),
      order: 'ASC',
      limit: n,
    });
  }

  /** Get the N most recently updated rows. */
  async recentlyUpdated(
    n: number = 1,
    opts?: { where?: Record<string, FilterValue> }
  ): Promise<Row[]> {
    return this.list({
      where: opts?.where,
      orderBy: this.updatedAtCol ?? this.defaultOrderColumn(),
      order: 'DESC',
      limit: n,
    });
  }

  /** Check if a row with the given primary key exists. */
  async exists(id: string | number): Promise<boolean> {
    const sql = `SELECT 1 FROM ${this.qualifiedTable} t WHERE t.${quoteIdentifier(this.primaryKey)} = $1 LIMIT 1`;
    const { rows } = await this.pool.query(sql, [id]);
    return rows.length > 0;
  }

  /** Get all distinct values for a column, optionally filtered. */
  async distinct(
    column: string,
    opts?: { where?: Record<string, FilterValue> }
  ): Promise<unknown[]> {
    const filter = buildFilterClause(opts?.where);
    const sql = `SELECT DISTINCT ${quoteIdentifier(column)} FROM ${this.qualifiedTable} t${filter.sql} ORDER BY ${quoteIdentifier(column)} ASC`;
    const { rows } = await this.pool.query(sql, filter.params);
    return rows.map((r) => r[column]);
  }

  /** Resolve if this relation is a table, view, materialized view, or unknown. */
  async objectKind(opts?: IntrospectionOptions): Promise<DbObjectKind> {
    const schemaName = opts?.schemaName ?? this.schema;
    const row = await this.queryOne<{ relkind: string }>(
      `SELECT c.relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
       LIMIT 1`,
      [schemaName, this.table]
    );
    return this.mapObjectKind(row?.relkind);
  }

  /** Get column names and types for this table from information_schema. */
  async columns(opts?: IntrospectionOptions): Promise<ColumnInfo[]> {
    const schemaName = opts?.schemaName ?? this.schema;
    const { rows } = await this.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = $2
       ORDER BY ordinal_position`,
      [this.table, schemaName]
    );
    return rows.map((r) => ({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
      hasDefault: r.column_default !== null,
      defaultValue: r.column_default,
    }));
  }

  /** Get relation constraints with normalized type labels. */
  async constraints(opts?: IntrospectionOptions): Promise<ConstraintInfo[]> {
    const schemaName = opts?.schemaName ?? this.schema;
    const rows = await this.query<{
      name: string;
      contype: string;
      definition: string;
    }>(
      `SELECT
         c.conname AS name,
         c.contype::text AS contype,
         pg_get_constraintdef(c.oid, true) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2
       ORDER BY
         CASE c.contype
           WHEN 'p' THEN 1
           WHEN 'u' THEN 2
           WHEN 'f' THEN 3
           WHEN 'c' THEN 4
           ELSE 5
         END,
         c.conname`,
      [schemaName, this.table]
    );

    return rows.map((r) => ({
      name: r.name,
      type: this.mapConstraintType(r.contype),
      definition: r.definition,
    }));
  }

  /** Get relation indexes from pg_indexes. */
  async indexes(opts?: IntrospectionOptions): Promise<IndexInfo[]> {
    const schemaName = opts?.schemaName ?? this.schema;
    return this.query<IndexInfo>(
      `SELECT
         indexname AS name,
         indexdef AS definition
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2
       ORDER BY indexname`,
      [schemaName, this.table]
    );
  }

  /** Get optional relation comment/description. */
  async relationDescription(opts?: IntrospectionOptions): Promise<string | null> {
    const schemaName = opts?.schemaName ?? this.schema;
    const row = await this.queryOne<{ description: string | null }>(
      `SELECT obj_description(c.oid, 'pg_class') AS description
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
       LIMIT 1`,
      [schemaName, this.table]
    );
    return row?.description ?? null;
  }

  /** Get human-readable total relation size, including indexes/toast. */
  async relationSize(opts?: IntrospectionOptions): Promise<string | null> {
    const schemaName = opts?.schemaName ?? this.schema;
    const row = await this.queryOne<{ total_size: string | null }>(
      `SELECT pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2
       LIMIT 1`,
      [schemaName, this.table]
    );
    return row?.total_size ?? null;
  }

  /** Get just the column names as a string array. */
  async columnNames(opts?: IntrospectionOptions): Promise<string[]> {
    const cols = await this.columns(opts);
    return cols.map((c) => c.name);
  }

  /** Get a map of column name → SQL data type. */
  async columnTypes(opts?: IntrospectionOptions): Promise<Record<string, string>> {
    const cols = await this.columns(opts);
    return Object.fromEntries(cols.map((c) => [c.name, c.type]));
  }

  /** Get raw sample rows directly from this table. */
  async sample(limit = 5, opts?: IntrospectionOptions): Promise<Row[]> {
    const normalizedLimit = clamp(Math.floor(limit), 1, 200);
    const schemaName = opts?.schemaName ?? this.schema;
    const tableRef = `${quoteIdentifier(schemaName)}.${quoteIdentifier(this.table)}`;
    const { rows } = await this.pool.query<QueryResultRow>(`SELECT * FROM ${tableRef} LIMIT $1`, [
      normalizedLimit,
    ]);
    await this.ensureColumnMap();
    return this.transformRows<Row>(rows);
  }

  /**
   * Run a parameterized query against the pool. Returned rows are
   * transformed to camelCase (snake_case column names → camelCase keys),
   * matching the rest of the Model API. Use `rawQuery` if you need the
   * original DB shape (e.g. introspection queries with synthetic columns).
   */
  async query<T extends object = Row>(sql: string, params?: unknown[]): Promise<T[]> {
    await this.ensureColumnMap();
    const { rows } = await this.pool.query<QueryResultRow>(sql, params);
    return this.transformRows<T>(rows);
  }

  /**
   * Run a parameterized query and return the first row, or null.
   * Returned row is transformed to camelCase like `query()`.
   */
  async queryOne<T extends object = Row>(sql: string, params?: unknown[]): Promise<T | null> {
    await this.ensureColumnMap();
    const { rows } = await this.pool.query<QueryResultRow>(sql, params);
    return this.transformRow<T>(rows[0]);
  }

  /**
   * Run a parameterized query and return rows untransformed.
   * Use when the query returns synthetic column shapes (counts, JSON
   * aggregates) that the consumer wants in raw form.
   */
  async rawQuery<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]> {
    const { rows } = await this.pool.query<T>(sql, params);
    return rows;
  }

  /** Like rawQuery, but returns the first row or null. */
  async rawQueryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null> {
    const { rows } = await this.pool.query<T>(sql, params);
    return rows[0] ?? null;
  }
}
