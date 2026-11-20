/**
 * Agent-facing operations on custom Database tables, behind the `table` tool
 * (ops read, write, schema and delete).
 *
 * Agents address a table by its real snake_case name (case-insensitive) or its
 * catalog id, and fields by name. A relation targets a custom table (`ref:
 * "companies"`) or one kind of Snaglet item (`ref: "snaglet:doc"`; a colon never appears
 * in a table name); item values are ids, and a write also takes a chip or an
 * item's exact title. Field ids and revisions never appear in the
 * inputs: writes run under the schema lock instead of echoing a schema
 * version, and an update may carry a short revision prefix. Built-in tables
 * are a 403, unknown ones a 404, archived ones a 409 (restore_table brings one
 * back). Each write call is one transaction, one step in the agent's own undo
 * history (a person can undo it), and emits its realtime events once, after
 * commit. A project link (`set_project`) is placement, not content, so on
 * its own it records no step.
 */
import { randomUUID } from 'node:crypto';
import { getDb, transaction, type DbQueryable } from '@snaglet/db';
import { Nodes } from '@snaglet/db/tables/nodes';
import {
  TableCatalog,
  toTableCatalogEntry,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import {
  TableEntries,
  type EntryBatchInsert,
  type EntryBatchUpdate,
  type EntryReferences,
} from '@snaglet/db/tables/table_entries';
import { TableReferences } from '@snaglet/db/tables/table_references';
import { Calendars } from '@snaglet/db/tables/calendars';
import {
  TableFields,
  defaultRecurrence,
  mapFieldDatabaseError,
  type LockedTables,
} from '@snaglet/db/tables/table_fields';
import {
  TableLifecycle,
  linkedFields,
  newJournal,
  recordStep,
  stepLabels,
  type HistoryJournal,
} from '@snaglet/db/tables/table_history';
import {
  TABLE_QUERY_CUT_MARKER_PATTERN,
  TableQuery,
  TableQueryError,
  type TableQueryCellType,
} from '@snaglet/db/tables/table_query';
import {
  ErrorCode,
  HTTP_STATUS,
  TABLE_CATALOG_ID_PATTERN,
  TABLE_ENTRY_ID_PATTERN,
  TABLE_REFERENCE_ID_PATTERN,
  TABLE_REFERENCE_KINDS,
  TABLE_ENTRY_SORT_MAX,
  TABLE_ENTRY_WHERE_MAX,
  type CreateTableFieldRequest,
  type DeleteTableEntriesResponse,
  type EditableTableFieldType,
  type TableEntryValue,
  type TableEntryValues,
  type TableField,
  type TableFieldDefault,
  type TableFieldRecurrence,
  type TableReferenceKind,
  type TableSelectOptionColor,
  type TableSelectOptionInput,
  type UpdateTableFieldRequest,
} from '@snaglet/shared/types';
import {
  AppError,
  generateId,
  getErrorMessage,
  isRecord,
  isTableReferenceKind,
  safeJsonParse,
  tableDateTimeLocalDate,
  tableFieldDefinitionProblem,
  tableRepeatCellText,
  tableRepeatSummary,
  userTimeZone,
  type TableRepeat,
} from '@snaglet/shared/utils';
import {
  emitTableCreated,
  emitTableEntriesChanged,
  emitTableFieldsChanged,
  emitTableRemoved,
  emitTableRestored,
  emitTableUpdated,
} from '@server/realtime/surfaces/tables';
import { emitCalendarChanged } from '@server/realtime/surfaces/calendar';
import { assertNoArchiveSweep } from '@server/services/ArchiveSweepGuard';
import { extractMarkdownRefs } from '@server/services/WorkspaceService/markdownRefs';
import { createTableInTx, renameTableInTx } from './tableCatalog';
import {
  deleteTableEntries,
  emitTableEntryCreated,
  emitTableEntryUpdated,
  previousEntryValues,
  tableEntryChanges,
  tableEntryRepeatAction,
  type RepeatAction,
} from './tableEntries';
import { afterTableWrite, historyContext } from './tableHistory';
import { emitOccurrenceEvents, occurrenceEvents } from './tableOccurrenceEvents';
import { refuseAutomationsTable, tableBadRequest } from './tableValidation';

/**
 * A field as agents see it. A relation also carries `refName`, its target
 * table's current name (absent when the target is gone) or `snaglet:<kind>` for a
 * relation to Snaglet items, so a renderer can print `→reading_list` or `→snaglet:doc`
 * without a second lookup. A field on a calendar carries `calendarName`, that
 * calendar's title in a describe.
 */
export type AgentTableField = TableField & { refName?: string; calendarName?: string };

/** A project container a table (or the calling thread) belongs to. */
export interface AgentTableProject {
  id: string;
  name: string;
}

export interface AgentTableSummary {
  id: string;
  name: string;
  /** Present when the table is archived or deleted (after such an op). */
  state?: 'archived' | 'deleted';
  /** The table's project home; absent for a workspace-wide table. */
  project?: AgentTableProject;
  /** Names of its archived fields (restore_field brings one back). */
  archivedFields?: string[];
  /** Row count, read up to {@link AGENT_ROW_COUNT_CAP}; `rowsCapped` past it. */
  rows: number;
  rowsCapped: boolean;
  /** Display order, managed `id` and `created_at` included. */
  fields: AgentTableField[];
}

/**
 * A select option as agents give it: a label (optionally with a color), or
 * in an update `{ from, to }` renaming the option currently labeled `from`.
 */
export type AgentOptionInput =
  | string
  | { label: string; color?: TableSelectOptionColor }
  | { from: string; to: string; color?: TableSelectOptionColor };

export interface AgentFieldInput {
  name: string;
  type: EditableTableFieldType;
  description?: string | null;
  /** Create defaults to true (optional); a single relation is always optional. */
  nullable?: boolean;
  default?: TableFieldDefault;
  /**
   * Relation target: a custom table's name (or catalog id; this table's own
   * name links to itself), or `snaglet:<kind>` for Snaglet items (`snaglet:doc`, `snaglet:agent`, …).
   */
  ref?: string;
  multiple?: boolean;
  /**
   * Date and datetime fields: each value is `start/end` or one value (a date
   * range includes its end day). A range has no default. Left out of an
   * update, it stays while the field stays a date or datetime.
   */
  range?: boolean;
  /**
   * Select options in display order. In an update it is the full new list:
   * listed labels are kept or added, `{from, to}` renames, and options left
   * out are removed (and cleared from entries).
   */
  options?: AgentOptionInput[];
  /** Field name this field is placed before (managed fields included); omitted appends. */
  before?: string;
  /**
   * Date and datetime fields: rows can repeat (the editor's "Rows can
   * repeat"; each row's pattern is set with a write's `repeat` steps). Off
   * removes every row's repeat: an update must then say `clear_repeats`
   * when any row repeats. Left out of an update, the setting stays.
   */
  repeats?: boolean;
  /**
   * Date and datetime fields: the calendar its rows show on, by id or title
   * (any case; `'default'` is the Default calendar when no title matches),
   * or null for none. Placement, like set_project: no undo step.
   */
  calendar?: string | null;
}

export type AgentSchemaOp =
  | { op: 'add_field'; field: AgentFieldInput }
  /**
   * Merged onto the current definition; `set.name` renames, `set.before`
   * moves. `clear_repeats` confirms `set.repeats: false` on a field whose
   * rows repeat (their repeats are removed; undo puts them back).
   */
  | {
      op: 'update_field';
      name: string;
      set: Partial<AgentFieldInput>;
      clear_repeats?: boolean;
    }
  /** Every non-managed field name once, in the new order; managed fields keep their slots. */
  | { op: 'reorder_fields'; names: string[] }
  | { op: 'rename_table'; name: string }
  /** Hide a field, keeping its data; restore_field brings it back. */
  | { op: 'archive_field'; name: string }
  /** Delete a field; undoable from the agent's history while the step is in it. */
  | { op: 'delete_field'; name: string }
  /** Restore an archived field; `as` renames it when its name is taken. */
  | { op: 'restore_field'; name: string; as?: string }
  /** Make a text field the table's title field. */
  | { op: 'set_title_field'; name: string }
  | { op: 'archive_table' }
  /** `clear_links` also deletes other tables' relation fields that link to it. */
  | { op: 'delete_table'; clear_links?: boolean }
  /** Restore an archived table; `as` renames it when its name is taken. */
  | { op: 'restore_table'; as?: string }
  /** Link the table to a project container, or null for workspace-wide. Not an undo step. */
  | { op: 'set_project'; project_id: string | null };

export interface AgentSchemaInput {
  /** Creates the table (409 if the name exists) with these fields after its Name field. */
  fields?: AgentFieldInput[];
  /** Applied in order after any create. */
  ops?: AgentSchemaOp[];
}

/** Where a schema call comes from. */
export interface AgentSchemaCaller {
  /** The calling thread: a table the call creates starts in its project. */
  threadId?: string;
}

/**
 * One repeat change on a row's repeating date field (docs/architecture.md),
 * applied after the write's rows, each its own undo step. Exactly one of:
 * `set` a repeat (`null` stops it), `done` the current one, `skip` the
 * current one; `skip: "now"` jumps a repeat at an
 * interval that is behind to its next time from now, logging none of the
 * missed ones.
 */
interface AgentRepeatItem {
  id: string;
  field: string;
  set?: { rrule: string; date?: string } | null;
  done?: true;
  skip?: true | 'now';
}

export interface AgentWriteInput {
  /** Values keyed by field name. `id` is minted when omitted; `before` is an entry id. */
  insert?: { id?: string; values: Record<string, TableEntryValue>; before?: string }[];
  /** A sparse patch; `rev` is at least 8 hex characters of the entry revision. */
  update?: { id: string; values: Record<string, TableEntryValue>; rev?: string }[];
  /** Repeat changes, after the rows (not atomic with them): one step each, in order. */
  repeat?: AgentRepeatItem[];
}

export interface AgentWriteResult {
  /** Catalog id of the table written, for the entry chip form `entry:<tableId>/<entryId>`. */
  tableId: string;
  inserted: { id: string; rev: string }[];
  /** Inserts replaying an existing id with the same values: nothing written. */
  existing: { id: string; rev: string }[];
  updated: { id: string; rev: string }[];
  unchanged: string[];
  /** Repeat changes made: the row, the field and where its repeat stands now. */
  repeats?: { id: string; field: string; rev: string; repeat: string }[];
}

export interface AgentQueryResult {
  columns: string[];
  rows: (string | null)[][];
  /** Each cell's JSON type, parallel to `rows` (see TableQueryRows.types). */
  types?: TableQueryCellType[][];
  capped: boolean;
  /**
   * Titles of the Snaglet items the result's item-relation columns name (matched
   * by column name), so ids read as names; at most {@link AGENT_QUERY_MAX_TITLES}.
   */
  itemTitles?: Array<{ id: string; title: string; archived: boolean }>;
}

/** One entry read by id: its editable values keyed by field name, and its short `rev`. */
interface AgentEntry {
  id: string;
  rev: string;
  values: Record<string, TableEntryValue>;
  /** Repeating date fields by name: the repeat's sentence and where it stands. */
  repeats?: Record<string, string>;
}

export interface AgentEntriesResult {
  table: string;
  /** Catalog id, for the entry chip form `entry:<tableId>/<entryId>`. */
  tableId: string;
  entries: AgentEntry[];
  /** Requested ids with no entry in the table, in request order. */
  missing: string[];
}

/** Name-addressed options for a paged, structured agent entry read. */
export interface AgentListEntriesOptions {
  where?: readonly Record<string, unknown>[];
  sort?: readonly Record<string, unknown>[];
  page?: number;
  limit?: number;
  columns?: readonly string[];
}

export interface AgentListEntriesResult {
  table: string;
  /** Catalog id, for the entry chip form `entry:<tableId>/<entryId>`. */
  tableId: string;
  entries: AgentEntry[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  schemaVersion: string;
}

/** Row counts stop here; past it a table reports this many and `rowsCapped`. */
const AGENT_ROW_COUNT_CAP = 10_000;
/** Most rows one `insert` or `update` list may hold. */
const AGENT_WRITE_MAX_ROWS = 200;
/** Returned revisions are this many leading hex characters. */
const AGENT_REVISION_LENGTH = 8;
/** Most entries one `{table, ids}` read returns. */
const AGENT_READ_MAX_IDS = 50;
/** Most Snaglet item titles a query result names. */
const AGENT_QUERY_MAX_TITLES = 50;
/** `ref` prefix naming a Snaglet item kind instead of a table. */
const AGENT_ITEM_REF_PREFIX = 'snaglet:';

const REVISION_PREFIX_PATTERN = /^[0-9a-f]{8,64}$/i;
const CUT_VALUE_MESSAGE =
  'value looks cut by a table read; re-read with a larger max_cell or patch only the fields you changed';
const SLOW_QUERY_MESSAGE = 'query took longer than 5s; narrow it';

function conflict(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(message, ErrorCode.CONFLICT, HTTP_STATUS.CONFLICT, true, details);
}

function shortRev(revision: string): string {
  return revision.slice(0, AGENT_REVISION_LENGTH);
}

// --- addressing --------------------------------------------------------------

function tableKey(table: unknown): string {
  if (typeof table !== 'string' || !table.trim())
    throw tableBadRequest('table must be a table name or id.');
  return table.trim();
}

function isCatalogId(key: string): boolean {
  return TABLE_CATALOG_ID_PATTERN.test(key);
}

async function findTable(
  key: string,
  runner: DbQueryable = getDb()
): Promise<TableCatalogRow | null> {
  return isCatalogId(key)
    ? TableCatalog.findById(key, runner)
    : TableCatalog.findByName(key, runner);
}

function customOnly(
  row: TableCatalogRow | null,
  key: string,
  allowArchived = false
): TableCatalogRow {
  if (!row || row.state === 'deleted')
    throw new AppError(`Table not found: ${key}`, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  if (row.origin !== 'custom')
    throw new AppError(
      `${row.name} is a Snaglet table; agent table tools work on custom tables only.`,
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  if (row.state === 'archived' && !allowArchived)
    throw conflict(
      `${row.name} is archived. Restore it first: table {op: "schema", table: "${row.id}", ops: [{op: "restore_table"}]}.`
    );
  return row;
}

/** An archived custom table by id, or the most recently archived one with this name. */
async function findArchivedTable(key: string): Promise<TableCatalogRow | null> {
  if (isCatalogId(key)) return TableCatalog.findById(key);
  const archived = await TableCatalog.listTables({ origin: 'custom', state: 'archived' });
  return archived.find((row) => row.name.toLowerCase() === key.toLowerCase()) ?? null;
}

async function resolveCustomTable(table: unknown): Promise<TableCatalogRow> {
  const key = tableKey(table);
  return customOnly(await findTable(key), key);
}

/** The table was addressed by a name it no longer has: a 409 naming the current one. */
function assertStillNamed(row: TableCatalogRow, key: string): void {
  if (!isCatalogId(key) && row.name.toLowerCase() !== key.toLowerCase())
    throw conflict(`This table was renamed to "${row.name}".`, {
      table: toTableCatalogEntry(row),
    });
}

// --- read --------------------------------------------------------------------

function withRefName(field: TableField, names: ReadonlyMap<string, string>): AgentTableField {
  const refName = field.referenceKind
    ? `${AGENT_ITEM_REF_PREFIX}${field.referenceKind}`
    : field.referenceTableId
      ? names.get(field.referenceTableId)
      : undefined;
  return refName === undefined ? field : { ...field, refName };
}

/**
 * Names of the project containers in `ids`, in one query. A project that is
 * gone is simply absent (its tables' `project_id` is already null by then).
 */
async function projectNames(
  ids: Iterable<string | null>,
  runner: DbQueryable
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))];
  if (!wanted.length) return new Map();
  const { rows } = await runner.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM public.containers AS c WHERE c.id = ANY($1::text[])`,
    [wanted]
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

function projectOf(
  row: TableCatalogRow,
  projects: ReadonlyMap<string, string>
): AgentTableProject | undefined {
  if (row.projectId === null) return undefined;
  return { id: row.projectId, name: projects.get(row.projectId) ?? row.projectId };
}

async function summarize(
  row: TableCatalogRow,
  fields: readonly TableField[],
  names: ReadonlyMap<string, string>,
  projects: ReadonlyMap<string, string>,
  runner: DbQueryable,
  archivedFields: string[] = []
): Promise<AgentTableSummary> {
  const count = await TableCatalog.boundedRowCount(row, AGENT_ROW_COUNT_CAP, runner);
  const project = projectOf(row, projects);
  return {
    id: row.id,
    name: row.name,
    ...(row.state !== 'active' ? { state: row.state } : {}),
    ...(project ? { project } : {}),
    archivedFields,
    rows: count.rows,
    rowsCapped: count.capped,
    fields: fields.map((field) => withRefName(field, names)),
  };
}

async function describeRow(
  row: TableCatalogRow,
  runner: DbQueryable = getDb()
): Promise<AgentTableSummary> {
  const fields = await TableFields.listFields(row.id, runner);
  const names = new Map<string, string>([[row.id, row.name]]);
  for (const id of new Set(fields.map((field) => field.referenceTableId))) {
    if (id === null || names.has(id)) continue;
    const target = await TableCatalog.findById(id, runner);
    // An archived target shows as unavailable rather than by a name it gave up.
    if (target)
      names.set(id, target.state === 'active' ? target.name : `${target.name} (archived)`);
  }
  const archived =
    row.state === 'deleted'
      ? []
      : (await TableLifecycle.listArchivedFields(row.id, runner)).map((field) => field.name);
  const projects = await projectNames([row.projectId], runner);
  const summary = await summarize(row, fields, names, projects, runner, archived);
  const calendars = await calendarTitles(fields, runner);
  if (!calendars.size) return summary;
  return {
    ...summary,
    fields: summary.fields.map((field) => {
      const calendarName = field.calendarId ? calendars.get(field.calendarId) : undefined;
      return calendarName === undefined ? field : { ...field, calendarName };
    }),
  };
}

/** Titles of the calendars `fields` show on. */
async function calendarTitles(
  fields: readonly TableField[],
  runner: DbQueryable
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (const id of new Set(fields.map((field) => field.calendarId))) {
    if (!id) continue;
    const calendar = await Calendars.findById(id, runner);
    if (calendar) titles.set(id, calendar.title);
  }
  return titles;
}

/**
 * Every active custom table with a bounded row count and its fields, in
 * catalog order (by name). Given the calling thread's project, that
 * project's tables come first, then workspace-wide ones, then other
 * projects', each group still by name.
 */
export async function listAgentTables(projectId?: string | null): Promise<AgentTableSummary[]> {
  const rows = await TableCatalog.listTables({ origin: 'custom' });
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const [fields, projects] = await Promise.all([
    TableFields.listFieldsByTable(rows.map((row) => row.id)),
    projectNames(
      rows.map((row) => row.projectId),
      getDb()
    ),
  ]);
  const group = (row: TableCatalogRow): number =>
    projectId && row.projectId === projectId ? 0 : row.projectId === null ? 1 : 2;
  const ordered = projectId
    ? rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => group(a.row) - group(b.row) || a.index - b.index)
        .map(({ row }) => row)
    : rows;
  return Promise.all(
    ordered.map((row) => summarize(row, fields.get(row.id) ?? [], names, projects, getDb()))
  );
}

/** The project a thread belongs to, by id and name, or null for a flat thread. */
export async function threadProject(
  threadId: string | undefined
): Promise<AgentTableProject | null> {
  if (!threadId) return null;
  const projectId = await Nodes.getProjectId(threadId);
  if (projectId === null) return null;
  const names = await projectNames([projectId], getDb());
  return { id: projectId, name: names.get(projectId) ?? projectId };
}

/** Names of archived custom tables, newest first (for one quiet line in table_read). */
export async function listArchivedAgentTables(): Promise<string[]> {
  return (await TableLifecycle.listArchivedTables()).map((row) => row.name);
}

export async function describeAgentTable(table: string): Promise<AgentTableSummary> {
  return describeRow(await resolveCustomTable(table));
}

/**
 * Name-addressed, paged entries with their short `rev`, the same prefix write
 * results carry. Filtering and sorting remain owned by the entry model.
 */
export async function listAgentEntries(
  table: unknown,
  options: AgentListEntriesOptions = {}
): Promise<AgentListEntriesResult> {
  // Cast so the guard doesn't narrow `options` to Record<string, unknown>.
  if (!isRecord(options as unknown)) throw tableBadRequest('options must be an object.');
  const allowedOptions = new Set(['where', 'sort', 'page', 'limit', 'columns']);
  for (const key of Object.keys(options))
    if (!allowedOptions.has(key)) throw tableBadRequest(`options.${key} is not supported.`);

  const page = options.page ?? 1;
  const pageSize = options.limit ?? 25;
  if (!Number.isSafeInteger(page) || page < 1)
    throw tableBadRequest('page must be a positive integer.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw tableBadRequest('limit must be an integer between 1 and 100.');
  for (const [label, value] of [
    ['where', options.where],
    ['sort', options.sort],
    ['columns', options.columns] as const,
  ])
    if (value !== undefined && !Array.isArray(value))
      throw tableBadRequest(`${label} must be an array.`);
  if (options.where && options.where.length > TABLE_ENTRY_WHERE_MAX)
    throw tableBadRequest(`where: at most ${TABLE_ENTRY_WHERE_MAX} conditions.`);
  if (options.sort && options.sort.length > TABLE_ENTRY_SORT_MAX)
    throw tableBadRequest(`sort: at most ${TABLE_ENTRY_SORT_MAX} fields.`);

  const row = await resolveCustomTable(table);
  const fields = (await TableFields.listFields(row.id)).filter((field) => !field.managed);
  const validNames = fields.map((field) => field.name).join(', ');
  const byName = new Map(fields.map((field) => [field.name.toLowerCase(), field]));
  const nameField = (value: unknown, label: string): TableField => {
    if (typeof value !== 'string' || !value.trim())
      throw tableBadRequest(`${label} must be a field name.`);
    const field = byName.get(value.trim().toLowerCase());
    if (!field)
      throw tableBadRequest(
        `${label} names an unknown field: ${value}. Valid names: ${validNames || '(none)'}.`
      );
    return field;
  };
  const assertKeys = (item: Record<string, unknown>, allowed: readonly string[], label: string) => {
    for (const key of Object.keys(item))
      if (!allowed.includes(key)) throw tableBadRequest(`${label}.${key} is not supported.`);
  };
  const mapConditions = (items: readonly Record<string, unknown>[] | undefined, label: string) =>
    items?.map((item, index) => {
      if (!isRecord(item)) throw tableBadRequest(`${label}[${index}] must be an object.`);
      assertKeys(item, ['field', 'operator', 'value'], `${label}[${index}]`);
      const field = nameField(item.field, `${label}[${index}].field`);
      const operator = item.operator;
      if (typeof operator !== 'string' || !operator)
        throw tableBadRequest(`${label}[${index}].operator must be text.`);
      return {
        fieldId: field.id,
        operator: operator as never,
        ...(item.value !== undefined ? { value: item.value as never } : {}),
      };
    });
  const mappedSort = options.sort?.map((item, index) => {
    if (!isRecord(item)) throw tableBadRequest(`sort[${index}] must be an object.`);
    assertKeys(item, ['field', 'direction'], `sort[${index}]`);
    const field = nameField(item.field, `sort[${index}].field`);
    const direction = item.direction ?? 'asc';
    if (direction !== 'asc' && direction !== 'desc')
      throw tableBadRequest(`sort[${index}].direction must be asc or desc.`);
    return { fieldId: field.id, direction } as const;
  });
  const selected =
    options.columns === undefined
      ? fields
      : options.columns.map((name, i) => nameField(name, `columns[${i}]`));
  if (new Set(selected.map((field) => field.id)).size !== selected.length)
    throw tableBadRequest('columns lists a field more than once.');
  const result = await TableEntries.listEntries(row.id, {
    page,
    pageSize,
    where: mapConditions(options.where, 'where'),
    sort: mappedSort,
  });
  const entries = result.entries.map((entry) => {
    const values: Record<string, TableEntryValue> = {};
    for (const field of selected)
      if (Object.hasOwn(entry.values, field.id))
        values[field.name] = entry.values[field.id] ?? null;
    return { id: entry.id, rev: shortRev(entry.revision), values };
  });
  return {
    table: row.name,
    tableId: row.id,
    entries,
    page: result.page,
    pageSize: result.pageSize,
    total: result.totalCount,
    hasMore: result.page * result.pageSize < result.totalCount,
    schemaVersion: result.schemaVersion,
  };
}

export async function readAgentEntries(
  table: unknown,
  ids: readonly unknown[]
): Promise<AgentEntriesResult> {
  if (!ids.length) throw tableBadRequest('ids must list at least one entry UUID.');
  if (ids.length > AGENT_READ_MAX_IDS)
    throw tableBadRequest(`ids: at most ${AGENT_READ_MAX_IDS} per read.`);
  const wanted: string[] = [];
  for (const [index, id] of ids.entries()) {
    if (typeof id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(id.trim()))
      throw tableBadRequest(`ids[${index}] must be an entry UUID.`);
    const normalized = id.trim().toLowerCase();
    if (!wanted.includes(normalized)) wanted.push(normalized);
  }
  const row = await resolveCustomTable(table);
  const fields = (await TableFields.listFields(row.id)).filter((field) => !field.managed);
  const entries: AgentEntry[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    let entry: Awaited<ReturnType<typeof TableEntries.getEntry>>['entry'];
    try {
      ({ entry } = await TableEntries.getEntry(row.id, id));
    } catch (error) {
      if (error instanceof AppError && error.statusCode === HTTP_STATUS.NOT_FOUND) {
        missing.push(id);
        continue;
      }
      throw error;
    }
    const values: Record<string, TableEntryValue> = {};
    for (const field of fields)
      if (Object.hasOwn(entry.values, field.id))
        values[field.name] = entry.values[field.id] ?? null;
    const repeats: Record<string, string> = {};
    if (fields.some((field) => field.recurrence)) {
      const view = await TableEntries.entryRepeats(row.id, entry.id);
      for (const field of fields) {
        const repeat = view.repeats[field.id];
        if (repeat) repeats[field.name] = repeatText(field, repeat);
      }
    }
    entries.push({
      id: entry.id,
      rev: shortRev(entry.revision),
      values,
      ...(Object.keys(repeats).length ? { repeats } : {}),
    });
  }
  return { table: row.name, tableId: row.id, entries, missing };
}

/** "Every month on the 1st · Sun Nov 1". */
function repeatText(field: TableField, repeat: TableRepeat): string {
  const summary = tableRepeatSummary(repeat, { hasEnd: field.range });
  const now = tableRepeatCellText(repeat);
  return `${summary} · ${now}`;
}

const REPEAT_ITEM_KEYS = new Set(['id', 'field', 'set', 'done', 'skip']);
/**
 * What a repeat `set` may carry. Anything else is refused rather than
 * dropped, so a caller still sending a removed param (`within`, the
 * time-to-do-it window; `quota`, a repeat done a number of times) learns
 * it did nothing instead of believing it took.
 */
const REPEAT_SET_KEYS = new Set(['rrule', 'date']);

/** The repeat route call one agent repeat item makes. Exported for its unit test. */
export function repeatCall(
  item: AgentRepeatItem,
  label: string
): { action: RepeatAction; body: Record<string, unknown> } {
  if (!isRecord(item)) throw tableBadRequest(`${label} must be an object.`);
  for (const key of Object.keys(item))
    if (!REPEAT_ITEM_KEYS.has(key))
      throw tableBadRequest(`${label}.${key} isn't a repeat key (id, field, set, done, skip).`);
  const given = (['set', 'done', 'skip'] as const).filter((key) => item[key] !== undefined);
  if (given.length !== 1)
    throw tableBadRequest(`${label}: give exactly one of set (null stops it), done or skip.`);
  if (item.set === null) return { action: 'clear', body: {} };
  if (item.set !== undefined) {
    if (!isRecord(item.set) || typeof item.set.rrule !== 'string')
      throw tableBadRequest(`${label}.set needs an rrule (and an optional date).`);
    for (const key of Object.keys(item.set))
      if (!REPEAT_SET_KEYS.has(key))
        throw tableBadRequest(`${label}.set.${key} isn't a repeat set key (rrule, date); drop it.`);
    const { rrule, date } = item.set;
    return {
      action: 'set',
      body: {
        rrule,
        ...(date !== undefined ? { date } : {}),
      },
    };
  }
  if (item.done !== undefined) {
    if (item.done !== true) throw tableBadRequest(`${label}.done must be true.`);
    return { action: 'complete', body: {} };
  }
  if (item.skip === 'now') return { action: 'skip', body: { jump: true } };
  if (item.skip !== true) throw tableBadRequest(`${label}.skip must be true or "now".`);
  return { action: 'skip', body: {} };
}

/**
 * The write's repeat items, in order, each one undoable step through the
 * repeat routes (so the realtime events and hooks fire as for a person).
 * Stops at the first failure; the ones before it stay.
 */
async function writeAgentRepeats(
  row: TableCatalogRow,
  items: readonly AgentRepeatItem[]
): Promise<NonNullable<AgentWriteResult['repeats']>> {
  const fields = (await TableFields.listFields(row.id)).filter((field) => !field.managed);
  const out: NonNullable<AgentWriteResult['repeats']> = [];
  for (const [index, item] of items.entries()) {
    const label = `repeat[${index}]`;
    const call = repeatCall(item, label);
    const name = typeof item.field === 'string' ? item.field.trim().toLowerCase() : '';
    const field = fields.find((candidate) => candidate.name.toLowerCase() === name);
    if (!field || (field.type !== 'date' && field.type !== 'datetime'))
      throw tableBadRequest(`${label}.field must name a date or datetime field of ${row.name}.`);
    if (typeof item.id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(item.id.trim()))
      throw tableBadRequest(`${label}.id must be an entry UUID.`);
    const id = item.id.trim().toLowerCase();
    const current = await TableEntries.getEntry(row.id, id);
    const result = await tableEntryRepeatAction(row.id, id, field.id, call.action, {
      ...call.body,
      expectedRevision: current.entry.revision,
      schemaVersion: current.schemaVersion,
    });
    out.push({
      id,
      field: field.name,
      rev: shortRev(result.entry.revision),
      repeat: result.repeat ? repeatText(field, result.repeat) : 'stopped',
    });
  }
  return out;
}

function pgCode(error: unknown): string | undefined {
  const code = isRecord(error) || error instanceof Error ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * One read-only SELECT over `user_tables`, run as the tables reader. Refusals
 * before PostgreSQL and PostgreSQL's own errors are 400s carrying only the
 * message; no reader connection is a 503.
 */
export async function queryAgentTables(
  sql: string,
  opts: { limit: number; maxCell: number }
): Promise<AgentQueryResult> {
  let result: Awaited<ReturnType<typeof TableQuery.select>>;
  try {
    result = await TableQuery.select(sql, { limit: opts.limit, maxCell: opts.maxCell });
  } catch (error) {
    if (error instanceof TableQueryError) throw tableBadRequest(getErrorMessage(error));
    const code = pgCode(error);
    if (code === '57014' || getErrorMessage(error) === 'Query read timeout')
      throw tableBadRequest(SLOW_QUERY_MESSAGE);
    if (code !== undefined && /^[0-9A-Z]{5}$/.test(code))
      throw new AppError(
        getErrorMessage(error),
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST,
        true,
        { sqlState: code }
      );
    throw error;
  }
  if (!result.ok)
    throw new AppError(
      result.message,
      ErrorCode.SERVICE_UNAVAILABLE,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
  const itemTitles = await queryItemTitles(result.columns, result.rows);
  return {
    columns: result.columns,
    rows: result.rows,
    ...(result.types ? { types: result.types } : {}),
    capped: result.capped,
    ...(itemTitles.length ? { itemTitles } : {}),
  };
}

/**
 * The ids in one result cell: a single id, a list as the query renders it
 * (`["a","b"]`), or an array literal cast to text (`{a,"b"}`).
 */
function cellIds(cell: string): string[] {
  const text = cell.trim();
  let parts: unknown[] = [text];
  if (text.startsWith('[') && text.endsWith(']')) parts = safeJsonParse<unknown[]>(text, []);
  else if (text.startsWith('{') && text.endsWith('}'))
    parts = text
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim().replace(/^"(.*)"$/, '$1'));
  return (Array.isArray(parts) ? parts : []).filter(
    (part): part is string => typeof part === 'string' && TABLE_REFERENCE_ID_PATTERN.test(part)
  );
}

/**
 * Titles for the ids in result columns named like an active item relation
 * of an active custom table (SQL output names are all a query leaves, so a
 * column is matched by name). Never fails the query: titles are a courtesy.
 */
async function queryItemTitles(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | null>>
): Promise<NonNullable<AgentQueryResult['itemTitles']>> {
  if (!rows.length) return [];
  try {
    const { rows: fields } = await getDb().query<{ column_name: string; kind: string }>(
      `SELECT DISTINCT field.column_name, field.reference_kind AS kind
         FROM public.table_fields AS field
         JOIN public.table_catalog AS catalog ON catalog.id = field.table_id
        WHERE field.reference_kind IS NOT NULL AND field.state = 'active'
          AND catalog.origin = 'custom' AND catalog.state = 'active'`
    );
    const kindsByColumn = new Map<string, TableReferenceKind[]>();
    for (const field of fields)
      if (isTableReferenceKind(field.kind))
        kindsByColumn.set(field.column_name, [
          ...(kindsByColumn.get(field.column_name) ?? []),
          field.kind,
        ]);
    const idsByKind = new Map<TableReferenceKind, string[]>();
    const seen = new Set<string>();
    columns.forEach((column, index) => {
      const kinds = kindsByColumn.get(column);
      if (!kinds) return;
      for (const row of rows) {
        const cell = row[index];
        if (typeof cell !== 'string') continue;
        for (const id of cellIds(cell)) {
          if (seen.size >= AGENT_QUERY_MAX_TITLES || seen.has(id)) continue;
          seen.add(id);
          for (const kind of kinds) idsByKind.set(kind, [...(idsByKind.get(kind) ?? []), id]);
        }
      }
    });
    if (!seen.size) return [];
    const items = await TableReferences.readItems(idsByKind);
    const titled = new Map<string, { id: string; title: string; archived: boolean }>();
    for (const byId of Object.values(items))
      for (const [id, item] of Object.entries(byId ?? {}))
        if (!titled.has(id)) titled.set(id, { id, ...item });
    return [...seen].flatMap((id) => titled.get(id) ?? []);
  } catch {
    return [];
  }
}

// --- write -------------------------------------------------------------------

/**
 * Node chip prefixes (`doc-…`, or the scheme form `doc:doc-…`) and the
 * `public.nodes` types each may name. `task` ids became docs. Agent, run,
 * project, model and file chips name no node row and are not checked.
 */
const NODE_CHIP_TYPES: Readonly<Record<string, readonly string[]>> = {
  thread_summary: ['thread_summary'],
  container: ['container'],
  message: ['message'],
  memory: ['memory'],
  thread: ['thread'],
  image: ['image'],
  post: ['post'],
  task: ['doc'],
  tool: ['tool'],
  doc: ['doc'],
};
const NODE_KINDS = Object.keys(NODE_CHIP_TYPES).join('|');
const NODE_PREFIXED_HREF = new RegExp(`^(${NODE_KINDS})-`);
const NODE_SCHEME_HREF = new RegExp(`^(${NODE_KINDS}):(.+)$`);
const ENTRY_HREF = /^entry:([^/]+)\/(.+)$/;
const TABLE_HREF_PREFIX = 'table:';

interface ReferenceCollector {
  entries: Map<string, EntryReferences['entries'][number]>;
  tables: Map<string, EntryReferences['tables'][number]>;
  nodes: Map<string, EntryReferences['nodes'][number]>;
}

/** Record the chip targets in one text value (code spans and blocks are not chips). */
function collectReferences(text: string, into: ReferenceCollector): void {
  for (const { targetId: href } of extractMarkdownRefs(text)) {
    if (href.startsWith('entry:')) {
      const match = ENTRY_HREF.exec(href);
      const tableId = match?.[1];
      const entryId = match?.[2];
      if (
        !tableId ||
        !entryId ||
        !TABLE_CATALOG_ID_PATTERN.test(tableId) ||
        !TABLE_ENTRY_ID_PATTERN.test(entryId)
      )
        throw tableBadRequest(
          `Bad reference (${href}): an entry chip is [name](entry:<table id>/<entry uuid>).`
        );
      into.entries.set(href, { tableId, entryId, href });
      continue;
    }
    if (href.startsWith(TABLE_HREF_PREFIX)) {
      const tableId = href.slice(TABLE_HREF_PREFIX.length);
      if (!TABLE_CATALOG_ID_PATTERN.test(tableId))
        throw tableBadRequest(`Bad reference (${href}): a table chip is [name](table:<table id>).`);
      into.tables.set(href, { tableId, href });
      continue;
    }
    const scheme = NODE_SCHEME_HREF.exec(href);
    const kind = scheme?.[1] ?? NODE_PREFIXED_HREF.exec(href)?.[1];
    if (kind === undefined) continue;
    into.nodes.set(href, { id: scheme?.[2] ?? href, types: NODE_CHIP_TYPES[kind] ?? [], href });
  }
}

type ParsedInsert = EntryBatchInsert;
type ParsedUpdate = EntryBatchUpdate;

/** Plain values: JSON numbers become decimal strings; everything else is checked by the model. */
function parseValues(
  raw: unknown,
  label: string,
  references: ReferenceCollector
): Record<string, TableEntryValue> {
  if (!isRecord(raw))
    throw tableBadRequest(`${label}: values must be an object keyed by field name.`);
  const values: Record<string, TableEntryValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    const stored =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : (value as TableEntryValue);
    if (typeof stored === 'string') {
      if (TABLE_QUERY_CUT_MARKER_PATTERN.test(stored))
        throw tableBadRequest(`${label}: ${name}: ${CUT_VALUE_MESSAGE}`);
      try {
        collectReferences(stored, references);
      } catch (error) {
        throw tableBadRequest(`${label}: ${name}: ${getErrorMessage(error)}`);
      }
    }
    Object.defineProperty(values, name, {
      value: stored,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return values;
}

function parseWrite(input: AgentWriteInput): {
  inserts: ParsedInsert[];
  updates: ParsedUpdate[];
  references: EntryReferences;
} {
  if (!isRecord(input)) throw tableBadRequest('Give insert and/or update rows.');
  const inserts: unknown = input.insert ?? [];
  const updates: unknown = input.update ?? [];
  if (!Array.isArray(inserts) || !Array.isArray(updates))
    throw tableBadRequest('insert and update must be lists of rows.');
  if (!inserts.length && !updates.length)
    throw tableBadRequest('Nothing to write: give insert and/or update rows.');
  if (inserts.length > AGENT_WRITE_MAX_ROWS || updates.length > AGENT_WRITE_MAX_ROWS)
    throw tableBadRequest(`insert and update take at most ${AGENT_WRITE_MAX_ROWS} rows each.`);
  const collector: ReferenceCollector = { entries: new Map(), tables: new Map(), nodes: new Map() };
  const claimed = new Map<string, string>();
  const claim = (id: string, label: string): void => {
    const prior = claimed.get(id.toLowerCase());
    if (prior)
      throw tableBadRequest(`${label}: id ${id} is also in ${prior}; each id may appear once.`);
    claimed.set(id.toLowerCase(), label);
  };
  const uuid = (value: unknown, label: string, name: string): string => {
    if (typeof value !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(value))
      throw tableBadRequest(`${label}: ${name} must be an entry UUID.`);
    return value;
  };

  const parsedInserts = inserts.map((row: unknown, index): ParsedInsert => {
    const label = `insert[${index}]`;
    if (!isRecord(row)) throw tableBadRequest(`${label}: each row must be { values }.`);
    const id = row.id === undefined ? randomUUID() : uuid(row.id, label, 'id');
    claim(id, label);
    return {
      id,
      values: parseValues(row.values, label, collector),
      ...(row.before !== undefined ? { beforeEntryId: uuid(row.before, label, 'before') } : {}),
    };
  });
  const parsedUpdates = updates.map((row: unknown, index): ParsedUpdate => {
    const label = `update[${index}]`;
    if (!isRecord(row)) throw tableBadRequest(`${label}: each row must be { id, values }.`);
    const id = uuid(row.id, label, 'id');
    claim(id, label);
    if (
      row.rev !== undefined &&
      (typeof row.rev !== 'string' || !REVISION_PREFIX_PATTERN.test(row.rev))
    )
      throw tableBadRequest(`${label}: rev must be at least 8 hex characters of the entry rev.`);
    return {
      id,
      values: parseValues(row.values, label, collector),
      ...(typeof row.rev === 'string' ? { revisionPrefix: row.rev.toLowerCase() } : {}),
    };
  });
  return {
    inserts: parsedInserts,
    updates: parsedUpdates,
    references: {
      entries: [...collector.entries.values()],
      tables: [...collector.tables.values()],
      nodes: [...collector.nodes.values()],
    },
  };
}

/** A conflict's current entry, with the agent-facing short `rev` instead of the revision. */
function agentConflict(error: unknown): unknown {
  if (!(error instanceof AppError) || !isRecord(error.details) || !isRecord(error.details.entry))
    return error;
  const { revision, ...entry } = error.details.entry;
  return new AppError(getErrorMessage(error), error.code, error.statusCode, error.isOperational, {
    ...error.details,
    entry: { ...entry, ...(typeof revision === 'string' ? { rev: shortRev(revision) } : {}) },
  });
}

/**
 * Insert, then update, entries in one transaction: all or nothing. Inserts
 * run in order, so one may link to an entry inserted before it. Chips in text
 * values must resolve inside the same transaction.
 */
export async function writeAgentEntries(
  table: string,
  input: AgentWriteInput
): Promise<AgentWriteResult> {
  const key = tableKey(table);
  const repeatItems = isRecord(input) && Array.isArray(input.repeat) ? input.repeat : [];
  if (isRecord(input) && input.repeat !== undefined && !Array.isArray(input.repeat))
    throw tableBadRequest('repeat must be a list of repeat changes.');
  if (repeatItems.length > AGENT_WRITE_MAX_ROWS)
    throw tableBadRequest(`repeat takes at most ${AGENT_WRITE_MAX_ROWS} changes.`);
  const rowsGiven =
    isRecord(input) &&
    ((Array.isArray(input.insert) && input.insert.length > 0) ||
      (Array.isArray(input.update) && input.update.length > 0));
  if (repeatItems.length && !rowsGiven) {
    const row = customOnly(await findTable(key), key);
    assertStillNamed(row, key);
    return {
      tableId: row.id,
      inserted: [],
      existing: [],
      updated: [],
      unchanged: [],
      repeats: await writeAgentRepeats(row, repeatItems),
    };
  }
  const { inserts, updates, references } = parseWrite(input);
  const found = await findTable(key);
  refuseAutomationsTable(found?.id);
  const row = customOnly(found, key);
  const history = historyContext();
  // Previous values of the rows being patched, so table_entry:update can
  // carry from/to for each changed field (best effort: a missing row 404s
  // inside writeBatch anyway).
  const previous = new Map<string, TableEntryValues | undefined>();
  for (const update of updates)
    previous.set(update.id, await previousEntryValues(row.id, update.id));
  let result: Awaited<ReturnType<typeof TableEntries.writeBatch>>;
  try {
    result = await TableEntries.writeBatch(
      row.id,
      {
        inserts,
        updates,
        ...(isCatalogId(key) ? {} : { expectedName: key }),
        references,
        resolveItemNames: true,
      },
      history
    );
  } catch (error) {
    throw agentConflict(error);
  }
  const changed = [...result.inserted, ...result.updated].map((entry) => entry.id);
  if (changed.length) {
    // Built (one name read) before any emit, so the events go out in order.
    const events = await occurrenceEvents(result.occurrences.flat(), 'status', history.actor);
    emitTableEntriesChanged(row.id, changed);
    for (const entry of result.inserted) emitTableEntryCreated(row.id, entry.id);
    let next = 0;
    for (const [index, entry] of result.updated.entries()) {
      emitTableEntryUpdated(
        row.id,
        entry.id,
        tableEntryChanges(previous.get(entry.id), entry.values)
      );
      // The occurrences its done status completed, right after its update event.
      const count = result.occurrences[index]?.length ?? 0;
      emitOccurrenceEvents(events.slice(next, next + count));
      next += count;
    }
    await afterTableWrite(history.actor);
  }
  const short = (entry: { id: string; revision: string }) => ({
    id: entry.id,
    rev: shortRev(entry.revision),
  });
  return {
    tableId: row.id,
    inserted: result.inserted.map(short),
    existing: result.existing.map(short),
    updated: result.updated.map(short),
    unchanged: result.unchanged.map((entry) => entry.id),
    ...(repeatItems.length ? { repeats: await writeAgentRepeats(row, repeatItems) } : {}),
  };
}

// --- schema ------------------------------------------------------------------

const SCHEMA_OPS = [
  'add_field',
  'update_field',
  'reorder_fields',
  'rename_table',
  'archive_field',
  'delete_field',
  'restore_field',
  'set_title_field',
  'archive_table',
  'delete_table',
  'restore_table',
  'set_project',
] as const;

/** The shapes of a field input's date settings (`repeats`, `calendar`). */
function checkDateSettings(raw: Record<string, unknown>, label: string): void {
  if (raw.repeats !== undefined && typeof raw.repeats !== 'boolean')
    throw tableBadRequest(`${label}: repeats must be true or false.`);
  const calendar = raw.calendar;
  if (
    calendar !== undefined &&
    calendar !== null &&
    (typeof calendar !== 'string' || !calendar.trim())
  )
    throw tableBadRequest(`${label}: calendar must be a calendar name or id, or null.`);
}

function parseFieldInput(raw: unknown, label: string): AgentFieldInput {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.type !== 'string')
    throw tableBadRequest(`${label}: a field needs a name and a type.`);
  for (const key of ['ref', 'before'] as const)
    if (raw[key] !== undefined && typeof raw[key] !== 'string')
      throw tableBadRequest(`${label}: ${key} must be a field or table name.`);
  checkDateSettings(raw, label);
  return raw as unknown as AgentFieldInput;
}

function parseOp(raw: unknown, label: string): AgentSchemaOp {
  if (!isRecord(raw) || !SCHEMA_OPS.some((op) => op === raw.op))
    throw tableBadRequest(`${label}: op must be one of ${SCHEMA_OPS.join(', ')}.`);
  switch (raw.op) {
    case 'add_field':
      return { op: 'add_field', field: parseFieldInput(raw.field, label) };
    case 'update_field': {
      if (typeof raw.name !== 'string' || !isRecord(raw.set))
        throw tableBadRequest(`${label}: update_field needs the field name and a set object.`);
      for (const key of ['name', 'type', 'ref', 'before'] as const)
        if (raw.set[key] !== undefined && typeof raw.set[key] !== 'string')
          throw tableBadRequest(`${label}: set.${key} must be text.`);
      checkDateSettings(raw.set, label);
      if (raw.clear_repeats !== undefined && typeof raw.clear_repeats !== 'boolean')
        throw tableBadRequest(`${label}: clear_repeats must be true or false.`);
      return {
        op: 'update_field',
        name: raw.name,
        set: raw.set as Partial<AgentFieldInput>,
        ...(typeof raw.clear_repeats === 'boolean' ? { clear_repeats: raw.clear_repeats } : {}),
      };
    }
    case 'reorder_fields':
      if (!Array.isArray(raw.names) || !raw.names.every((name) => typeof name === 'string'))
        throw tableBadRequest(`${label}: reorder_fields needs names, a list of field names.`);
      return { op: 'reorder_fields', names: raw.names as string[] };
    case 'archive_field':
    case 'delete_field':
    case 'set_title_field':
      if (typeof raw.name !== 'string')
        throw tableBadRequest(`${label}: ${raw.op} needs the field name.`);
      return { op: raw.op, name: raw.name };
    case 'restore_field':
      if (typeof raw.name !== 'string' || (raw.as !== undefined && typeof raw.as !== 'string'))
        throw tableBadRequest(`${label}: restore_field needs the archived field's name.`);
      return {
        op: 'restore_field',
        name: raw.name,
        ...(typeof raw.as === 'string' ? { as: raw.as } : {}),
      };
    case 'archive_table':
      return { op: 'archive_table' };
    case 'delete_table':
      if (raw.clear_links !== undefined && typeof raw.clear_links !== 'boolean')
        throw tableBadRequest(`${label}: clear_links must be true or false.`);
      return {
        op: 'delete_table',
        ...(typeof raw.clear_links === 'boolean' ? { clear_links: raw.clear_links } : {}),
      };
    case 'restore_table':
      if (raw.as !== undefined && typeof raw.as !== 'string')
        throw tableBadRequest(`${label}: as must be the new name.`);
      return { op: 'restore_table', ...(typeof raw.as === 'string' ? { as: raw.as } : {}) };
    case 'set_project':
      if (raw.project_id !== null && typeof raw.project_id !== 'string')
        throw tableBadRequest(`${label}: set_project needs project_id, a project id or null.`);
      return { op: 'set_project', project_id: raw.project_id };
    default:
      if (typeof raw.name !== 'string')
        throw tableBadRequest(`${label}: rename_table needs the new name.`);
      return { op: 'rename_table', name: raw.name };
  }
}

function parseSchema(input: AgentSchemaInput): {
  fields: AgentFieldInput[] | undefined;
  ops: AgentSchemaOp[];
} {
  if (!isRecord(input))
    throw tableBadRequest('Give fields to create the table, or ops to change it.');
  const fields: unknown = input.fields;
  const ops: unknown = input.ops ?? [];
  if (fields !== undefined && !Array.isArray(fields))
    throw tableBadRequest('fields must be a list of fields.');
  if (!Array.isArray(ops)) throw tableBadRequest('ops must be a list of changes.');
  if (fields === undefined && !ops.length)
    throw tableBadRequest('Give fields to create the table, or ops to change it.');
  return {
    fields: fields?.map((field: unknown, index) => parseFieldInput(field, `fields[${index}]`)),
    ops: ops.map((op: unknown, index) => parseOp(op, `ops[${index}]`)),
  };
}

function fieldNamed(fields: readonly TableField[], name: string): TableField {
  const field =
    fields.find((candidate) => candidate.name === name) ??
    fields.find((candidate) => candidate.name === name.toLowerCase());
  if (!field)
    throw new AppError(
      `No field named "${name}". Fields: ${fields.map((candidate) => candidate.name).join(', ')}.`,
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  return field;
}

function trimmedDescription(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

interface SchemaRun {
  tableId: string;
  tables: LockedTables;
  /** Relation `ref` (lowercased) → its target: a table or a Snaglet item kind. */
  refs: ReadonlyMap<string, RefTarget>;
  tx: DbQueryable;
  journal: HistoryJournal;
  fieldsChanged: boolean;
  renamed: boolean;
  /** Set when set_project moved the table into or out of a project. */
  projectChanged: boolean;
  /** Set when an op archived, deleted or restored the table. */
  lifecycle: 'archived' | 'deleted' | 'restored' | null;
  /** Other tables whose relation fields a delete_table removed. */
  unlinkedTables: Set<string>;
  /** `calendar` (lowercased) → its calendar id, or `'default'` (resolveCalendars). */
  calendars: ReadonlyMap<string, string>;
  /** Calendars a field joined or left: each gets one `calendar:changed` after commit. */
  bindings: Set<string>;
}

/** A relation target: exactly one of a custom table and a Snaglet item kind. */
interface RefTarget {
  referenceTableId: string | null;
  referenceKind: TableReferenceKind | null;
}

const NO_TARGET: RefTarget = { referenceTableId: null, referenceKind: null };

function refTarget(run: SchemaRun, ref: string | undefined): RefTarget {
  if (ref === undefined) return NO_TARGET;
  const target = run.refs.get(ref.trim().toLowerCase());
  if (!target) throw new Error(`Unresolved relation target: ${ref}`);
  return target;
}

function isDateType(type: string): boolean {
  return type === 'date' || type === 'datetime';
}

/** A new repeat setting: no status field, rows completed with Done / Skip (the editor's switch). */
const newRecurrence = defaultRecurrence;

/** Repeats and a calendar belong to date and datetime fields only. */
function assertDateSettings(name: string, type: string, input: Partial<AgentFieldInput>): void {
  const asks = input.repeats === true || (input.calendar !== undefined && input.calendar !== null);
  if (asks && !isDateType(type))
    throw tableBadRequest(
      `Only date and datetime fields can repeat or show on a calendar; ${name} is ${type}.`
    );
}

/** The calendar id (or `'default'`) a field input names; null takes it off; undefined keeps it. */
function calendarFor(
  run: SchemaRun,
  calendar: string | null | undefined
): string | null | undefined {
  if (calendar === undefined || calendar === null) return calendar;
  const id = run.calendars.get(calendar.trim().toLowerCase());
  if (!id) throw new Error(`Unresolved calendar: ${calendar}`);
  return id;
}

/**
 * The repeat setting an update asks for: undefined keeps the current one,
 * null turns it off. Turning it on when it is on keeps the setting (a status
 * field the editor chose).
 */
function nextRecurrence(
  field: TableField,
  set: Partial<AgentFieldInput>
): TableFieldRecurrence | null | undefined {
  if (set.repeats === false) return null;
  if (set.repeats === true) return field.recurrence ?? newRecurrence();
  return undefined;
}

/** Rows of a field holding a repeat: turning its repeats off removes them. */
async function repeatingRows(run: SchemaRun, fieldId: string): Promise<number> {
  const { rows } = await run.tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.table_entry_repeats WHERE field_id = $1',
    [fieldId]
  );
  return rows[0]?.n ?? 0;
}

/** A field's calendar changed: both calendars hear about it after commit. */
function noteBinding(run: SchemaRun, was: string | null, now: string | null): void {
  if (was === now) return;
  if (was) run.bindings.add(was);
  if (now) run.bindings.add(now);
}

function optionLabel(value: string): string {
  return value.trim();
}

/** A new field's options: labels (and colors) only. */
function newOptions(items: readonly AgentOptionInput[]): TableSelectOptionInput[] {
  return items.map((item) => {
    if (typeof item === 'string') return { label: optionLabel(item) };
    if ('from' in item)
      throw tableBadRequest('A new field has no options to rename; list its labels.');
    return { label: optionLabel(item.label), ...(item.color ? { color: item.color } : {}) };
  });
}

/**
 * The full option list an update asks for, matched to the field's current
 * options by label (exactly, else ignoring case), so kept and renamed options
 * keep their ids and colors; `renamed` maps each current label to its new
 * one, or to nothing when the option is removed.
 */
function editedOptions(
  field: TableField,
  items: readonly AgentOptionInput[]
): { options: TableSelectOptionInput[]; renamed: Map<string, string | undefined> } {
  const current = field.type === 'select' ? (field.options ?? []) : [];
  const find = (label: string) =>
    current.find((option) => option.label === label) ??
    current.find((option) => option.label.toLowerCase() === label.toLowerCase());
  const options = items.map((item): TableSelectOptionInput => {
    if (typeof item !== 'string' && 'from' in item) {
      const existing = find(optionLabel(item.from));
      if (!existing)
        throw tableBadRequest(
          `No option "${item.from}" to rename. Options: ${current.map((option) => option.label).join(', ') || 'none'}.`
        );
      return { id: existing.id, label: optionLabel(item.to), color: item.color ?? existing.color };
    }
    const label = optionLabel(typeof item === 'string' ? item : item.label);
    const color = typeof item === 'string' ? undefined : item.color;
    const existing = find(label);
    if (!existing) return { label, ...(color ? { color } : {}) };
    return { id: existing.id, label, color: color ?? existing.color };
  });
  const byId = new Map(options.map((option) => [option.id, option.label]));
  return {
    options,
    renamed: new Map(current.map((option) => [option.label, byId.get(option.id)])),
  };
}

/** A select default carried through option renames and removals. */
function followOptions(
  value: TableFieldDefault,
  renamed: ReadonlyMap<string, string | undefined>
): TableFieldDefault {
  const follow = (label: string) => (renamed.has(label) ? renamed.get(label) : label);
  if (typeof value === 'string') return follow(value) ?? null;
  if (Array.isArray(value))
    return value.flatMap((label) => {
      const next = follow(label);
      return next === undefined ? [] : [next];
    });
  return value;
}

async function addField(run: SchemaRun, input: AgentFieldInput): Promise<void> {
  assertDateSettings(input.name, input.type, input);
  const calendarId = calendarFor(run, input.calendar);
  const current = await TableFields.listFields(run.tableId, run.tx);
  const request: CreateTableFieldRequest = {
    id: generateId('field'),
    name: input.name.trim(),
    description: trimmedDescription(input.description),
    type: input.type,
    // Checkboxes are two-state, like the grid's: required, unchecked by default.
    nullable: input.nullable ?? input.type !== 'checkbox',
    defaultValue:
      input.default ?? (input.multiple === true ? [] : input.type === 'checkbox' ? false : null),
    ...refTarget(run, input.ref),
    ...(input.multiple !== undefined ? { multiple: input.multiple } : {}),
    ...(input.range !== undefined ? { range: input.range } : {}),
    ...(input.options !== undefined ? { options: newOptions(input.options) } : {}),
    ...(input.before !== undefined ? { beforeFieldId: fieldNamed(current, input.before).id } : {}),
    ...(input.repeats ? { recurrence: newRecurrence() } : {}),
    ...(calendarId ? { calendarId } : {}),
  };
  const { field } = await TableFields.createFieldInTx(
    run.tableId,
    request,
    run.tables,
    run.tx,
    run.journal
  );
  noteBinding(run, null, field.calendarId ?? null);
  run.fieldsChanged = true;
}

/** `fieldId` moved to sit just before `before`. */
async function moveField(run: SchemaRun, fieldId: string, before: string): Promise<void> {
  const current = await TableFields.listFields(run.tableId, run.tx);
  const target = fieldNamed(current, before);
  if (target.id === fieldId) throw tableBadRequest('A field cannot move before itself.');
  const order = current.map((field) => field.id).filter((id) => id !== fieldId);
  order.splice(order.indexOf(target.id), 0, fieldId);
  await TableFields.reorderFieldsInTx(run.tableId, order, run.tx, run.journal);
  run.fieldsChanged = true;
}

async function updateField(
  run: SchemaRun,
  name: string,
  set: Partial<AgentFieldInput>,
  clearRepeats?: boolean
): Promise<void> {
  const field = fieldNamed(await TableFields.listFields(run.tableId, run.tx), name);
  if (field.managed || field.type === 'uuid')
    throw new AppError(
      `${field.name} is managed by Snaglet and cannot be changed.`,
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  const type = set.type ?? field.type;
  assertDateSettings(field.name, type, set);
  const recurrence = nextRecurrence(field, set);
  if (field.recurrence && recurrence === null && clearRepeats !== true) {
    const rows = await repeatingRows(run, field.id);
    if (rows > 0)
      throw conflict(
        `${field.name} repeats on ${rows} ${rows === 1 ? 'row' : 'rows'}; turning repeats off removes ${rows === 1 ? 'its repeat' : 'their repeats'} (a person can undo it). Repeat with clear_repeats: true.`
      );
  }
  const calendarId = calendarFor(run, set.calendar);
  const multiple = set.multiple ?? (type === field.type && field.multiple);
  // Left out, an end date stays while the field stays a date (Include time on or off).
  const range = set.range ?? ((type === 'date' || type === 'datetime') && field.range);
  const edited = set.options !== undefined ? editedOptions(field, set.options) : null;
  const next = {
    name: set.name?.trim() ?? field.name,
    description: 'description' in set ? trimmedDescription(set.description) : field.description,
    type,
    // A single relation is always optional, and a list (never null) becoming
    // one value starts optional too.
    nullable:
      set.nullable ??
      (type === 'relation' || (field.multiple && !multiple) ? true : field.nullable),
    defaultValue: field.defaultValue,
    ...(set.ref !== undefined
      ? refTarget(run, set.ref)
      : type === 'relation'
        ? { referenceTableId: field.referenceTableId, referenceKind: field.referenceKind ?? null }
        : NO_TARGET),
    multiple,
    range,
    ...(edited ? { options: edited.options } : {}),
  };
  if ('default' in set) next.defaultValue = set.default ?? null;
  // Dropping the time keeps the default's date, as it keeps each value's.
  else if (field.type === 'datetime' && type === 'date' && typeof field.defaultValue === 'string')
    next.defaultValue = tableDateTimeLocalDate(field.defaultValue, userTimeZone());
  else if (type === 'select' && field.type === 'select') {
    // The default follows renamed options, drops removed ones and changes shape with the field.
    let fallback = edited ? followOptions(field.defaultValue, edited.renamed) : field.defaultValue;
    if (multiple && !field.multiple) fallback = typeof fallback === 'string' ? [fallback] : [];
    if (!multiple && field.multiple)
      fallback = Array.isArray(fallback) && fallback.length === 1 ? (fallback[0] ?? null) : null;
    next.defaultValue = fallback;
  } else if (type === 'select') next.defaultValue = multiple ? [] : null;
  // A shape change keeps the old default only while it still fits.
  else if (
    (type !== field.type || multiple !== field.multiple || range !== field.range) &&
    tableFieldDefinitionProblem(next) !== null
  )
    next.defaultValue = null;
  // A range has no default; gaining an end drops the one the date had.
  if (range && !('default' in set)) next.defaultValue = null;
  const request: UpdateTableFieldRequest = {
    ...next,
    ...(recurrence !== undefined ? { recurrence } : {}),
    ...(calendarId !== undefined ? { calendarId } : {}),
    expectedRevision: field.revision,
  };
  const updated = await TableFields.updateFieldInTx(
    run.tableId,
    field.id,
    request,
    run.tables,
    run.tx,
    run.journal
  );
  noteBinding(run, field.calendarId ?? null, updated.calendarId ?? null);
  if (updated.revision !== field.revision) run.fieldsChanged = true;
  if (set.before !== undefined) await moveField(run, field.id, set.before);
}

/** Listed fields fill the non-managed display slots in order; managed fields keep theirs. */
async function reorderFields(run: SchemaRun, names: string[]): Promise<void> {
  const current = await TableFields.listFields(run.tableId, run.tx);
  const own = current.filter((field) => !field.managed);
  const listed = names.map((name) => fieldNamed(own, name).id);
  if (new Set(listed).size !== listed.length)
    throw tableBadRequest('names must list each field once.');
  const missing = own.filter((field) => !listed.includes(field.id)).map((field) => field.name);
  if (missing.length)
    throw tableBadRequest(
      `names must list every field except id and created_at; missing: ${missing.join(', ')}.`
    );
  let next = 0;
  const order = current.map((field) => (field.managed ? field.id : (listed[next++] ?? field.id)));
  await TableFields.reorderFieldsInTx(run.tableId, order, run.tx, run.journal);
  run.fieldsChanged = true;
}

function unmanagedField(fields: readonly TableField[], name: string): TableField {
  const field = fieldNamed(fields, name);
  if (field.managed)
    throw new AppError(
      `${field.name} is managed by Snaglet and cannot be changed.`,
      ErrorCode.FORBIDDEN,
      HTTP_STATUS.FORBIDDEN
    );
  return field;
}

async function retireNamedField(
  run: SchemaRun,
  name: string,
  state: 'archived' | 'deleted'
): Promise<void> {
  const current = await TableFields.listFields(run.tableId, run.tx);
  const matches = (candidate: TableField) =>
    candidate.name === name || candidate.name === name.toLowerCase();
  // An archived field can still be deleted by its name.
  const archived =
    state === 'deleted' && !current.some(matches)
      ? (await TableLifecycle.listArchivedFields(run.tableId, run.tx)).find(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase()
        )
      : undefined;
  const field = archived ?? unmanagedField(current, name);
  const { changed } = await TableLifecycle.retireFieldInTx(
    run.tables,
    run.tableId,
    field.id,
    state,
    run.journal,
    run.tx
  );
  run.fieldsChanged ||= changed;
}

async function restoreNamedField(run: SchemaRun, name: string, as?: string): Promise<void> {
  const archived = await TableLifecycle.listArchivedFields(run.tableId, run.tx);
  const field = archived.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!field)
    throw new AppError(
      `No archived field named "${name}".${archived.length ? ` Archived: ${archived.map((candidate) => candidate.name).join(', ')}.` : ''}`,
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  const { changed } = await TableLifecycle.restoreFieldInTx(
    run.tables,
    run.tableId,
    field.id,
    as?.trim(),
    run.journal,
    run.tx
  );
  run.fieldsChanged ||= changed;
}

async function setTitle(run: SchemaRun, name: string): Promise<void> {
  const field = unmanagedField(await TableFields.listFields(run.tableId, run.tx), name);
  if (field.type !== 'text')
    throw tableBadRequest(`${field.name} is not text; the title field must be text.`);
  const changed = await TableLifecycle.setTitleFieldInTx(
    run.tables,
    run.tableId,
    field.id,
    run.journal,
    run.tx
  );
  run.fieldsChanged ||= changed;
}

async function applyOp(run: SchemaRun, op: AgentSchemaOp): Promise<void> {
  switch (op.op) {
    case 'add_field':
      return addField(run, op.field);
    case 'update_field':
      return updateField(run, op.name, op.set, op.clear_repeats);
    case 'reorder_fields':
      return reorderFields(run, op.names);
    case 'rename_table': {
      const { table, renamed } = await renameTableInTx(run.tableId, op.name, run.tx, run.journal);
      // Later DDL in this transaction must address the renamed physical table.
      run.tables.set(run.tableId, table);
      run.renamed ||= renamed;
      return;
    }
    case 'archive_field':
      return retireNamedField(run, op.name, 'archived');
    case 'delete_field':
      return retireNamedField(run, op.name, 'deleted');
    case 'restore_field':
      return restoreNamedField(run, op.name, op.as);
    case 'set_title_field':
      return setTitle(run, op.name);
    case 'archive_table': {
      const { changed } = await TableLifecycle.archiveTableInTx(
        run.tables,
        run.tableId,
        run.journal,
        run.tx
      );
      if (changed) run.lifecycle = 'archived';
      return;
    }
    case 'delete_table': {
      const { linked } = await TableLifecycle.deleteTableInTx(
        run.tables,
        run.tableId,
        op.clear_links === true,
        run.journal,
        run.tx
      ).catch((error: unknown) => {
        if (
          error instanceof AppError &&
          error.statusCode === HTTP_STATUS.CONFLICT &&
          isRecord(error.details) &&
          Array.isArray(error.details.linkedFields)
        )
          throw conflict(
            `${getErrorMessage(error).replace(/ Confirm to .*$/, '')} Repeat with clear_links:true to delete them with the table.`
          );
        throw error;
      });
      for (const field of linked) run.unlinkedTables.add(field.tableId);
      run.lifecycle = 'deleted';
      return;
    }
    case 'restore_table': {
      assertNoArchiveSweep();
      const { changed } = await TableLifecycle.restoreTableInTx(
        run.tables,
        run.tableId,
        op.as?.trim(),
        run.journal,
        run.tx
      );
      if (changed) run.lifecycle = 'restored';
      return;
    }
    case 'set_project': {
      const before = run.tables.get(run.tableId);
      if (!before) throw new Error('The table is not locked');
      // An earlier op in this call may have archived or deleted the table;
      // placement then follows the rule every other op on it follows.
      if (before.state === 'deleted')
        throw new AppError(
          `Table not found: ${before.id}`,
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      if (before.state === 'archived')
        throw conflict(`${before.name} is archived. Restore it to move it.`);
      const moved = await TableCatalog.setProject(run.tableId, op.project_id, run.tx);
      if (!moved) throw new Error(`Table ${run.tableId} vanished while it was locked`);
      // The link is placement, not content: the journal stays as it is.
      run.tables.set(run.tableId, moved);
      run.projectChanged ||= moved.projectId !== before.projectId;
      return;
    }
  }
}

async function labeledStep(label: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    const mapped = mapFieldDatabaseError(error);
    if (!(mapped instanceof AppError)) throw mapped;
    throw new AppError(
      `${label}: ${mapped.message}`,
      mapped.code,
      mapped.statusCode,
      mapped.isOperational,
      mapped.details
    );
  }
}

/** 409 for a create whose name is taken, carrying that table's summary. */
async function nameTakenConflict(row: TableCatalogRow): Promise<AppError> {
  return conflict(`A table named "${row.name}" already exists.`, {
    table: row.origin === 'custom' ? await describeRow(row) : toTableCatalogEntry(row),
  });
}

/**
 * Relation targets named by `ref`: `snaglet:<kind>` is that kind of Snaglet item; this
 * table's own name (current, created or renamed-to) links to itself; other
 * names must be custom tables, resolved to catalog ids.
 */
async function resolveRefs(
  fields: readonly AgentFieldInput[],
  ops: readonly AgentSchemaOp[],
  self: { id: string; names: string[] }
): Promise<Map<string, RefTarget>> {
  const named = [
    ...fields.map((field) => field.ref),
    ...ops.map((op) =>
      op.op === 'add_field' ? op.field.ref : op.op === 'update_field' ? op.set.ref : undefined
    ),
  ].filter((ref): ref is string => ref !== undefined);
  const selfNames = new Set([self.id, ...self.names].map((name) => name.toLowerCase()));
  const refs = new Map<string, RefTarget>();
  for (const ref of named) {
    const key = ref.trim().toLowerCase();
    if (refs.has(key)) continue;
    if (key.startsWith(AGENT_ITEM_REF_PREFIX)) {
      const kind = key.slice(AGENT_ITEM_REF_PREFIX.length);
      if (!isTableReferenceKind(kind))
        throw tableBadRequest(
          `ref "${ref}": Snaglet items are ${TABLE_REFERENCE_KINDS.map((name) => `${AGENT_ITEM_REF_PREFIX}${name}`).join(', ')}.`
        );
      refs.set(key, { referenceTableId: null, referenceKind: kind });
      continue;
    }
    if (selfNames.has(key)) {
      refs.set(key, { referenceTableId: self.id, referenceKind: null });
      continue;
    }
    const target = key ? await findTable(ref.trim()) : null;
    if (!target) throw tableBadRequest(`ref "${ref}": no such table.`);
    if (target.origin !== 'custom')
      throw tableBadRequest(
        `ref "${ref}": relations link to custom tables or Snaglet items (${AGENT_ITEM_REF_PREFIX}doc, …).`
      );
    refs.set(key, { referenceTableId: target.id, referenceKind: null });
  }
  return refs;
}

const CALENDARS_SHOWN = 10;

/**
 * Calendars named by `calendar` (lowercased → id): a calendar's id,
 * else its title in any case (a title two share needs the id). `default`
 * matching no title is the Default calendar, which the model creates when
 * no calendar is active.
 */
async function resolveCalendars(
  fields: readonly AgentFieldInput[],
  ops: readonly AgentSchemaOp[]
): Promise<Map<string, string>> {
  const named = [
    ...fields.map((field) => field.calendar),
    ...ops.map((op) =>
      op.op === 'add_field'
        ? op.field.calendar
        : op.op === 'update_field'
          ? op.set.calendar
          : undefined
    ),
  ].filter((name): name is string => typeof name === 'string');
  const resolved = new Map<string, string>();
  if (!named.length) return resolved;
  const calendars = await Calendars.list();
  for (const name of named) {
    const wanted = name.trim();
    const key = wanted.toLowerCase();
    if (resolved.has(key)) continue;
    const byId = calendars.find((calendar) => calendar.id === wanted);
    const byTitle = calendars.filter((calendar) => calendar.title.toLowerCase() === key);
    const [only] = byTitle;
    if (byId) resolved.set(key, byId.id);
    else if (byTitle.length > 1)
      throw tableBadRequest(
        `${byTitle.length} calendars are called "${wanted}"; pass an id: ${byTitle.map((calendar) => calendar.id).join(', ')}.`
      );
    else if (only) resolved.set(key, only.id);
    else if (key === 'default') resolved.set(key, 'default');
    else {
      const known = calendars.slice(0, CALENDARS_SHOWN).map((calendar) => `"${calendar.title}"`);
      throw new AppError(
        `No calendar "${wanted}". Calendars: ${known.join(', ') || 'none ("default" makes the Default calendar)'}.`,
        ErrorCode.NOT_FOUND,
        HTTP_STATUS.NOT_FOUND
      );
    }
  }
  return resolved;
}

/**
 * The project a table created by this call starts in: the calling thread's,
 * read the way a doc or thread an agent creates gets its project, or
 * workspace-wide when there is no thread (an MCP client, hook or SDK code) or
 * the thread has no project. A set_project op in the same call is an explicit
 * choice, null included, so the table starts workspace-wide and that op
 * places it.
 */
async function startingProject(
  ops: readonly AgentSchemaOp[],
  threadId: string | undefined
): Promise<string | null> {
  if (!threadId || ops.some((op) => op.op === 'set_project')) return null;
  return Nodes.getProjectId(threadId);
}

/**
 * Create and/or alter a table in one transaction. `fields` creates it (409
 * with the existing table's summary when the name is taken) with those fields
 * after its Name field, in the calling thread's project unless a set_project
 * op says otherwise ({@link startingProject}); `ops` then apply in order.
 * Every table touched — the table, each `ref`, and the current targets of its
 * relation fields — is locked once up front. A failing step rolls everything
 * back and names itself (`ops[1] update_field: …`).
 */
export async function applyAgentSchema(
  table: string,
  input: AgentSchemaInput,
  caller: AgentSchemaCaller = {}
): Promise<{ created: boolean; table: AgentTableSummary }> {
  const key = tableKey(table);
  const { fields, ops } = parseSchema(input);
  const creating = fields !== undefined;
  const restoring = ops[0]?.op === 'restore_table';
  const existing = restoring
    ? ((await findTable(key)) ?? (await findArchivedTable(key)))
    : await findTable(key);
  if (creating) {
    if (existing) throw await nameTakenConflict(existing);
    if (isCatalogId(key))
      throw tableBadRequest('Name the new table; a table id cannot create one.');
  } else customOnly(existing, key, restoring);

  const tableId = existing?.id ?? generateId('table');
  const renames = ops.flatMap((op) => (op.op === 'rename_table' ? [op.name.trim()] : []));
  const refs = await resolveRefs(fields ?? [], ops, {
    id: tableId,
    names: [existing?.name ?? key, ...renames],
  });
  const calendars = await resolveCalendars(fields ?? [], ops);
  // Updating a relation field checks its current target, so that is locked
  // too, as are the tables whose relation fields a delete_table removes.
  const currentTargets = existing
    ? (await TableFields.listFields(tableId)).map((field) => field.referenceTableId)
    : [];
  const linkedOwners = ops.some((op) => op.op === 'delete_table')
    ? (await linkedFields(tableId, getDb())).map((field) => field.tableId)
    : [];
  const projectId = creating ? await startingProject(ops, caller.threadId) : null;
  const history = historyContext();

  let outcome: { summary: AgentTableSummary; row: TableCatalogRow; run: SchemaRun };
  try {
    outcome = await transaction(async (tx) => {
      const journal = newJournal();
      if (creating) await createTableInTx(tableId, key, projectId, tx, journal);
      const tables = await TableFields.lockTables(
        [
          tableId,
          ...[...refs.values()].map((target) => target.referenceTableId),
          ...currentTargets,
          ...linkedOwners,
        ],
        tx
      );
      const locked = tables.get(tableId);
      if (!locked) throw new Error('The table is not locked');
      if (!creating && locked.state === 'active') assertStillNamed(locked, key);
      const run: SchemaRun = {
        tableId,
        tables,
        refs,
        tx,
        journal,
        fieldsChanged: false,
        renamed: false,
        projectChanged: false,
        lifecycle: null,
        unlinkedTables: new Set(),
        calendars,
        bindings: new Set(),
      };
      for (const [index, field] of (fields ?? []).entries())
        await labeledStep(`fields[${index}] ${field.name}`, () => addField(run, field));
      for (const [index, op] of ops.entries())
        await labeledStep(`ops[${index}] ${op.op}`, () => applyOp(run, op));
      const row = run.tables.get(tableId) ?? locked;
      await recordStep(
        tx,
        history.actor,
        journal,
        schemaStepSummary(row, existing?.name ?? key, creating, ops)
      );
      return { summary: await describeRow(row, tx), row, run };
    });
  } catch (error) {
    const mapped = mapFieldDatabaseError(error);
    if (creating && mapped instanceof AppError && mapped.statusCode === HTTP_STATUS.CONFLICT) {
      // Lost a race for the name: report the table that won it.
      const winner = await TableCatalog.findByName(key);
      if (winner && winner.id !== tableId) throw await nameTakenConflict(winner);
    }
    throw mapped;
  }

  const entry = toTableCatalogEntry(outcome.row);
  const { run } = outcome;
  if (creating && run.lifecycle !== 'archived' && run.lifecycle !== 'deleted')
    emitTableCreated(entry);
  else if (run.lifecycle === 'restored') emitTableRestored(entry);
  else if ((run.renamed || run.projectChanged) && !run.lifecycle) emitTableUpdated(entry);
  if (run.lifecycle === 'archived' || run.lifecycle === 'deleted')
    emitTableRemoved(tableId, run.lifecycle);
  else if (run.fieldsChanged && run.lifecycle !== 'restored') emitTableFieldsChanged(tableId);
  for (const other of run.unlinkedTables) emitTableFieldsChanged(other);
  for (const calendarId of run.bindings) emitCalendarChanged({ kind: 'binding', calendarId });
  if (run.journal.ops.length) await afterTableWrite(history.actor);
  return { created: creating, table: outcome.summary };
}

/**
 * The history label for one table_schema call: its only journaled op, or a
 * count of them. A project link is placement, not content — it is never in
 * the journal — so it neither counts nor names the step.
 */
function schemaStepSummary(
  row: TableCatalogRow,
  originalName: string,
  creating: boolean,
  ops: readonly AgentSchemaOp[]
): ReturnType<(typeof stepLabels)[keyof typeof stepLabels]> {
  if (creating) return stepLabels.tableCreate(row.name);
  const journaled = ops.filter(
    (op): op is Exclude<AgentSchemaOp, { op: 'set_project' }> => op.op !== 'set_project'
  );
  const [only] = journaled;
  if (journaled.length === 1 && only) {
    switch (only.op) {
      case 'archive_table':
        return stepLabels.tableArchive(row.name);
      case 'delete_table':
        return stepLabels.tableDelete(row.name);
      case 'restore_table':
        return stepLabels.tableRestore(row.name);
      case 'archive_field':
        return stepLabels.fieldArchive(row.name, only.name);
      case 'delete_field':
        return stepLabels.fieldDelete(row.name, only.name);
      case 'restore_field':
        return stepLabels.fieldRestore(row.name, only.as ?? only.name);
      case 'set_title_field':
        return stepLabels.fieldTitle(row.name, only.name);
      case 'add_field':
        return stepLabels.fieldCreate(row.name, only.field.name);
      case 'update_field':
        return stepLabels.fieldUpdate(row.name, only.set.name ?? only.name);
      case 'reorder_fields':
        return stepLabels.fieldReorder(row.name);
      case 'rename_table':
        return stepLabels.tableRename(originalName, only.name);
    }
  }
  return stepLabels.tableSchema(row.name, journaled.length);
}

// --- delete ------------------------------------------------------------------

/**
 * Delete entries through the bulk delete. Links from other entries are a 409
 * whose `details.references` is `[{ tableName, fieldName, count }]`; repeat
 * with `clearLinks` to clear them in the same transaction.
 */
/** A delete result whose cleared links also carry the names agents address. */
export type AgentDeleteResult = Omit<DeleteTableEntriesResponse, 'clearedReferences'> & {
  clearedReferences: (DeleteTableEntriesResponse['clearedReferences'][number] & {
    tableName?: string;
    fieldName?: string;
  })[];
};

export async function deleteAgentEntries(
  table: string,
  input: { ids: string[]; clearLinks: boolean }
): Promise<AgentDeleteResult> {
  const row = await resolveCustomTable(table);
  if (!isRecord(input)) throw tableBadRequest('Give the ids to delete.');
  try {
    const result = await deleteTableEntries(row.id, {
      entryIds: input.ids,
      clearReferences: input.clearLinks,
    });
    if (!result.clearedReferences.length) return result;
    const tableIds = [...new Set(result.clearedReferences.map((ref) => ref.tableId))];
    const names = new Map<string, { tableName?: string; fields: Map<string, string> }>();
    for (const tableId of tableIds) {
      const [catalog, fields] = await Promise.all([
        TableCatalog.findById(tableId),
        TableFields.listFields(tableId),
      ]);
      names.set(tableId, {
        tableName: catalog?.name,
        fields: new Map(fields.map((field) => [field.id, field.name])),
      });
    }
    return {
      ...result,
      clearedReferences: result.clearedReferences.map((ref) => ({
        ...ref,
        tableName: names.get(ref.tableId)?.tableName,
        fieldName: names.get(ref.tableId)?.fields.get(ref.fieldId),
      })),
    };
  } catch (error) {
    if (
      error instanceof AppError &&
      error.statusCode === HTTP_STATUS.CONFLICT &&
      isRecord(error.details) &&
      Array.isArray(error.details.references)
    )
      throw new AppError(
        getErrorMessage(error),
        error.code,
        error.statusCode,
        error.isOperational,
        {
          references: error.details.references.filter(isRecord).map((reference) => ({
            tableName: reference.tableName,
            fieldName: reference.fieldName,
            count: reference.count,
          })),
        }
      );
    throw error;
  }
}
