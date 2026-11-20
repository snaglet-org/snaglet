import { transaction, type DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import {
  ErrorCode,
  TABLE_CATALOG_ID_PATTERN,
  TABLE_ENTRY_CREATE_MAX,
  TABLE_ENTRY_DEFAULT_PAGE_SIZE,
  TABLE_ENTRY_DELETE_MAX,
  TABLE_ENTRY_ID_PATTERN,
  TABLE_ENTRY_MAX_PAGE_SIZE,
  TABLE_ENTRY_RESOLVE_MAX,
  TABLE_ENTRY_SEARCH_DEFAULT_LIMIT,
  TABLE_ENTRY_SEARCH_MAX_EXCLUDE,
  TABLE_ENTRY_SEARCH_MAX_LIMIT,
  TABLE_ENTRY_SEARCH_MAX_OFFSET,
  TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH,
  type CreateTableEntriesRequest,
  type CreateTableEntriesResponse,
  type CreateTableEntryRequest,
  type DeleteTableEntriesRequest,
  type DeleteTableEntriesResponse,
  type RelatedTableEntries,
  type RelatedTableItems,
  type ResolveTableEntriesResponse,
  type TableEntriesQuery,
  type TableEntriesResponse,
  type TableEntry,
  type TableEntryRef,
  type TableEntryReferenceCount,
  type TableEntryResponse,
  type TableEntrySearchQuery,
  type TableEntrySearchResponse,
  type TableEntryValue,
  type TableEntryValues,
  type TableField,
  type TableReferenceKind,
  type UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import {
  AppError,
  parseTableDateRange,
  tableDateRangeToCanonical,
  tableDateTimeToUtc,
  tableEntryValueProblem,
  tableReferenceKindName,
  unwrapTableReferenceChip,
  userTimeZone,
} from '@snaglet/shared/utils';
import {
  ENTRY_POSITION_COLUMN,
  TableCatalog,
  toTableCatalogEntry,
  type TableCatalogRow,
} from '@snaglet/db/tables/table_catalog';
import { TableReferences } from '@snaglet/db/tables/table_references';
import {
  columnType,
  isRange,
  physicalTable,
  rangeLiteral,
  rangeWireText,
  utcInstantText,
  zoneLiteral,
} from '../table_fields/fieldSchema';
import { assertEntryReferences, type EntryReferences } from './entryReferences';
import {
  assertEntrySchemaVersion,
  entryBadRequest,
  entryConflict,
  hashEntryVersion,
  lockEntrySchema,
  mapEntryDatabaseError,
  type EntrySchema,
} from './entrySchema';
import { readEntryNames } from './entryNames';
import {
  filteredRank,
  likeLiteral,
  parseEntryFilter,
  readFilteredPage,
  withWhere,
} from './entryFilter';
import { entrySortOrder, parseEntrySort } from './entrySort';
import { parseEntryWhere } from './entryWhere';
import {
  changedCells,
  columnTypes,
  entriesOp,
  hiddenSingleLinksTo,
  readRows,
  trackedColumns,
  type TrackedColumn,
} from '../table_history/rows';
import { newJournal, recordStep, stepLabels } from '../table_history/record';
import type {
  HistoryContext,
  HistoryJournal,
  HistoryStepSummary,
  OccurrenceTag,
} from '../table_history/types';
import {
  cleanupOps,
  dayOffset,
  deleteOccurrences,
  instantToWall,
  isFinished,
  logOccurrence,
  msToWall,
  nowWall,
  listCurrentOccurrenceLogs,
  listRepeatsForFields,
  readEntryRepeats,
  readMoves,
  readOccurrenceLog,
  readOccurrences,
  readRepeat,
  sameRepeat,
  shiftRuleByDays,
  takeEntryRepeats,
  wallKindOf,
  wallMs,
  writeRepeat,
  type OccurrenceLogRow,
} from './repeats';
import type { RepeatOp } from '../table_history/types';
import { occurrenceChanges, type OccurrenceChange } from './occurrenceChanges';
import {
  advanceTableRepeat,
  createTableRepeat,
  isTableRepeatUpcoming,
  jumpTableRepeatToUpcoming,
  nextRepeatOccurrence,
  skipTableRepeatToUpcoming,
  tableRepeatProblem,
  tableRepeatWriteProblem,
  type TableRepeat,
} from '@snaglet/shared/utils';

export interface RawEntry {
  entry_id: string | null;
  entry_created_at: string;
  [key: string]: unknown;
}

function validateId(id: string): void {
  if (typeof id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(id))
    throw entryBadRequest('Entry id must be a UUID.');
}

/**
 * `values` validated, in their stored form: a datetime becomes the UTC instant
 * it names, read in the user's time zone when it has no offset; a range
 * becomes its canonical wire form (UTC instants, no slash for a single value).
 */
function validateValues(schema: EntrySchema, values: TableEntryValues): TableEntryValues {
  if (typeof values !== 'object' || values === null || Array.isArray(values))
    throw entryBadRequest('values must be an object keyed by field id.');
  const stored: TableEntryValues = {};
  const zone = userTimeZone();
  for (const [id, value] of Object.entries(values)) {
    const field = schema.fields.find((candidate) => candidate.id === id);
    if (!field) throw entryBadRequest(`Unknown field: ${id}`);
    const problem = tableEntryValueProblem(field, value, zone);
    if (problem) throw entryBadRequest(problem);
    let canonical = value;
    if (isRange(field) && typeof value === 'string') {
      canonical = tableDateRangeToCanonical(value, field.type, zone);
      if (canonical === null) throw entryBadRequest(`${field.name}: enter a valid range.`);
    } else if (field.type === 'datetime' && typeof value === 'string') {
      canonical = tableDateTimeToUtc(value, zone);
      if (canonical === null)
        throw entryBadRequest(`${field.name}: enter a date and time within the years 1 to 9999.`);
    }
    Object.defineProperty(stored, id, {
      value: canonical,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return stored;
}

/**
 * The value a write binds, cast to the column type: a multiple relation
 * stores null as the empty list, and a range (in canonical form) its range
 * literal, so an empty cell stays null rather than an unbounded range.
 */
function bindValue(field: TableField, value: TableEntryValue | undefined): unknown {
  if (isRange(field) && typeof value === 'string') {
    const parsed = parseTableDateRange(value, field.type, userTimeZone());
    if (!parsed.ok) throw entryBadRequest(`${field.name}: ${parsed.problem}`);
    return rangeLiteral(parsed.range, field.type);
  }
  return field.multiple && value === null ? [] : value;
}

const MISSING_RELATED_ENTRY = 'The related entry does not exist in the selected table.';

/**
 * Lock every entry the written multiple relations link to FOR KEY SHARE, as a
 * foreign key check would. A delete locks its entries FOR UPDATE before
 * counting links to them, so either it waits for this write and sees its
 * links, or this write waits for the delete and finds the entry gone (400).
 * Runs after the write, so an entry may link to itself.
 */
async function lockLinks(
  schema: EntrySchema,
  values: TableEntryValues,
  tx: DbQueryable
): Promise<void> {
  for (const field of schema.fields) {
    const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    if (!field.multiple || !field.referenceTableId || !Array.isArray(value) || !value.length)
      continue;
    const ids = [...new Set(value.map((id) => id.toLowerCase()))];
    const target =
      field.referenceTableId === schema.table.id
        ? schema.table
        : await TableCatalog.findById(field.referenceTableId, tx);
    if (!target) throw entryBadRequest(MISSING_RELATED_ENTRY);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id::text AS id FROM ONLY ${physicalTable(target)} WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE`,
      [ids]
    );
    if (rows.length !== ids.length) throw entryBadRequest(MISSING_RELATED_ENTRY);
  }
}

/** The Snaglet item kind a field links to, or null. */
function itemKind(field: TableField): TableReferenceKind | null {
  return field.type === 'relation' ? (field.referenceKind ?? null) : null;
}

/** The ids a relation value holds: none, one, or a list. */
function linkIds(value: TableEntryValue | undefined): string[] {
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
}

/**
 * Check the Snaglet items each written item relation adds (compared with
 * `current`, the entry as it was; null for a new entry): each must exist, be
 * of the field's kind and be live (400 otherwise), and is locked FOR KEY
 * SHARE until commit. Links kept from before are not re-checked, so items
 * archived or purged since stay linked through edits and reorders.
 */
async function assertItemLinks(
  schema: EntrySchema,
  values: TableEntryValues,
  current: TableEntry | null,
  tx: DbQueryable
): Promise<void> {
  for (const field of schema.fields) {
    const kind = itemKind(field);
    if (!kind || !Object.hasOwn(values, field.id)) continue;
    const kept = new Set(current ? linkIds(current.values[field.id]) : []);
    const added = linkIds(values[field.id]).filter((id) => !kept.has(id));
    await TableReferences.assertLinkable(kind, added, field.name, tx);
  }
}

/**
 * Agent-friendly item values, in place of ids: a value that is exactly one
 * chip (`[Title](doc-…)`) becomes its id, and one that is no item id of the
 * field's kind but is the exact title (ignoring case) of one live item
 * becomes that item's id. Two or more live items with the title are a 400.
 * Anything else is left for validation.
 */
async function resolveItemNames(
  schema: EntrySchema,
  values: TableEntryValues,
  tx: DbQueryable
): Promise<TableEntryValues> {
  const resolved: TableEntryValues = { ...values };
  for (const field of schema.fields) {
    const kind = itemKind(field);
    const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
    if (!kind || !list?.every((item): item is string => typeof item === 'string')) continue;
    const given = list.map(unwrapTableReferenceChip);
    const known = await TableReferences.existingItems(kind, given, tx);
    const ids: string[] = [];
    for (const item of given) {
      if (known.has(item) || !item.trim()) {
        ids.push(item);
        continue;
      }
      const matches = await TableReferences.findByTitle(kind, item, 5, tx);
      if (matches.length > 1)
        throw entryBadRequest(
          `${field.name}: ${matches.length === 5 ? 'several' : matches.length} ${tableReferenceKindName(kind, true)} are titled "${item.trim()}"; give an id (${matches.map((match) => match.id).join(', ')}).`
        );
      ids.push(matches[0]?.id ?? item);
    }
    Object.defineProperty(resolved, field.id, {
      value: Array.isArray(value) ? ids : ids[0],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return resolved;
}

/**
 * The entry API's column list. Exported (with {@link toEntry}) so other row
 * readers, such as the calendar's occurrence reads, produce the same values
 * and revisions as GET /entries; a copy would drift and every write would 409.
 */
export function projection(schema: EntrySchema): string {
  return [
    'id::text AS entry_id',
    `${utcInstantText('created_at')} AS entry_created_at`,
    ...schema.fields.map((field, index) => {
      const column = quoteIdentifier(field.columnName);
      const value = isRange(field)
        ? rangeWireText(column, field.type)
        : field.type === 'checkbox'
          ? column
          : field.type === 'datetime'
            ? utcInstantText(column)
            : field.multiple
              ? `to_json(${column})`
              : `${column}::text`;
      return `${value} AS entry_value_${index}`;
    }),
  ].join(', ');
}

export function toEntry(schema: EntrySchema, raw: RawEntry): TableEntry {
  if (!raw.entry_id) throw new Error('Entry query returned no id');
  const values: TableEntryValues = {};
  for (const [index, field] of schema.fields.entries()) {
    const value = raw[`entry_value_${index}`];
    if (field.multiple) {
      if (!Array.isArray(value) || !value.every((id): id is string => typeof id === 'string'))
        throw new Error('Entry query returned an unsupported value');
      values[field.id] = value;
      continue;
    }
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean')
      throw new Error('Entry query returned an unsupported value');
    values[field.id] = value;
  }
  return {
    id: raw.entry_id,
    createdAt: raw.entry_created_at,
    values,
    // A revision is the row's data, not its physical write stamp: moving a row
    // (its `position`) or reordering columns never conflicts with a value edit.
    revision: hashEntryVersion([
      schema.schemaVersion,
      raw.entry_id,
      raw.entry_created_at,
      Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]),
  };
}

/** Room left above the first entry when inserting at the top, and the rebalance stride. */
const POSITION_GAP = 1_048_576;
const POSITION = quoteIdentifier(ENTRY_POSITION_COLUMN);

interface Neighbors {
  prev: number | null;
  next: number;
}

/** `position` of `beforeId` and of the entry sorted just ahead of it, ignoring `newId`. */
async function neighbors(
  schema: EntrySchema,
  newId: string,
  beforeId: string,
  tx: DbQueryable
): Promise<Neighbors | null> {
  const table = physicalTable(schema.table);
  const { rows } = await tx.query<{ next: number; prev: number | null }>(
    `SELECT target.${POSITION} AS next,
            (SELECT entry.${POSITION} FROM ONLY ${table} AS entry
              WHERE entry.id <> $1::uuid
                AND (entry.${POSITION}, entry.created_at, entry.id) < (target.${POSITION}, target.created_at, target.id)
              ORDER BY entry.${POSITION} DESC, entry.created_at DESC, entry.id DESC LIMIT 1) AS prev
       FROM ONLY ${table} AS target WHERE target.id = $2::uuid`,
    [newId, beforeId]
  );
  const row = rows[0];
  if (!row) return null;
  return { next: Number(row.next), prev: row.prev === null ? null : Number(row.prev) };
}

function between({ prev, next }: Neighbors): number | null {
  const key = prev === null ? next - POSITION_GAP : (prev + next) / 2;
  return (prev === null || prev < key) && key < next ? key : null;
}

/**
 * Serializes writes that depend on the table's row order: placement and
 * deletion. Take it before any row lock, including the KEY SHARE locks an
 * INSERT's relation checks take on its targets, so every writer locks in the
 * same order and a placed create cannot deadlock with a delete of its target.
 */
async function lockEntryOrder(tableId: string, tx: DbQueryable): Promise<void> {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('snaglet.table_entry_order:' || $1, 0))",
    [tableId]
  );
}

/**
 * Move the just-inserted entry to sit before `beforeId`. When the gap has run
 * out of float precision, every other entry is renumbered at POSITION_GAP
 * strides (far below epoch-ms keys, so later appends still land last) and the
 * gap is recomputed. The caller holds the order lock from before its INSERT.
 */
async function placeBefore(
  schema: EntrySchema,
  newId: string,
  beforeId: string,
  tx: DbQueryable
): Promise<void> {
  const table = physicalTable(schema.table);
  let gap = await neighbors(schema, newId, beforeId, tx);
  if (!gap) throw entryBadRequest('The entry to insert before no longer exists.');
  let key = between(gap);
  if (key === null) {
    await tx.query(
      `UPDATE ONLY ${table} AS entry SET ${POSITION} = ranked.rank * ${POSITION_GAP}
         FROM (SELECT id, row_number() OVER (ORDER BY ${POSITION}, created_at, id) AS rank
                 FROM ONLY ${table} WHERE id <> $1::uuid) AS ranked
        WHERE entry.id = ranked.id`,
      [newId]
    );
    gap = await neighbors(schema, newId, beforeId, tx);
    key = gap && between(gap);
    if (key === null || key === undefined) throw new Error('Could not place the new entry');
  }
  await tx.query(`UPDATE ONLY ${table} SET ${POSITION} = $2 WHERE id = $1::uuid`, [newId, key]);
}

/**
 * The id of the entry right after `afterId` in row order, skipping `skipIds`
 * (a batch's own rows, already placed on a replay); null when `afterId` is
 * the last. 400 when `afterId` is gone. The caller holds the order lock.
 */
async function entryFollowing(
  schema: EntrySchema,
  afterId: string,
  skipIds: readonly string[],
  tx: DbQueryable
): Promise<string | null> {
  const table = physicalTable(schema.table);
  const { rows } = await tx.query<{ found: boolean; next: string | null }>(
    `SELECT EXISTS (SELECT 1 FROM ONLY ${table} WHERE id = $1::uuid) AS found,
            (SELECT entry.id FROM ONLY ${table} AS entry, ONLY ${table} AS anchor
              WHERE anchor.id = $1::uuid AND entry.id <> ALL($2::uuid[])
                AND (entry.${POSITION}, entry.created_at, entry.id) > (anchor.${POSITION}, anchor.created_at, anchor.id)
              ORDER BY entry.${POSITION}, entry.created_at, entry.id LIMIT 1) AS next`,
    [afterId, skipIds]
  );
  const row = rows[0];
  if (!row?.found) throw entryBadRequest('The entry to insert after no longer exists.');
  return row.next;
}

async function readEntry(
  schema: EntrySchema,
  id: string,
  tx: DbQueryable,
  lock = false
): Promise<TableEntry | null> {
  const { rows } = await tx.query<RawEntry>(
    `SELECT ${projection(schema)} FROM ONLY ${physicalTable(schema.table)} WHERE id=$1::uuid${lock ? ' FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] ? toEntry(schema, rows[0]) : null;
}

async function valuesMatch(
  schema: EntrySchema,
  id: string,
  values: TableEntryValues,
  tx: DbQueryable
): Promise<boolean> {
  const params: unknown[] = [id];
  const predicates = schema.fields
    .filter((field) => Object.hasOwn(values, field.id))
    .map((field) => {
      params.push(bindValue(field, values[field.id]));
      return `${quoteIdentifier(field.columnName)} IS NOT DISTINCT FROM $${params.length}::${columnType(field)}`;
    });
  const result = await tx.query<{ matches: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ONLY ${physicalTable(schema.table)} WHERE id=$1::uuid${predicates.length ? ` AND ${predicates.join(' AND ')}` : ''}) AS matches`,
    params
  );
  return result.rows[0]?.matches ?? false;
}

async function withSchema<T>(
  tableId: string,
  operation: (schema: EntrySchema, tx: DbQueryable) => Promise<T>,
  writing = false
): Promise<T> {
  try {
    return await transaction(async (tx) =>
      operation(await lockEntrySchema(tableId, tx, writing), tx)
    );
  } catch (error) {
    throw mapEntryDatabaseError(error);
  }
}

/**
 * A write under the schema lock that, given `history`, records its journal
 * as one step in the same transaction. `summary` names the step once the
 * result is known; an empty journal (nothing changed) records nothing.
 */
async function withRecordedSchema<T>(
  tableId: string,
  history: HistoryContext | undefined,
  operation: (
    schema: EntrySchema,
    tx: DbQueryable,
    journal: HistoryJournal | undefined
  ) => Promise<T>,
  summary: (schema: EntrySchema, result: T) => HistoryStepSummary
): Promise<T> {
  return withSchema(
    tableId,
    async (schema, tx) => {
      const journal = history ? newJournal() : undefined;
      const result = await operation(schema, tx, journal);
      if (history && journal) await recordStep(tx, history.actor, journal, summary(schema, result));
      return result;
    },
    true
  );
}

/** Snapshot columns of the schema's table, read once per write. */
async function snapshotColumns(schema: EntrySchema, tx: DbQueryable): Promise<TrackedColumn[]> {
  return trackedColumns(schema.table, tx);
}

/** Record a just-inserted row: undo deletes it, redo puts it back exactly. */
async function journalInsert(
  schema: EntrySchema,
  id: string,
  journal: HistoryJournal,
  tx: DbQueryable
): Promise<void> {
  const columns = await snapshotColumns(schema, tx);
  const after = (await readRows(schema.table, columns, [id], tx)).get(id.toLowerCase());
  if (!after) throw new Error('Inserted entry is missing');
  entriesOp(journal, schema.table.id, columnTypes(columns)).rows.push({
    tableId: schema.table.id,
    id: id.toLowerCase(),
    before: null,
    after,
  });
}

/** A batch create's rows: 1 to TABLE_ENTRY_CREATE_MAX, ids valid and distinct. */
function parseEntryCreates(
  input: CreateTableEntriesRequest
): Array<{ id: string; values: TableEntryValues }> {
  const entries: unknown = input.entries;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > TABLE_ENTRY_CREATE_MAX)
    throw entryBadRequest(`entries must list 1 to ${TABLE_ENTRY_CREATE_MAX} new entries.`);
  const seen = new Set<string>();
  return entries.map((row: unknown, index) => {
    const bad = (message: string) => labelError(`entries[${index}]`, entryBadRequest(message));
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      throw bad('Each entry must be { id, values }.');
    const { id, values } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(id))
      throw bad('Entry id must be a UUID.');
    const key = id.toLowerCase();
    if (seen.has(key)) throw bad('Entry ids must not repeat.');
    seen.add(key);
    // validateValues checks the values themselves on insert.
    return { id, values: values as TableEntryValues };
  });
}

const ENTRY_REVISION_PATTERN = /^[a-f0-9]{64}$/;

interface Deletion {
  /** Lowercase, in request order. */
  ids: string[];
  revisions: Map<string, string>;
  clearReferences: boolean;
}

function parseDeletion(input: DeleteTableEntriesRequest): Deletion {
  const { entryIds, expectedRevisions, clearReferences } = input;
  if (!Array.isArray(entryIds) || entryIds.length < 1 || entryIds.length > TABLE_ENTRY_DELETE_MAX)
    throw entryBadRequest(`entryIds must list 1 to ${TABLE_ENTRY_DELETE_MAX} entry UUIDs.`);
  for (const id of entryIds) validateId(id);
  const ids = entryIds.map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw entryBadRequest('entryIds must not repeat an entry.');
  const badRevisions = entryBadRequest(
    'expectedRevisions must map entry ids to entry revisions returned by the server.'
  );
  if (
    expectedRevisions !== undefined &&
    (typeof expectedRevisions !== 'object' ||
      expectedRevisions === null ||
      Array.isArray(expectedRevisions))
  )
    throw badRevisions;
  const revisions = new Map<string, string>();
  for (const [id, revision] of Object.entries(expectedRevisions ?? {})) {
    if (typeof revision !== 'string' || !ENTRY_REVISION_PATTERN.test(revision)) throw badRevisions;
    revisions.set(id.toLowerCase(), revision);
  }
  if (clearReferences !== undefined && typeof clearReferences !== 'boolean')
    throw entryBadRequest('clearReferences must be a boolean.');
  return { ids, revisions, clearReferences: clearReferences === true };
}

interface IncomingReference extends TableEntryReferenceCount {
  table: TableCatalogRow;
  columnName: string;
  multiple: boolean;
}

/**
 * Per relation field targeting this table, the links to `ids` from entries
 * that are not themselves in `ids`: one per row for a single relation, one per
 * matching element for a multiple one. Runs after `ids` are locked FOR UPDATE:
 * a new link takes a KEY SHARE lock on its target (the foreign key for a single
 * relation, `lockLinks` for a list), so none can appear before the delete
 * commits, and a link made before the lock is committed and counted here.
 */
async function incomingReferences(
  schema: EntrySchema,
  ids: string[],
  tx: DbQueryable
): Promise<IncomingReference[]> {
  const { rows: fields } = await tx.query<{
    field_id: string;
    field_name: string;
    column_name: string;
    multiple: boolean;
    table_id: string;
    table_name: string;
  }>(
    `SELECT field.id AS field_id, field.name AS field_name, field.column_name, field.multiple,
            catalog.id AS table_id, catalog.name AS table_name
       FROM public.table_fields AS field
       JOIN public.table_catalog AS catalog ON catalog.id = field.table_id
      WHERE field.type = 'relation' AND field.reference_table_id = $1 AND catalog.origin = 'custom'
        AND field.state = 'active' AND catalog.state = 'active'
      ORDER BY catalog.id, field.position, field.id`,
    [schema.table.id]
  );
  const tables = new Map<string, TableCatalogRow>([[schema.table.id, schema.table]]);
  const references: IncomingReference[] = [];
  for (const field of fields) {
    const table = tables.get(field.table_id) ?? (await TableCatalog.findById(field.table_id, tx));
    if (!table) continue;
    tables.set(table.id, table);
    const column = quoteIdentifier(field.column_name);
    const { rows } = await tx.query<{ count: number }>(
      field.multiple
        ? `SELECT count(*)::int AS count
             FROM ONLY ${physicalTable(table)} AS entry CROSS JOIN LATERAL unnest(entry.${column}) AS link(id)
            WHERE entry.${column} && $1::uuid[] AND link.id = ANY($1::uuid[]) AND entry.id <> ALL($2::uuid[])`
        : `SELECT count(*)::int AS count FROM ONLY ${physicalTable(table)}
            WHERE ${column} = ANY($1::uuid[]) AND id <> ALL($2::uuid[])`,
      [ids, table.id === schema.table.id ? ids : []]
    );
    const count = rows[0]?.count ?? 0;
    if (count > 0)
      references.push({
        tableId: table.id,
        tableName: field.table_name,
        fieldId: field.field_id,
        fieldName: field.field_name,
        count,
        table,
        columnName: field.column_name,
        multiple: field.multiple,
      });
  }
  return references;
}

/**
 * Clear one field's links to `ids` in entries that are not themselves in
 * `ids`. A list keeps its surviving links in order. Returns each changed
 * entry with how many links it lost.
 */
async function clearLinks(
  reference: IncomingReference,
  ids: string[],
  excluded: string[],
  tx: DbQueryable
): Promise<Array<{ id: string; removed: number; before: string; after: string | null }>> {
  const table = physicalTable(reference.table);
  const column = quoteIdentifier(reference.columnName);
  if (!reference.multiple) {
    const { rows } = await tx.query<{ id: string; before: string }>(
      `WITH changed AS (
         SELECT id, ${column}::text AS before FROM ONLY ${table}
          WHERE ${column} = ANY($1::uuid[]) AND id <> ALL($2::uuid[]) FOR UPDATE)
       UPDATE ONLY ${table} AS entry SET ${column} = NULL FROM changed
        WHERE entry.id = changed.id RETURNING entry.id::text AS id, changed.before`,
      [ids, excluded]
    );
    return rows.map((row) => ({ id: row.id, removed: 1, before: row.before, after: null }));
  }
  const { rows } = await tx.query<{ id: string; removed: number; before: string; after: string }>(
    `WITH changed AS (
       SELECT entry.id, entry.${column}::text AS before,
              (SELECT count(*)::int FROM unnest(entry.${column}) AS link(id) WHERE link.id = ANY($1::uuid[])) AS removed
         FROM ONLY ${table} AS entry
        WHERE entry.${column} && $1::uuid[] AND entry.id <> ALL($2::uuid[])
          FOR UPDATE)
     UPDATE ONLY ${table} AS entry
        SET ${column} = COALESCE(
              (SELECT array_agg(link.id ORDER BY link.ordinality)
                 FROM unnest(entry.${column}) WITH ORDINALITY AS link(id, ordinality)
                WHERE link.id <> ALL($1::uuid[])),
              '{}'::uuid[])
       FROM changed
      WHERE entry.id = changed.id
     RETURNING entry.id::text AS id, changed.removed, changed.before, entry.${column}::text AS after`,
    [ids, excluded]
  );
  return rows;
}

interface DeleteTableEntriesResult extends DeleteTableEntriesResponse {
  /** Entries of other tables whose links were cleared, for their realtime reloads. */
  unlinkedEntries: { tableId: string; entryIds: string[] }[];
}

/** Names of the entries `entries`' relation values point at, one query per target table. */
async function relatedEntries(
  schema: EntrySchema,
  entries: readonly TableEntry[],
  tx: DbQueryable
): Promise<RelatedTableEntries> {
  const idsByTable = new Map<string, Set<string>>();
  for (const field of schema.fields) {
    if (field.type !== 'relation' || !field.referenceTableId) continue;
    for (const entry of entries) {
      const value = entry.values[field.id];
      const links = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
      if (!links.length) continue;
      const ids = idsByTable.get(field.referenceTableId) ?? new Set<string>();
      for (const link of links) ids.add(link.toLowerCase());
      idsByTable.set(field.referenceTableId, ids);
    }
  }
  const named = await readEntryNames(
    new Map([...idsByTable].map(([targetId, ids]) => [targetId, [...ids]])),
    tx
  );
  const related: RelatedTableEntries = {};
  for (const [targetId, { names }] of named) {
    if (names.size)
      related[targetId] = Object.fromEntries([...names].map(([id, name]) => [id, { name }]));
  }
  return related;
}

/**
 * Titles of the Snaglet items `entries`' item relations point at, one query per
 * kind. Archived items are flagged; purged ones are absent (unavailable).
 */
async function relatedItems(
  schema: EntrySchema,
  entries: readonly TableEntry[],
  tx: DbQueryable
): Promise<RelatedTableItems> {
  const idsByKind = new Map<TableReferenceKind, string[]>();
  for (const field of schema.fields) {
    const kind = itemKind(field);
    if (!kind) continue;
    const ids = idsByKind.get(kind) ?? [];
    for (const entry of entries) ids.push(...linkIds(entry.values[field.id]));
    idsByKind.set(kind, ids);
  }
  return TableReferences.readItems(idsByKind, tx);
}

async function entryResponse(
  schema: EntrySchema,
  entry: TableEntry,
  tx: DbQueryable
): Promise<TableEntryResponse> {
  return {
    entry,
    schemaVersion: schema.schemaVersion,
    relatedEntries: await relatedEntries(schema, [entry], tx),
    relatedItems: await relatedItems(schema, [entry], tx),
  };
}

const PREVIEW_VALUE_MAX = 60;
const PREVIEW_VALUE_COUNT = 2;

function previewValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > PREVIEW_VALUE_MAX ? `${text.slice(0, PREVIEW_VALUE_MAX - 1)}…` : text;
}

/** Validated, deduplicated refs in request order, entry ids lowercased. */
function parseRefs(refs: readonly TableEntryRef[]): TableEntryRef[] {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > TABLE_ENTRY_RESOLVE_MAX)
    throw entryBadRequest(`refs must list 1 to ${TABLE_ENTRY_RESOLVE_MAX} entry references.`);
  const seen = new Set<string>();
  const unique: TableEntryRef[] = [];
  for (const ref of refs) {
    if (
      typeof ref !== 'object' ||
      ref === null ||
      typeof ref.tableId !== 'string' ||
      !TABLE_CATALOG_ID_PATTERN.test(ref.tableId) ||
      typeof ref.entryId !== 'string' ||
      !TABLE_ENTRY_ID_PATTERN.test(ref.entryId)
    )
      throw entryBadRequest('Each ref must be { tableId, entryId }: a table id and an entry UUID.');
    const entryId = ref.entryId.toLowerCase();
    const key = `${ref.tableId}/${entryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ tableId: ref.tableId, entryId });
  }
  return unique;
}

/** Details for a 409 on an insert whose id exists with other values. */
type InsertConflictDetails = (current: TableEntry | null) => Promise<Record<string, unknown>>;

/**
 * Insert one entry, or confirm an exact replay of it: an existing id whose
 * values equal the supplied ones (omitted fields compared with their
 * defaults) is `created: false`; other values are a 409.
 */
async function insertEntry(
  schema: EntrySchema,
  input: { id: string; values: TableEntryValues; beforeEntryId?: string },
  tx: DbQueryable,
  conflictDetails: InsertConflictDetails,
  journal?: HistoryJournal
): Promise<{ entry: TableEntry; created: boolean }> {
  const values = validateValues(schema, input.values);
  // Placement needs the order lock; take it before the INSERT locks any relation target.
  if (input.beforeEntryId !== undefined) await lockEntryOrder(schema.table.id, tx);
  const fields = schema.fields.filter((field) => Object.hasOwn(values, field.id));
  const params: unknown[] = [
    input.id,
    ...fields.map((field) => bindValue(field, values[field.id])),
  ];
  const result = await tx.query<RawEntry>(
    `INSERT INTO ${physicalTable(schema.table)} (id${fields.map((field) => `, ${quoteIdentifier(field.columnName)}`).join('')})
     VALUES ($1::uuid${fields.map((field, index) => `, $${index + 2}::${columnType(field)}`).join('')})
     ON CONFLICT (id) DO NOTHING RETURNING ${projection(schema)}`,
    params
  );
  const inserted = result.rows[0];
  if (inserted) {
    await lockLinks(schema, values, tx);
    await assertItemLinks(schema, values, null, tx);
    // Replays skip placement: the first attempt already committed it.
    if (input.beforeEntryId !== undefined)
      await placeBefore(schema, input.id, input.beforeEntryId, tx);
    if (journal) await journalInsert(schema, input.id, journal, tx);
    return { entry: toEntry(schema, inserted), created: true };
  }
  const entry = await readEntry(schema, input.id, tx, true);
  const expected = Object.fromEntries(
    schema.fields
      .filter((field) => !field.managed)
      .map((field) => [
        field.id,
        Object.hasOwn(values, field.id) ? values[field.id] : field.defaultValue,
      ])
  );
  if (!entry || !(await valuesMatch(schema, input.id, expected, tx)))
    throw entryConflict(
      'This entry id already exists with different values.',
      await conflictDetails(entry)
    );
  return { entry, created: false };
}

/**
 * Apply a sparse patch to an existing entry (404 when it is gone). `stale`
 * returns the 409 to throw when the locked entry fails the caller's revision
 * check. An unchanged patch writes nothing (`updated: false`).
 */
async function patchEntry(
  schema: EntrySchema,
  id: string,
  values: TableEntryValues,
  tx: DbQueryable,
  stale: (current: TableEntry) => Promise<AppError | null>,
  journal?: HistoryJournal
): Promise<{ entry: TableEntry; updated: boolean }> {
  const stored = validateValues(schema, values);
  const entry = await readEntry(schema, id, tx, true);
  if (!entry) throw new AppError('Entry not found', ErrorCode.NOT_FOUND, 404);
  const conflict = await stale(entry);
  if (conflict) throw conflict;
  if (await valuesMatch(schema, id, stored, tx)) return { entry, updated: false };
  await assertItemLinks(schema, stored, entry, tx);
  const before = journal
    ? (await readRows(schema.table, await snapshotColumns(schema, tx), [id], tx)).get(entry.id)
    : undefined;
  const fields = schema.fields.filter((field) => Object.hasOwn(stored, field.id));
  const params: unknown[] = [id, ...fields.map((field) => bindValue(field, stored[field.id]))];
  const { rows } = await tx.query<RawEntry>(
    `UPDATE ONLY ${physicalTable(schema.table)} SET ${fields.map((field, index) => `${quoteIdentifier(field.columnName)}=$${index + 2}::${columnType(field)}`).join(', ')} WHERE id=$1::uuid RETURNING ${projection(schema)}`,
    params
  );
  const updated = rows[0];
  if (!updated) throw new Error('Updated entry is missing');
  await lockLinks(schema, stored, tx);
  if (journal) {
    const columns = await snapshotColumns(schema, tx);
    const after = (await readRows(schema.table, columns, [id], tx)).get(entry.id);
    const change = before && after ? changedCells(before, after) : null;
    if (change)
      entriesOp(journal, schema.table.id, columnTypes(columns)).rows.push({
        tableId: schema.table.id,
        id: entry.id,
        ...change,
      });
  }
  return { entry: toEntry(schema, updated), updated: true };
}

/** Values keyed by field name, re-keyed by field id. */
function valuesByName(schema: EntrySchema, values: TableEntryValues): TableEntryValues {
  if (typeof values !== 'object' || values === null || Array.isArray(values))
    throw entryBadRequest('values must be an object keyed by field name.');
  const byId: TableEntryValues = {};
  for (const [name, value] of Object.entries(values)) {
    const field =
      schema.fields.find((candidate) => candidate.name === name) ??
      schema.fields.find((candidate) => candidate.name === name.toLowerCase());
    if (!field)
      throw entryBadRequest(
        `Unknown field "${name}". Fields: ${schema.fields
          .filter((candidate) => !candidate.managed)
          .map((candidate) => candidate.name)
          .join(', ')}.`
      );
    if (Object.hasOwn(byId, field.id)) throw entryBadRequest(`${field.name} is given twice.`);
    byId[field.id] = value;
  }
  return byId;
}

/** A batch row's values re-keyed by field id, item names resolved when the batch asks. */
async function namedValues(
  schema: EntrySchema,
  values: TableEntryValues,
  batch: EntryBatch,
  tx: DbQueryable
): Promise<TableEntryValues> {
  const byId = valuesByName(schema, values);
  return batch.resolveItemNames ? resolveItemNames(schema, byId, tx) : byId;
}

/** An entry with its editable values keyed by field name. */
export interface NamedTableEntry {
  id: string;
  createdAt: string;
  revision: string;
  values: TableEntryValues;
}

function namedEntry(schema: EntrySchema, entry: TableEntry): NamedTableEntry {
  const values: TableEntryValues = {};
  for (const field of schema.fields)
    if (!field.managed && Object.hasOwn(entry.values, field.id))
      values[field.name] = entry.values[field.id] ?? null;
  return { id: entry.id, createdAt: entry.createdAt, revision: entry.revision, values };
}

/** `error` with `label: ` ahead of its message when it is an API error. */
function labelError(label: string, error: unknown): Error {
  const mapped = mapEntryDatabaseError(error);
  if (!(mapped instanceof AppError)) return mapped;
  return new AppError(
    `${label}: ${mapped.message}`,
    mapped.code,
    mapped.statusCode,
    mapped.isOperational,
    mapped.details
  );
}

function labeled(label: string, check: () => void): void {
  try {
    check();
  } catch (error) {
    throw labelError(label, error);
  }
}

async function labeledAsync<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw labelError(label, error);
  }
}

export interface EntryBatchInsert {
  id: string;
  /** Keyed by field name. */
  values: TableEntryValues;
  beforeEntryId?: string;
}

export interface EntryBatchUpdate {
  id: string;
  /** Keyed by field name; a sparse patch. */
  values: TableEntryValues;
  /** Lowercase hex the current revision must start with. */
  revisionPrefix?: string;
}

export interface EntryBatch {
  inserts: readonly EntryBatchInsert[];
  updates: readonly EntryBatchUpdate[];
  /** The name the caller addressed the table by: a rename since is a 409. */
  expectedName?: string;
  /** Chip targets checked after the rows are written, before commit. */
  references?: EntryReferences;
  /**
   * Item relation values may be a chip or an item's exact title as well as
   * an id (see {@link resolveItemNames}); agents write this way.
   */
  resolveItemNames?: boolean;
}

export interface EntryBatchResult {
  inserted: TableEntry[];
  existing: TableEntry[];
  updated: TableEntry[];
  unchanged: TableEntry[];
  /**
   * Per `updated` entry, in the same order: the occurrences its done status
   * completed ({@link advanceOnDone}), for the hook event sent after commit.
   */
  occurrences: OccurrenceChange[][];
}

class TableEntriesModelClass {
  /**
   * One page in row order. With `focusEntryId`, the page holding that entry
   * (404 if it is gone); `page` is then ignored. With `q`, only matching
   * entries (plus `keep`) are paged and counted, each with its full-table
   * row number (see `entryFilter`).
   */
  async listEntries(tableId: string, query: TableEntriesQuery = {}): Promise<TableEntriesResponse> {
    const focus = query.focusEntryId;
    if (focus !== undefined) validateId(focus);
    const searched = parseEntryFilter(query.q, query.keep);
    if (searched && focus !== undefined)
      throw entryBadRequest('focusEntryId cannot be combined with q.');
    const requested = focus === undefined ? (query.page ?? 1) : 1;
    const pageSize = query.pageSize ?? TABLE_ENTRY_DEFAULT_PAGE_SIZE;
    if (
      !Number.isSafeInteger(requested) ||
      requested < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > TABLE_ENTRY_MAX_PAGE_SIZE ||
      !Number.isSafeInteger((requested - 1) * pageSize)
    )
      throw entryBadRequest('Use a positive page and a pageSize between 1 and 100.');
    return withSchema(tableId, async (schema, tx) => {
      const table = physicalTable(schema.table);
      let page = requested;
      const sort = parseEntrySort(query.sort, schema.fields);
      const where = parseEntryWhere(query.where, schema.fields);
      let filter = withWhere(searched, where, query.keep);
      if (focus !== undefined && filter) {
        // The focused entry stays listed even when it does not meet the conditions.
        filter = { ...filter, keep: [focus.toLowerCase()] };
        const before = await filteredRank(schema, filter, sort, focus, tx);
        if (before === null) throw new AppError('Entry not found', ErrorCode.NOT_FOUND, 404);
        page = Math.floor(before / pageSize) + 1;
      } else if (focus !== undefined && sort.length) {
        const params: unknown[] = [focus];
        const order = entrySortOrder(sort, schema.fields, (value) => `$${params.push(value)}`);
        const { rows: found } = await tx.query<{ before: string }>(
          `SELECT (ranked.rank - 1)::text AS before FROM (
             SELECT id, row_number() OVER (ORDER BY ${order}) AS rank FROM ONLY ${table}) ranked
           WHERE ranked.id = $1::uuid`,
          params
        );
        const target = found[0];
        if (!target) throw new AppError('Entry not found', ErrorCode.NOT_FOUND, 404);
        page = Math.floor(Number(target.before) / pageSize) + 1;
      } else if (focus !== undefined) {
        const { rows: found } = await tx.query<{ before: string }>(
          `SELECT (SELECT count(*) FROM ONLY ${table} AS entry
                    WHERE (entry.${POSITION}, entry.created_at, entry.id)
                        < (target.${POSITION}, target.created_at, target.id))::text AS before
             FROM ONLY ${table} AS target WHERE target.id = $1::uuid`,
          [focus]
        );
        const target = found[0];
        if (!target) throw new AppError('Entry not found', ErrorCode.NOT_FOUND, 404);
        page = Math.floor(Number(target.before) / pageSize) + 1;
      }
      let rows: Array<RawEntry & { total_count: string; entry_row_number?: string | null }>;
      if (filter) {
        const offset = (page - 1) * pageSize;
        rows = await readFilteredPage<RawEntry>(
          schema,
          filter,
          projection(schema),
          { limit: pageSize, offset },
          tx,
          sort
        );
      } else {
        const params: unknown[] = [pageSize, (page - 1) * pageSize];
        const order = entrySortOrder(sort, schema.fields, (value) => `$${params.push(value)}`);
        // Both subqueries share a statement snapshot, including an empty/out-of-range page.
        ({ rows } = await tx.query<RawEntry & { total_count: string }>(
          `SELECT totals.total_count, page.* FROM (SELECT count(*)::text AS total_count FROM ONLY ${table}) totals
         LEFT JOIN LATERAL (SELECT ${projection(schema)}, row_number() OVER (ORDER BY ${order}) AS entry_sort_rank
           FROM ONLY ${table}
           ORDER BY ${order} LIMIT $1 OFFSET $2) page ON true
         ORDER BY page.entry_sort_rank ASC`,
          params
        ));
      }
      const totalCount = Number(rows[0]?.total_count ?? 0);
      if (!Number.isSafeInteger(totalCount))
        throw new Error('Table entry count exceeds supported precision');
      const listed = rows.filter((row) => row.entry_id !== null);
      const entries = listed.map((row) => toEntry(schema, row));
      return {
        entries,
        fields: schema.fields,
        totalCount,
        page,
        pageSize,
        schemaVersion: schema.schemaVersion,
        relatedEntries: await relatedEntries(schema, entries, tx),
        relatedItems: await relatedItems(schema, entries, tx),
        ...(filter && {
          rowNumbers: Object.fromEntries(
            listed.map((row) => [row.entry_id, Number(row.entry_row_number)])
          ),
        }),
      };
    });
  }

  async getEntry(tableId: string, id: string): Promise<TableEntryResponse> {
    validateId(id);
    return withSchema(tableId, async (schema, tx) => {
      const entry = await readEntry(schema, id, tx);
      if (!entry) throw new AppError('Entry not found', ErrorCode.NOT_FOUND, 404);
      return entryResponse(schema, entry, tx);
    });
  }

  /**
   * Entries matching `q`, best first: Name starts with it, then Name contains
   * it, then another text field contains it (case-insensitive, literal), ties
   * in row order. An empty `q` lists the first entries in row order. Entries
   * in `exclude` are left out before paging, so a relation picker's pages hold
   * only entries it can still link; `hasMore` says whether `offset` can advance.
   */
  async searchEntries(
    tableId: string,
    query: TableEntrySearchQuery = {}
  ): Promise<TableEntrySearchResponse> {
    if (query.q !== undefined && typeof query.q !== 'string')
      throw entryBadRequest('q must be text.');
    const q = (query.q ?? '').trim();
    if (q.length > TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH)
      throw entryBadRequest(`q can be at most ${TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH} characters.`);
    const limit = query.limit ?? TABLE_ENTRY_SEARCH_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TABLE_ENTRY_SEARCH_MAX_LIMIT)
      throw entryBadRequest(`limit must be between 1 and ${TABLE_ENTRY_SEARCH_MAX_LIMIT}.`);
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > TABLE_ENTRY_SEARCH_MAX_OFFSET)
      throw entryBadRequest(`offset must be between 0 and ${TABLE_ENTRY_SEARCH_MAX_OFFSET}.`);
    const exclude = query.exclude ?? [];
    if (!Array.isArray(exclude) || exclude.length > TABLE_ENTRY_SEARCH_MAX_EXCLUDE)
      throw entryBadRequest(
        `exclude can list at most ${TABLE_ENTRY_SEARCH_MAX_EXCLUDE} entry ids.`
      );
    if (exclude.some((id) => typeof id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(id)))
      throw entryBadRequest('exclude must list entry UUIDs.');
    return withSchema(tableId, async (schema, tx) => {
      const own = schema.fields.filter((field) => !field.managed);
      const title = own.find((field) => field.isTitle);
      const others = own.filter((field) => !field.isTitle);
      const previews = others.filter(
        (field) =>
          field.type === 'text' ||
          field.type === 'number' ||
          field.type === 'date' ||
          field.type === 'datetime'
      );
      const previewText = (field: TableField): string => {
        const column = quoteIdentifier(field.columnName);
        // A datetime previews as its wall-clock time in the user's time zone.
        const wall = (instant: string) =>
          `to_char(${instant} AT TIME ZONE ${zoneLiteral()}, 'YYYY-MM-DD HH24:MI')`;
        if (isRange(field) && field.type === 'date') return rangeWireText(column, 'date');
        if (isRange(field))
          return `(${wall(`lower(${column})`)} || CASE WHEN upper(${column}) > lower(${column}) THEN '/' || ${wall(`upper(${column})`)} ELSE '' END)`;
        return field.type === 'datetime' ? wall(column) : `${column}::text`;
      };
      const name = title ? `COALESCE(${quoteIdentifier(title.columnName)}, '')` : "''";
      const params: unknown[] = [];
      const param = (value: unknown) => `$${params.push(value)}`;
      const order = [POSITION, 'created_at', 'id'];
      let match = 'true';
      const excluded = exclude.length ? `id <> ALL(${param(exclude)}::uuid[])` : 'true';
      if (q) {
        const contains = param(`%${likeLiteral(q)}%`);
        const searched = [
          ...(title ? [name] : []),
          ...others
            .filter((field) => field.type === 'text')
            .map((field) => quoteIdentifier(field.columnName)),
        ];
        match = searched.length
          ? searched.map((column) => `${column} ILIKE ${contains} ESCAPE '\\'`).join(' OR ')
          : 'false';
        if (title) {
          const prefix = param(`${likeLiteral(q)}%`);
          order.unshift(
            `CASE WHEN ${name} ILIKE ${prefix} ESCAPE '\\' THEN 0 WHEN ${name} ILIKE ${contains} ESCAPE '\\' THEN 1 ELSE 2 END`
          );
        }
      }
      const { rows } = await tx.query<Record<string, unknown> & { id: string; name: string }>(
        `SELECT id::text AS id, ${name} AS name${previews
          .map((field, index) => `, ${previewText(field)} AS preview_${index}`)
          .join('')}
           FROM ONLY ${physicalTable(schema.table)}
          WHERE (${match}) AND ${excluded}
          ORDER BY ${order.join(', ')}
          LIMIT ${param(limit + 1)} OFFSET ${param(offset)}`,
        params
      );
      return {
        hasMore: rows.length > limit,
        results: rows.slice(0, limit).map((row) => ({
          id: row.id,
          name: row.name,
          preview: previews
            .map((_, index) => previewValue(row[`preview_${index}`]))
            .filter((value): value is string => value !== null)
            .slice(0, PREVIEW_VALUE_COUNT)
            .join(' · '),
        })),
      };
    });
  }

  /**
   * Names of entries anywhere in the Database, one query per table and no
   * schema locks. Missing entries and unknown, built-in or missing tables are
   * absent rather than errors.
   */
  async resolveEntries(refs: readonly TableEntryRef[]): Promise<ResolveTableEntriesResponse> {
    const unique = parseRefs(refs);
    const idsByTable = new Map<string, string[]>();
    for (const ref of unique)
      idsByTable.set(ref.tableId, [...(idsByTable.get(ref.tableId) ?? []), ref.entryId]);
    try {
      return await transaction(async (tx) => {
        await tx.query('SET LOCAL lock_timeout = 5000');
        await tx.query('SET LOCAL statement_timeout = 15000');
        const named = await readEntryNames(idsByTable, tx);
        return {
          entries: unique.flatMap((ref) => {
            const table = named.get(ref.tableId);
            const name = table?.names.get(ref.entryId);
            return table && name !== undefined
              ? [{ ...ref, name, tableName: table.tableName }]
              : [];
          }),
        };
      });
    } catch (error) {
      throw mapEntryDatabaseError(error);
    }
  }

  /** Create an entry; with `history`, a new entry is one undoable step. */
  async createEntry(
    tableId: string,
    input: CreateTableEntryRequest,
    history?: HistoryContext
  ): Promise<TableEntryResponse & { created: boolean }> {
    validateId(input.id);
    if (input.beforeEntryId !== undefined) validateId(input.beforeEntryId);
    return withRecordedSchema(
      tableId,
      history,
      async (schema, tx, journal) => {
        assertEntrySchemaVersion(schema, input.schemaVersion);
        const { entry, created } = await insertEntry(
          schema,
          input,
          tx,
          async (current) =>
            current
              ? { ...(await entryResponse(schema, current, tx)) }
              : {
                  entry: current,
                  schemaVersion: schema.schemaVersion,
                  relatedEntries: {},
                  relatedItems: {},
                },
          journal
        );
        return { ...(await entryResponse(schema, entry, tx)), created };
      },
      (schema) => stepLabels.entryCreate(schema.table.name)
    );
  }

  /**
   * Create entries together or not at all, in request order, as one undoable
   * step (a paste in the grid). With `afterEntryId` they sit right after that
   * entry (400 when it is gone), otherwise they append. Each id replays like
   * `createEntry`: the same values are no change and keep their place, other
   * values a 409 naming the row (`entries[2]: …`).
   */
  async createEntries(
    tableId: string,
    input: CreateTableEntriesRequest,
    history?: HistoryContext
  ): Promise<CreateTableEntriesResponse & { createdIds: string[] }> {
    const rows = parseEntryCreates(input);
    const afterId = input.afterEntryId;
    if (afterId !== undefined) validateId(afterId);
    return withRecordedSchema(
      tableId,
      history,
      async (schema, tx, journal) => {
        assertEntrySchemaVersion(schema, input.schemaVersion);
        let beforeEntryId: string | null = null;
        if (afterId !== undefined) {
          // Placement needs the order lock before any INSERT locks a relation target.
          await lockEntryOrder(schema.table.id, tx);
          beforeEntryId = await entryFollowing(
            schema,
            afterId,
            rows.map((row) => row.id),
            tx
          );
        }
        const entries: TableEntry[] = [];
        const createdIds: string[] = [];
        for (const [index, row] of rows.entries()) {
          const { entry, created } = await labeledAsync(`entries[${index}]`, async () =>
            insertEntry(
              schema,
              beforeEntryId ? { ...row, beforeEntryId } : row,
              tx,
              async (current) => (current ? { entry: current } : {}),
              journal
            )
          );
          entries.push(entry);
          if (created) createdIds.push(entry.id);
        }
        return {
          entries,
          createdIds,
          schemaVersion: schema.schemaVersion,
          relatedEntries: await relatedEntries(schema, entries, tx),
          relatedItems: await relatedItems(schema, entries, tx),
        };
      },
      (schema, result) => stepLabels.entryWrite(schema.table.name, result.createdIds.length, 0)
    );
  }

  /** Patch an entry; with `history`, a real change is one undoable step. */
  async updateEntry(
    tableId: string,
    id: string,
    input: UpdateTableEntryRequest,
    history?: HistoryContext
  ): Promise<
    TableEntryResponse & {
      updated: boolean;
      /** The occurrences a done status completed (see {@link advanceOnDone}). */
      occurrences: OccurrenceChange[];
    }
  > {
    validateId(id);
    if (
      typeof input.expectedRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    )
      throw entryBadRequest('expectedRevision must be the entry revision returned by the server.');
    return withRecordedSchema(
      tableId,
      history,
      async (schema, tx, journal) => {
        assertEntrySchemaVersion(schema, input.schemaVersion);
        const advance = await advanceOnDone(schema, id, input.values, tx, history);
        const { entry, updated } = await patchEntry(
          schema,
          id,
          advance.values,
          tx,
          async (current) =>
            current.revision === input.expectedRevision
              ? null
              : entryConflict(
                  'This entry changed while you were editing it. Reload the latest entry before saving.',
                  { ...(await entryResponse(schema, current, tx)) }
                ),
          journal
        );
        if (journal) journal.ops.push(...advance.ops);
        return {
          ...(await entryResponse(schema, entry, tx)),
          updated: updated || advance.ops.length > 0,
          occurrences: await occurrenceChanges(tx, advance.ops, 'forward'),
        };
      },
      (schema) =>
        stepLabels.entryUpdate(
          schema.table.name,
          schema.fields
            .filter((field) => Object.hasOwn(input.values, field.id))
            .map((field) => field.name)
        )
    );
  }

  /**
   * Insert and then update entries in one transaction, all or nothing, with
   * values keyed by field name. Inserts run in order, so one may link to an
   * entry an earlier insert created; an insert replaying an existing id with
   * the same values is reported as `existing`, with other values it is a 409.
   * An update needs an existing entry (404), may check a revision prefix
   * (409 with the current entry, values by name) and reports an unchanged
   * patch as `unchanged`. The schema lock is held throughout, so no schema
   * version is taken. A failing row's error names it (`insert[2]: …`).
   */
  async writeBatch(
    tableId: string,
    batch: EntryBatch,
    history?: HistoryContext
  ): Promise<EntryBatchResult> {
    for (const [index, row] of batch.inserts.entries())
      labeled(`insert[${index}]`, () => {
        validateId(row.id);
        if (row.beforeEntryId !== undefined) validateId(row.beforeEntryId);
      });
    for (const [index, row] of batch.updates.entries())
      labeled(`update[${index}]`, () => validateId(row.id));
    return withRecordedSchema<EntryBatchResult>(
      tableId,
      history,
      async (schema, tx, journal) => {
        if (
          batch.expectedName !== undefined &&
          schema.table.name.toLowerCase() !== batch.expectedName.toLowerCase()
        )
          throw entryConflict(`This table was renamed to "${schema.table.name}".`, {
            table: toTableCatalogEntry(schema.table),
          });
        // Placement needs the order lock before any INSERT locks a relation target.
        if (batch.inserts.some((row) => row.beforeEntryId !== undefined))
          await lockEntryOrder(schema.table.id, tx);
        const result: EntryBatchResult = {
          inserted: [],
          existing: [],
          updated: [],
          unchanged: [],
          occurrences: [],
        };
        for (const [index, row] of batch.inserts.entries()) {
          const { entry, created } = await labeledAsync(`insert[${index}]`, async () =>
            insertEntry(
              schema,
              { ...row, values: await namedValues(schema, row.values, batch, tx) },
              tx,
              async (current) => (current ? { entry: namedEntry(schema, current) } : {}),
              journal
            )
          );
          (created ? result.inserted : result.existing).push(entry);
        }
        for (const [index, row] of batch.updates.entries()) {
          const prefix = row.revisionPrefix?.toLowerCase();
          const advance = await labeledAsync(`update[${index}] ${row.id}`, async () =>
            advanceOnDone(
              schema,
              row.id,
              await namedValues(schema, row.values, batch, tx),
              tx,
              history
            )
          );
          const { entry, updated } = await labeledAsync(`update[${index}] ${row.id}`, async () =>
            patchEntry(
              schema,
              row.id,
              advance.values,
              tx,
              async (current) =>
                prefix === undefined || current.revision.startsWith(prefix)
                  ? null
                  : entryConflict(
                      'This entry changed since that revision. Re-read it and patch only the fields you change.',
                      { entry: namedEntry(schema, current) }
                    ),
              journal
            )
          );
          if (journal) journal.ops.push(...advance.ops);
          if (updated || advance.ops.length > 0) {
            result.updated.push(entry);
            result.occurrences.push(await occurrenceChanges(tx, advance.ops, 'forward'));
          } else result.unchanged.push(entry);
        }
        if (batch.references) await assertEntryReferences(batch.references, tx);
        return result;
      },
      (schema, result) =>
        stepLabels.entryWrite(schema.table.name, result.inserted.length, result.updated.length)
    );
  }

  /**
   * Delete entries together or not at all. Ids that no longer exist count as
   * already deleted, so a retry succeeds. A changed entry (per
   * `expectedRevisions`) or other entries still linking to a deleted one
   * refuse the whole delete with a 409, unless `clearReferences` clears those
   * links explicitly first, so the relation keys' ON DELETE SET NULL never
   * clears a link silently.
   */
  async deleteEntries(
    tableId: string,
    input: DeleteTableEntriesRequest,
    history?: HistoryContext
  ): Promise<DeleteTableEntriesResult> {
    const deletion = parseDeletion(input);
    return withRecordedSchema<DeleteTableEntriesResult>(
      tableId,
      history,
      async (schema, tx, journal) => {
        await lockEntryOrder(schema.table.id, tx);
        const table = physicalTable(schema.table);
        const { rows } = await tx.query<RawEntry>(
          `SELECT ${projection(schema)} FROM ONLY ${table} WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
          [deletion.ids]
        );
        const found = new Map(
          rows.map((row) => {
            const entry = toEntry(schema, row);
            return [entry.id, entry];
          })
        );
        const existing = deletion.ids.filter((id) => found.has(id));
        const alreadyDeleted = deletion.ids.filter((id) => !found.has(id));
        const changed = [...found.values()].filter((entry) => {
          const expected = deletion.revisions.get(entry.id);
          return expected !== undefined && expected !== entry.revision;
        });
        if (changed.length)
          throw entryConflict(
            'Some selected entries changed since you loaded them. Review the latest entries before deleting.',
            { entries: changed, schemaVersion: schema.schemaVersion }
          );
        if (!existing.length)
          return { deletedIds: [], alreadyDeleted, clearedReferences: [], unlinkedEntries: [] };

        const references = await incomingReferences(schema, existing, tx);
        if (references.length && !deletion.clearReferences) {
          const links = references.reduce((sum, reference) => sum + reference.count, 0);
          throw entryConflict(
            `${links === 1 ? '1 link from another entry points' : `${links} links from other entries point`} to the selected entries. Confirm to remove those links.`,
            {
              references: references.map(({ tableId, tableName, fieldId, fieldName, count }) => ({
                tableId,
                tableName,
                fieldId,
                fieldName,
                count,
              })),
            }
          );
        }
        // Undo puts every deleted row back exactly (archived fields' data
        // included) and the links hidden columns lose to the foreign keys.
        const columns = journal ? await snapshotColumns(schema, tx) : [];
        const snapshots = journal ? await readRows(schema.table, columns, existing, tx) : null;
        const hidden = journal ? await hiddenSingleLinksTo(schema.table.id, existing, tx) : [];
        const clearedReferences: DeleteTableEntriesResponse['clearedReferences'] = [];
        const unlinked = new Map<string, string[]>();
        for (const reference of references) {
          const other = reference.table.id !== schema.table.id;
          // Clearing a link is an entry write there: hold that table to the
          // same schema, trigger and lock rules as its own editor.
          if (other && !unlinked.has(reference.table.id)) {
            await lockEntrySchema(reference.table.id, tx, true);
            unlinked.set(reference.table.id, []);
          }
          const cleared = await clearLinks(reference, existing, other ? [] : existing, tx);
          if (!cleared.length) continue;
          if (journal) {
            const op = entriesOp(journal, reference.table.id, {
              [reference.fieldId]: reference.multiple ? 'uuid[]' : 'uuid',
            });
            for (const row of cleared)
              op.rows.push({
                tableId: reference.table.id,
                id: row.id,
                before: { [reference.fieldId]: row.before },
                after: { [reference.fieldId]: row.after },
              });
          }
          clearedReferences.push({
            tableId: reference.tableId,
            fieldId: reference.fieldId,
            count: cleared.reduce((sum, row) => sum + row.removed, 0),
          });
          if (other) unlinked.get(reference.table.id)?.push(...cleared.map((row) => row.id));
        }
        const { rows: deleted } = await tx.query<{ id: string }>(
          `DELETE FROM ONLY ${table} WHERE id = ANY($1::uuid[]) RETURNING id::text AS id`,
          [existing]
        );
        if (journal && snapshots) {
          const op = entriesOp(journal, schema.table.id, columnTypes(columns));
          for (const id of existing) {
            const before = snapshots.get(id);
            if (before) op.rows.push({ tableId: schema.table.id, id, before, after: null });
          }
          for (const link of hidden) {
            entriesOp(journal, link.tableId, { [link.fieldId]: 'uuid' });
            op.rows.push({
              tableId: link.tableId,
              id: link.entryId,
              before: { [link.fieldId]: link.value },
              after: { [link.fieldId]: null },
              hidden: true,
            });
          }
        }
        // A repeat never outlives its row; undo puts the repeat and its log back.
        const repeatState = await takeEntryRepeats(
          tx,
          schema.table.id,
          deleted.map((row) => row.id)
        );
        if (journal) journal.ops.push(...cleanupOps(repeatState));
        const gone = new Set(deleted.map((row) => row.id));
        return {
          deletedIds: existing.filter((id) => gone.has(id)),
          alreadyDeleted,
          clearedReferences,
          unlinkedEntries: [...unlinked]
            .filter(([, entryIds]) => entryIds.length > 0)
            .map(([otherTableId, entryIds]) => ({ tableId: otherTableId, entryIds })),
        };
      },
      (schema, result) => stepLabels.entryDelete(schema.table.name, result.deletedIds.length)
    );
  }

  /**
   * Every row's repeat on the table's repeating fields, each with its
   * current occurrence's log, for the grid and Board: enough to show the
   * next occurrence and whether it is overdue without opening rows.
   */
  async tableRepeats(tableId: string): Promise<TableRepeatsView> {
    return withSchema(tableId, async (schema, tx) => {
      const fieldIds = schema.fields
        .filter((field) => field.recurrence && (field.type === 'date' || field.type === 'datetime'))
        .map((field) => field.id);
      const repeats = await listRepeatsForFields(tx, fieldIds);
      const logs = new Map<string, OccurrenceLogRow[]>();
      for (const row of await listCurrentOccurrenceLogs(tx, fieldIds)) {
        const key = `${row.fieldId}/${row.entryId}`;
        logs.set(key, [...(logs.get(key) ?? []), row]);
      }
      const rows: TableRepeatsView['rows'] = [];
      for (const [fieldId, byEntry] of repeats)
        for (const [entryId, repeat] of byEntry)
          rows.push({ fieldId, entryId, repeat, log: logs.get(`${fieldId}/${entryId}`) ?? [] });
      return { tableId: schema.table.id, rows };
    });
  }

  /** One entry's repeats (by field id) and its occurrence log, newest first. */
  async entryRepeats(tableId: string, entryId: string): Promise<EntryRepeatsView> {
    validateId(entryId);
    return withSchema(tableId, async (schema, tx) => {
      const entry = await readEntry(schema, entryId, tx);
      if (!entry) throw new AppError('Entry not found', ErrorCode.NOT_FOUND, 404);
      const active = new Set(schema.fields.map((field) => field.id));
      const repeats: Record<string, TableRepeat> = {};
      for (const [fieldId, value] of await readEntryRepeats(tx, schema.table.id, entry.id))
        if (active.has(fieldId)) repeats[fieldId] = value;
      const log = (await readOccurrenceLog(tx, schema.table.id, entry.id)).filter((row) =>
        active.has(row.fieldId)
      );
      return { entryId: entry.id, revision: entry.revision, repeats, log };
    });
  }

  /**
   * A repeat action on one row's repeating date or datetime field: set,
   * clear, complete, skip, move one occurrence, shift all upcoming, or undo
   * one logged occurrence. Every action checks the entry revision and
   * schema version, writes the row's date cell with the repeat and its log in
   * one transaction, and (with `history`) is one undoable step.
   */
  async repeatAction(
    tableId: string,
    entryId: string,
    fieldId: string,
    input: RepeatActionInput,
    history?: HistoryContext,
    options: RepeatActionOptions = {}
  ): Promise<RepeatActionResult> {
    validateId(entryId);
    if (typeof input !== 'object' || input === null)
      throw entryBadRequest('Request must be an object.');
    if (
      typeof input.expectedRevision !== 'string' ||
      !ENTRY_REVISION_PATTERN.test(input.expectedRevision)
    )
      throw entryBadRequest('expectedRevision must be the entry revision returned by the server.');
    let label = 'Edit repeat of';
    return withRecordedSchema(
      tableId,
      history,
      async (schema, tx, journal) => {
        assertEntrySchemaVersion(schema, input.schemaVersion);
        const field = schema.fields.find((candidate) => candidate.id === fieldId);
        if (!field || (field.type !== 'date' && field.type !== 'datetime'))
          throw new AppError('Date field not found', ErrorCode.NOT_FOUND, 404);
        if (!field.recurrence)
          throw entryBadRequest(
            `${field.name} doesn't repeat. Turn on repeat for the field first.`
          );
        const entry = await readEntry(schema, entryId, tx, true);
        if (!entry) throw new AppError('Entry not found', ErrorCode.NOT_FOUND, 404);
        const stale = async () =>
          entryConflict(
            'This entry changed while you were editing it. Reload the latest entry before saving.',
            { ...(await entryResponse(schema, entry, tx)) }
          );
        if (entry.revision !== input.expectedRevision) throw await stale();
        const before = await readRepeat(tx, field.id, entry.id, true);
        if (
          input.expectedCurrent !== undefined &&
          (before?.current ?? null) !== input.expectedCurrent
        )
          throw await stale();
        const plan = await planRepeatAction(
          field,
          entry,
          before,
          input,
          tx,
          history,
          options.clock ?? (() => new Date())
        );
        label = plan.label;
        const op: RepeatOp = {
          op: 'repeat',
          tableId: schema.table.id,
          fieldId: field.id,
          entryId: entry.id,
          before,
          after: plan.after,
          added: [],
          removed: plan.removed,
          ...(plan.occurrence ? { occurrence: plan.occurrence } : {}),
        };
        await deleteOccurrences(
          tx,
          plan.removed.map((row) => row.id)
        );
        const logged: OccurrenceLogRow[] = [];
        for (const row of plan.log) logged.push(await logOccurrence(tx, row));
        op.added.push(...logged);
        await writeRepeat(tx, schema.table.id, field.id, entry.id, plan.after);
        let current = entry;
        const patch: TableEntryValues = {};
        if (plan.cell !== undefined)
          // patchEntry reads an offset-less datetime in the machine zone; pass the instant.
          patch[field.id] = cellColumn(field, plan.cell, plan.after?.tz ?? before?.tz);
        // An explicit Complete that advances also resets a status that holds a done option.
        const reset =
          input.action === 'complete' && plan.after && plan.after !== before
            ? statusReset(schema, field, entry)
            : undefined;
        if (reset) patch[reset.fieldId] = reset.value;
        if (Object.keys(patch).length) {
          const patched = await patchEntry(schema, entry.id, patch, tx, async () => null, journal);
          current = patched.entry;
        }
        const changed =
          op.added.length > 0 || op.removed.length > 0 || !sameRepeat(before, plan.after);
        if (journal && changed) journal.ops.push(op);
        return {
          ...(await entryResponse(schema, current, tx)),
          fieldId: field.id,
          repeat: plan.after,
          logged,
          removed: op.removed.map((row) => row.id),
          changed: changed || current.revision !== entry.revision,
          occurrences: changed ? await occurrenceChanges(tx, [op], 'forward') : [],
        };
      },
      (schema) =>
        stepLabels.entryRepeat(
          schema.table.name,
          schema.fields.find((candidate) => candidate.id === fieldId)?.name ?? 'date',
          label
        )
    );
  }
}

export type RepeatActionInput = {
  expectedRevision: string;
  schemaVersion: string;
  /** Optional guard: the repeat's `current` the client saw (null = none). */
  expectedCurrent?: string | null;
} & (
  | {
      action: 'set';
      rrule: string;
      date?: string;
    }
  | { action: 'clear' }
  | {
      action: 'complete';
      /** "Now" for the engine's checks (tests, agents); default the clock. */
      now?: string;
    }
  | {
      action: 'skip';
      /** Skip every past occurrence, each one logged (at most 5,000). */
      toUpcoming?: boolean;
      /**
       * "Jump to now" (a repeat at an interval): straight to the first
       * upcoming step, logging none of the missed ones, however many. Not
       * with `toUpcoming` (400).
       */
      jump?: boolean;
      /**
       * "Now" for the past test, a wall time in the repeat's zone (an instant
       * is read as one); default the clock, as an instant.
       */
      now?: string;
    }
  | { action: 'move'; occurrence?: string; to: string }
  | { action: 'shift'; occurrence?: string; to: string }
  | { action: 'undoOccurrence'; occurrenceId: string }
);

export interface RepeatActionOptions {
  /**
   * The moment Skip to upcoming and Jump to now read when no `now` is sent
   * (default the clock); tests pass a fixed one.
   */
  clock?: () => Date;
}

export interface RepeatActionResult extends TableEntryResponse {
  fieldId: string;
  repeat: TableRepeat | null;
  /** Log rows this action added. */
  logged: OccurrenceLogRow[];
  /** Log row ids this action removed. */
  removed: string[];
  /** False when nothing changed (no history step). */
  changed: boolean;
  /**
   * The occurrence this action did (none for set, clear and a no-op), for
   * the hook event sent after commit. Not part of the route's answer.
   */
  occurrences: OccurrenceChange[];
}

/** Every repeating row of a table, with its current occurrence's log ({@link TableEntriesModelClass.tableRepeats}). */
export interface TableRepeatsView {
  tableId: string;
  rows: Array<{
    fieldId: string;
    entryId: string;
    repeat: TableRepeat;
    /** The current occurrence's log rows, oldest first. */
    log: OccurrenceLogRow[];
  }>;
}

export interface EntryRepeatsView {
  entryId: string;
  revision: string;
  repeats: Record<string, TableRepeat>;
  log: OccurrenceLogRow[];
}

interface RepeatPlan {
  after: TableRepeat | null;
  /**
   * New value of the row's date cell as wall times (`start`, or `start/end`
   * for a range with an end), or null; undefined = unchanged.
   */
  cell?: string | null;
  log: Array<Parameters<typeof logOccurrence>[1]>;
  removed: OccurrenceLogRow[];
  label: string;
  /** The occurrence action it is (none for set and clear). */
  occurrence?: OccurrenceTag;
}

function repeatInvalid(error: string): AppError {
  return entryBadRequest(error);
}

/** The wall time a client sent for a field of `kind`, normalized (seconds, no zone). */
function wallInput(value: unknown, kind: 'date' | 'datetime', tz: string, name: string): string {
  if (typeof value !== 'string')
    throw entryBadRequest(`${name} must be a date${kind === 'datetime' ? ' and time' : ''}.`);
  let wall: string | null = value;
  if (kind === 'datetime') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) wall = `${value}:00`;
    else if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) wall = instantToWall(value, tz);
    else wall = value.replace(/\.\d+$/, '');
  }
  if (!wall || wallKindOf(wall) !== kind || wallMs(wall) === null)
    throw entryBadRequest(
      `${name} must be a ${kind === 'date' ? 'date (YYYY-MM-DD)' : 'date and time (YYYY-MM-DDTHH:MM:SS)'}.`
    );
  return wall;
}

/** A range cell's text split at its slash: `start` and `end` (null for a single value). */
function splitRange(value: string): { start: string; end: string | null } {
  const slash = value.indexOf('/');
  return slash < 0
    ? { start: value, end: null }
    : { start: value.slice(0, slash), end: value.slice(slash + 1) };
}

/**
 * The row's cell as wall times of the field's kind in `tz`: its value, or a
 * range's start and end (a date range's end is its last day, as on the
 * wire); null when empty.
 */
function cellWalls(
  field: TableField,
  entry: TableEntry,
  tz: string
): { start: string; end: string | null } | null {
  const value = entry.values[field.id];
  if (typeof value !== 'string' || !value) return null;
  const parts = isRange(field) ? splitRange(value) : { start: value, end: null };
  const wall = (part: string) =>
    field.type === 'date' ? part.slice(0, 10) : instantToWall(part, tz);
  const start = wall(parts.start);
  if (!start) return null;
  return { start, end: parts.end === null ? null : wall(parts.end) };
}

/** The row's cell (a range's start) as a wall time of the field's kind, or null when empty. */
function cellWall(field: TableField, entry: TableEntry, tz: string): string | null {
  return cellWalls(field, entry, tz)?.start ?? null;
}

function ensure<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw repeatInvalid(result.error);
  return result.value;
}

/**
 * Whether `wall` is an occurrence of the series at or after `current`,
 * found without walking (an interval repeat's may be thousands of steps on).
 */
function isUpcomingOccurrence(repeat: TableRepeat, wall: string): boolean {
  return isTableRepeatUpcoming(repeat, wall);
}

async function planRepeatAction(
  field: TableField,
  entry: TableEntry,
  before: TableRepeat | null,
  input: RepeatActionInput,
  tx: DbQueryable,
  history: HistoryContext | undefined,
  clock: () => Date
): Promise<RepeatPlan> {
  const kind = field.type === 'date' ? 'date' : 'datetime';
  const actor = history ? { kind: history.actor.kind, id: history.actor.id } : null;
  const base = { tableId: field.tableId, fieldId: field.id, entryId: entry.id, actor };
  const need = (): TableRepeat => {
    if (!before) throw entryBadRequest(`This entry's ${field.name} doesn't repeat.`);
    return before;
  };
  switch (input.action) {
    case 'set': {
      if (typeof input.rrule !== 'string') throw entryBadRequest('rrule must be a repeat rule.');
      const tz = before?.tz ?? userTimeZone();
      const date =
        input.date !== undefined
          ? wallInput(input.date, kind, tz, 'date')
          : (before?.current ?? cellWall(field, entry, tz));
      if (!date)
        throw entryBadRequest(`Set ${field.name} first, or pass the date the repeat starts on.`);
      // Repeats (docs/architecture.md): on set days.
      const created = ensure(createTableRepeat({ date, rrule: input.rrule, tz }));
      // Changing only the rule keeps the series anchor and where the row is.
      const after =
        before && input.date === undefined
          ? { ...created, dtstart: before.dtstart, current: before.current }
          : created;
      const problem = tableRepeatWriteProblem(after);
      if (problem) throw repeatInvalid(problem);
      const moved = before ? await readMoves(tx, field.id, entry.id, after.current) : [];
      return {
        after,
        cell: sameCell(field, entry, moved[0]?.movedTo ?? after.current, after.tz),
        log: [],
        removed: [],
        label: before ? 'Change repeat of' : 'Set repeat of',
      };
    }
    case 'clear':
      need();
      // The log stays: it is the row's history, and the cell keeps its date.
      return { after: null, log: [], removed: [], label: 'Stop repeat of' };
    case 'complete':
    case 'skip': {
      const repeat = need();
      const verb = input.action === 'complete' ? 'Complete' : 'Skip';
      if (await isFinished(tx, field.id, entry.id, repeat.current, repeat))
        throw entryConflict(
          `The series of ${field.name} has ended; there is no occurrence to ${verb.toLowerCase()}.`
        );
      // A `now` sent is a wall time; without one the engine gets the moment, so
      // an interval compares instants (exact in a fall-back's repeated hour).
      const now = (): string | Date =>
        input.now !== undefined ? wallInput(input.now, kind, repeat.tz, 'now') : clock();
      if (input.action === 'skip' && input.jump && input.toUpcoming)
        throw entryBadRequest('Send jump or toUpcoming, not both.');
      if (input.action === 'skip' && input.jump) {
        // Jump to now: `current` moves, nothing is logged; undo puts it back.
        const after = ensure(jumpTableRepeatToUpcoming(repeat, now()));
        if (!after)
          throw entryConflict(
            'The series ends before now: there is no upcoming occurrence to jump to.'
          );
        if (after.current === repeat.current)
          throw entryConflict('Nothing to skip: the current occurrence is not in the past.');
        const moved = await readMoves(tx, field.id, entry.id, after.current);
        return {
          after,
          cell: sameCell(field, entry, moved[0]?.movedTo ?? after.current, after.tz),
          log: [],
          removed: [],
          label: 'Jump to now on',
          occurrence: { action: 'jumped', from: repeat.current },
        };
      }
      let finished: string[];
      let next: TableRepeat | null;
      if (input.action === 'skip' && input.toUpcoming) {
        const result = ensure(skipTableRepeatToUpcoming(repeat, now()));
        if (!result.skipped.length)
          throw entryConflict('Nothing to skip: the current occurrence is not in the past.');
        finished = result.skipped;
        next = result.next;
      } else {
        const result = ensure(advanceTableRepeat(repeat));
        finished = [result.finished];
        next = result.next;
      }
      const kindLogged = input.action === 'complete' ? 'done' : 'skipped';
      // The series ended: `current` stays on the last occurrence, now logged.
      const after = next ?? repeat;
      const moved = next ? await readMoves(tx, field.id, entry.id, after.current) : [];
      return {
        after,
        cell: next
          ? sameCell(field, entry, moved[0]?.movedTo ?? after.current, after.tz)
          : undefined,
        log: finished.map((occurrence) => ({ ...base, occurrence, kind: kindLogged })),
        removed: [],
        label: input.action === 'skip' && finished.length > 1 ? `Skip ${finished.length} of` : verb,
        occurrence: { action: kindLogged },
      };
    }
    case 'move': {
      const repeat = need();
      const occurrence =
        input.occurrence === undefined
          ? repeat.current
          : wallInput(input.occurrence, kind, repeat.tz, 'occurrence');
      const to = wallInput(input.to, kind, repeat.tz, 'to');
      if (!isUpcomingOccurrence(repeat, occurrence))
        throw entryBadRequest('Only the current or an upcoming occurrence can be moved.');
      if (await isFinished(tx, field.id, entry.id, occurrence))
        throw entryConflict('That occurrence is already done or skipped.');
      const removed = await readMoves(tx, field.id, entry.id, occurrence);
      const log =
        to === occurrence ? [] : [{ ...base, occurrence, kind: 'moved' as const, movedTo: to }];
      if (!log.length && !removed.length)
        return { after: repeat, log: [], removed: [], label: 'Move' };
      return {
        after: repeat,
        cell: occurrence === repeat.current ? sameCell(field, entry, to, repeat.tz) : undefined,
        log,
        removed,
        label: 'Move one occurrence of',
        // Moved back to its own slot: no row is logged, the move is gone.
        occurrence: log.length
          ? { action: 'moved' }
          : { action: 'moved', from: occurrence, to: occurrence },
      };
    }
    case 'shift': {
      const repeat = need();
      const occurrence =
        input.occurrence === undefined
          ? repeat.current
          : wallInput(input.occurrence, kind, repeat.tz, 'occurrence');
      const to = wallInput(input.to, kind, repeat.tz, 'to');
      if (!isUpcomingOccurrence(repeat, occurrence))
        throw entryBadRequest('Shift from the current or an upcoming occurrence.');
      const offset = wallMs(to)! - wallMs(occurrence)!;
      if (offset === 0) return { after: repeat, log: [], removed: [], label: 'Shift' };
      // Weekdays follow the date part; a time-of-day change rides on dtstart.
      const days = dayOffset(occurrence, to);
      const rrule = ensure(shiftRuleByDays(repeat.rrule, days));
      const shiftWall = (wall: string) => msToWall(wallMs(wall)! + offset, kind);
      const after: TableRepeat = {
        ...repeat,
        rrule,
        dtstart: shiftWall(repeat.dtstart),
        current: shiftWall(repeat.current),
      };
      const problem = tableRepeatProblem(after);
      if (problem) throw repeatInvalid(problem);
      // Upcoming moves pointed at the old slots: drop them (undo puts them back).
      const removed = (await readMoves(tx, field.id, entry.id)).filter(
        (row) => wallMs(row.occurrence)! >= wallMs(repeat.current)!
      );
      return {
        after,
        cell: sameCell(field, entry, after.current, after.tz),
        log: [],
        removed,
        label: 'Shift upcoming of',
        occurrence: { action: 'shifted', from: occurrence, to },
      };
    }
    case 'undoOccurrence': {
      const repeat = need();
      const id = input.occurrenceId;
      if (typeof id !== 'string' || !/^tocc-/.test(id))
        throw entryBadRequest('occurrenceId must be a logged occurrence id.');
      const [row] = await readOccurrences(tx, [id], true);
      if (!row || row.fieldId !== field.id || row.entryId !== entry.id)
        throw new AppError('Logged occurrence not found', ErrorCode.NOT_FOUND, 404);
      let after = repeat;
      let cell: string | undefined;
      if (row.kind === 'moved') {
        if (row.occurrence === repeat.current) cell = repeat.current;
      } else {
        // Step back when this was the occurrence the row advanced past (or the
        // series' last one, where current stayed): the row is on it again.
        const next = ensure(nextRepeatOccurrence({ ...repeat, current: row.occurrence }));
        if (next === repeat.current) after = { ...repeat, current: row.occurrence };
        if (after.current !== repeat.current || row.occurrence === repeat.current) {
          const moved = await readMoves(tx, field.id, entry.id, after.current);
          cell = moved[0]?.movedTo ?? after.current;
        }
      }
      return {
        after,
        cell: cell === undefined ? undefined : sameCell(field, entry, cell, repeat.tz),
        log: [],
        removed: [row],
        label: `Undo ${row.kind === 'done' ? 'done' : row.kind} on`,
        occurrence: { action: 'undone' },
      };
    }
    default:
      throw entryBadRequest(
        'action must be set, clear, complete, skip, move, shift or undoOccurrence.'
      );
  }
}

/**
 * The cell (as wall times, see {@link RepeatPlan.cell}) for an occurrence
 * starting at `wall`. A range keeps the length of `entry`'s current value,
 * measured on wall-clock times in `tz`: whole days for
 * a date range, and for a datetime range 9:00 Fri – 17:00 Mon stays 17:00
 * across a DST change. A single value (length 0) stays single.
 */
function targetCell(field: TableField, entry: TableEntry, wall: string, tz: string): string {
  if (!isRange(field)) return wall;
  const current = cellWalls(field, entry, tz);
  const length = current?.end ? wallMs(current.end)! - wallMs(current.start)! : 0;
  const start = wallMs(wall);
  if (length <= 0 || start === null) return wall;
  return `${wall}/${msToWall(start + length, field.type === 'date' ? 'date' : 'datetime')}`;
}

/** {@link targetCell}, or undefined when the cell already holds exactly that (start and end). */
function sameCell(
  field: TableField,
  entry: TableEntry,
  wall: string,
  tz: string
): string | undefined {
  const target = targetCell(field, entry, wall, tz);
  const current = cellWalls(field, entry, tz);
  const shown =
    current && (current.end === null ? current.start : `${current.start}/${current.end}`);
  return shown === target ? undefined : target;
}

/**
 * A plan cell (wall times `start` or `start/end`, an instant, or null) as the
 * value patchEntry stores for `field`. A range's parts are converted one by
 * one: a `…Z` part is already an instant, any other datetime part is a wall
 * time in `tz`. A datetime range's end that a DST gap puts at or before its
 * start keeps the wall length in real time instead.
 */
function cellColumn(field: TableField, cell: string | null, tz: string | undefined): string | null {
  if (cell === null) return null;
  const zone = tz ?? userTimeZone();
  const stored = (part: string) =>
    field.type === 'date' || /(?:Z|[+-]\d{2}:?\d{2})$/.test(part)
      ? part
      : tableDateTimeToUtc(part, zone);
  if (!isRange(field)) return stored(cell);
  const parts = splitRange(cell);
  const start = stored(parts.start);
  if (start === null || parts.end === null) return start;
  let end = stored(parts.end);
  if (end === null) return start;
  if (field.type === 'datetime' && Date.parse(end) <= Date.parse(start)) {
    const length = (wallMs(parts.end) ?? 0) - (wallMs(parts.start) ?? 0);
    if (length <= 0) return start;
    end = tableDateTimeToUtc(new Date(Date.parse(start) + length).toISOString(), zone);
    if (end === null) return start;
  }
  return `${start}/${end}`;
}

/**
 * `entry` with a patch's value for a range field when the patch changes only
 * its END (a resize: the same start, another end); null otherwise (it moves
 * the start, rewrites the same value, or isn't a range value). A resize is
 * not a move: it neither triggers nor skips a done-advance, and its new
 * length applies to every later occurrence.
 */
function resizedEntry(field: TableField, entry: TableEntry, value: unknown): TableEntry | null {
  const current = entry.values[field.id];
  if (!isRange(field) || typeof value !== 'string' || typeof current !== 'string') return null;
  const canonical = tableDateRangeToCanonical(value, field.type, userTimeZone());
  if (canonical === null) return null;
  const before = splitRange(current);
  const after = splitRange(canonical);
  const same = (a: string | null, b: string | null) =>
    a === null || b === null || field.type === 'date' ? a === b : Date.parse(a) === Date.parse(b);
  return same(before.start, after.start) && !same(before.end, after.end)
    ? { ...entry, values: { ...entry.values, [field.id]: canonical } }
    : null;
}

/**
 * A repeating field's status semantics as cell values. The setting names
 * options by id; a select cell stores the option's label (unique per field,
 * case-insensitively), so both sides are mapped through the status field.
 */
function statusLabels(
  schema: EntrySchema,
  field: TableField
): { fieldId: string; isDone: (value: unknown) => boolean; reset: string | null } | null {
  const recurrence = field.recurrence;
  if (!recurrence) return null;
  const status = schema.fields.find((candidate) => candidate.id === recurrence.statusFieldId);
  if (!status?.options) return null;
  const labelOf = new Map(status.options.map((option) => [option.id, option.label]));
  const done = new Set(
    recurrence.doneOptionIds
      .map((id) => labelOf.get(id)?.toLowerCase())
      .filter((label): label is string => label !== undefined)
  );
  return {
    fieldId: status.id,
    isDone: (value) => typeof value === 'string' && done.has(value.toLowerCase()),
    reset:
      recurrence.resetOptionId === null ? null : (labelOf.get(recurrence.resetOptionId) ?? null),
  };
}

/** The status patch that resets `entry` after `field` advanced, when its status holds a done option. */
function statusReset(
  schema: EntrySchema,
  field: TableField,
  entry: TableEntry
): { fieldId: string; value: string | null } | undefined {
  const status = statusLabels(schema, field);
  if (!status || !status.isDone(entry.values[status.fieldId])) return undefined;
  return { fieldId: status.fieldId, value: status.reset };
}

/**
 * Completion model A on a plain entry write: when `values` (keyed by
 * field id) sets a status field to a done option of a repeating date field
 * that names it, and the row's status wasn't already done for that field,
 * the field's current occurrence is logged `done` and the date advances to
 * the next one; once any field advanced, the status resets to its
 * `resetOptionId`. A series on its last occurrence logs it and stays (the
 * status stays done); an already-ended series is left alone. A field the
 * patch sets itself is the writer's choice and does not advance, except a
 * patch that changes only a range's end (a resize): it advances with the new
 * length, and a resize alone advances nothing and logs nothing. Returns
 * the patch to write and the repeat ops to journal after it, so the whole
 * thing is one undo step with the entry write. Runs under the caller's
 * schema lock, before the patch's own revision check (a failing check
 * rolls everything back).
 */
async function advanceOnDone(
  schema: EntrySchema,
  id: string,
  values: TableEntryValues,
  tx: DbQueryable,
  history: HistoryContext | undefined
): Promise<{ values: TableEntryValues; ops: RepeatOp[] }> {
  const none = { values, ops: [] as RepeatOp[] };
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return none;
  const fields = schema.fields.flatMap((field) => {
    if (field.type !== 'date' && field.type !== 'datetime') return [];
    const status = statusLabels(schema, field);
    if (!status || !Object.hasOwn(values, status.fieldId)) return [];
    return status.isDone(values[status.fieldId]) ? [{ field, status }] : [];
  });
  if (!fields.length || !TABLE_ENTRY_ID_PATTERN.test(id)) return none;
  const entry = await readEntry(schema, id, tx, true);
  if (!entry) return none;
  const actor = history ? { kind: history.actor.kind, id: history.actor.id } : null;
  const patch: TableEntryValues = { ...values };
  const ops: RepeatOp[] = [];
  let reset: { fieldId: string; value: string | null } | undefined;
  for (const { field, status } of fields) {
    if (status.isDone(entry.values[status.fieldId])) continue;
    // A patch that sets the date itself is the writer's choice and does not
    // advance, unless it only changes a range's end (a resize).
    const resized: TableEntry | null = Object.hasOwn(values, field.id)
      ? resizedEntry(field, entry, values[field.id])
      : entry;
    if (!resized) continue;
    const before = await readRepeat(tx, field.id, entry.id, true);
    if (!before || (await isFinished(tx, field.id, entry.id, before.current, before))) continue;
    const advanced = advanceTableRepeat(before);
    if (!advanced.ok) continue;
    const { finished, next } = advanced.value;
    const op: RepeatOp = {
      op: 'repeat',
      tableId: schema.table.id,
      fieldId: field.id,
      entryId: entry.id,
      before,
      after: next ?? before,
      added: [
        await logOccurrence(tx, {
          tableId: schema.table.id,
          fieldId: field.id,
          entryId: entry.id,
          occurrence: finished,
          kind: 'done',
          actor,
        }),
      ],
      removed: [],
      occurrence: { action: 'done' },
    };
    ops.push(op);
    if (!next) continue; // Last occurrence: logged, the row stays on it and stays done.
    await writeRepeat(tx, schema.table.id, field.id, entry.id, next);
    const moved = await readMoves(tx, field.id, entry.id, next.current);
    const wall = moved[0]?.movedTo ?? next.current;
    if (resized !== entry)
      // The resize's own value is replaced by the next occurrence at its new length.
      patch[field.id] = cellColumn(field, targetCell(field, resized, wall, next.tz), next.tz);
    else {
      const cell = sameCell(field, entry, wall, next.tz);
      if (cell !== undefined) patch[field.id] = cellColumn(field, cell, next.tz);
    }
    reset ??= { fieldId: status.fieldId, value: status.reset };
  }
  if (reset) patch[reset.fieldId] = reset.value;
  return { values: patch, ops };
}

export const TableEntries = new TableEntriesModelClass();
