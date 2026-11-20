import {
  TableEntries,
  type EntryRepeatsView,
  type TableRepeatsView,
  type RepeatActionInput,
  type RepeatActionOptions,
  type RepeatActionResult,
} from '@snaglet/db/tables/table_entries';
import {
  TABLE_ENTRY_CREATE_MAX,
  TABLE_ENTRY_DELETE_MAX,
  TABLE_ENTRY_ID_PATTERN,
  TABLE_ENTRY_RESOLVE_MAX,
  type CreateTableEntriesResponse,
  type DeleteTableEntriesResponse,
  type ResolveTableEntriesResponse,
  type TableEntriesResponse,
  type TableEntryRef,
  type TableEntryResponse,
  type TableEntrySearchResponse,
  type TableEntrySort,
  type TableEntryWhere,
  type TableEntryValues,
} from '@snaglet/shared/types';
import { emitTableEntriesChanged } from '@server/realtime/surfaces/tables';
import { hooks, type TableEntryChange } from '@server/services/HookService';
import { rethrowIfProgrammerError } from '@server/utils/sqlErrors';
import { safeJsonParse } from '@snaglet/shared/utils';
import { forgetEntries } from '@server/services/tableSemantic/forgetEntries';
import { afterTableWrite, historyContext } from './tableHistory';
import { emitOccurrenceEvents, occurrenceEvents } from './tableOccurrenceEvents';
import {
  idList,
  offsetNumber,
  pageNumber,
  refuseAutomationsTable,
  tableBadRequest,
} from './tableValidation';

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw tableBadRequest('Request must be an object.');
  return input as Record<string, unknown>;
}

function version(input: unknown, name: string): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input))
    throw tableBadRequest(`${name} must be the version returned by the server.`);
  return input;
}

function values(input: unknown): TableEntryValues {
  const raw = object(input);
  const result: TableEntryValues = {};
  for (const [key, value] of Object.entries(raw)) {
    const links = Array.isArray(value) && value.every((item) => typeof item === 'string');
    if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && !links)
      throw tableBadRequest(
        'Entry values must be text, exact decimal strings, booleans, lists of entry or item ids, or null.'
      );
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * A page in row order; `focusEntryId` selects the page holding that entry and
 * ignores `page`. `q` filters (and `keep` lists entries regardless, as ids).
 */
export async function listTableEntries(
  tableId: string,
  input: unknown = {}
): Promise<TableEntriesResponse> {
  const query = object(input);
  const focus = query.focusEntryId;
  if (focus !== undefined && (typeof focus !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(focus)))
    throw tableBadRequest('focusEntryId must be an entry UUID.');
  const q = query.q;
  if (q !== undefined && typeof q !== 'string') throw tableBadRequest('q must be text.');
  return TableEntries.listEntries(tableId, {
    ...(focus === undefined ? { page: pageNumber(query.page, 'page') } : { focusEntryId: focus }),
    pageSize: pageNumber(query.pageSize, 'pageSize'),
    ...(q !== undefined && { q }),
    ...((q !== undefined || query.where !== undefined) && {
      keep: idList(query.keep, 'keep', 'entry ids'),
    }),
    ...(query.sort !== undefined && { sort: sortList(query.sort) }),
    ...(query.where !== undefined && { where: whereList(query.where) }),
  });
}

/**
 * `where=<JSON array of {fieldId, operator, value?}>`; operator and value
 * checks against the field happen in the model.
 */
function whereList(input: unknown): TableEntryWhere[] {
  if (typeof input !== 'string')
    throw tableBadRequest('where must be a JSON list of filter conditions.');
  const parsed = safeJsonParse<unknown>(input);
  if (!Array.isArray(parsed))
    throw tableBadRequest('where must be a JSON list of filter conditions.');
  return parsed as TableEntryWhere[];
}

/** `sort=<fieldId>:<asc|desc>,…` (levels in priority order); field checks happen in the model. */
function sortList(input: unknown): TableEntrySort[] {
  const parts = idList(input, 'sort', 'fieldId:asc|desc levels') ?? [];
  return parts.map((part) => {
    const at = part.lastIndexOf(':');
    const direction = part.slice(at + 1);
    if (at < 1 || (direction !== 'asc' && direction !== 'desc'))
      throw tableBadRequest('Each sort level must be fieldId:asc or fieldId:desc.');
    return { fieldId: part.slice(0, at), direction };
  });
}

export async function searchTableEntries(
  tableId: string,
  input: unknown = {}
): Promise<TableEntrySearchResponse> {
  const query = object(input);
  const q = query.q;
  if (q !== undefined && typeof q !== 'string') throw tableBadRequest('q must be text.');
  return TableEntries.searchEntries(tableId, {
    q,
    limit: pageNumber(query.limit, 'limit'),
    offset: offsetNumber(query.offset),
    exclude: idList(query.exclude, 'exclude', 'entry ids'),
  });
}

/** Names for entry refs across tables; missing entries and tables are left out. */
export async function resolveTableEntries(input: unknown): Promise<ResolveTableEntriesResponse> {
  const refs = object(input).refs;
  const bad = () =>
    tableBadRequest(
      `refs must list 1 to ${TABLE_ENTRY_RESOLVE_MAX} { tableId, entryId } entry references.`
    );
  if (!Array.isArray(refs)) throw bad();
  const parsed = refs.map((ref: unknown): TableEntryRef => {
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) throw bad();
    const { tableId, entryId } = ref as Record<string, unknown>;
    if (typeof tableId !== 'string' || typeof entryId !== 'string') throw bad();
    return { tableId, entryId };
  });
  return TableEntries.resolveEntries(parsed);
}

export async function getTableEntry(tableId: string, entryId: string): Promise<TableEntryResponse> {
  return TableEntries.getEntry(tableId, entryId);
}

// --- table entry hook events --------------------------------------------------
// A task is a table row, so these are the lifecycle events a "status changed"
// hook listens to. Every write path (REST, agent table_write, UI) emits here,
// after the write committed, next to the realtime emit.

/**
 * The entry's values before a write, or undefined when they can't be read (a
 * missing entry or table, a malformed id): the write that follows reports
 * those. A programmer-class SQL error (undefined column etc.) is rethrown.
 */
export async function previousEntryValues(
  tableId: string,
  entryId: string
): Promise<TableEntryValues | undefined> {
  try {
    return (await TableEntries.getEntry(tableId, entryId)).entry.values;
  } catch (err) {
    rethrowIfProgrammerError(err);
    return undefined;
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Fields whose wire value differs between `previous` and `next`, keyed the way
 * the entry's `values` are (field id). With no `previous`, every field in
 * `next` counts as changed from `null`.
 */
export function tableEntryChanges(
  previous: TableEntryValues | undefined,
  next: TableEntryValues
): TableEntryChange[] {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]);
  const changes: TableEntryChange[] = [];
  for (const field of keys) {
    const from = previous?.[field] ?? null;
    const to = next[field] ?? null;
    if (!sameValue(from, to)) changes.push({ field, from, to });
  }
  return changes;
}

export function emitTableEntryCreated(tableId: string, entryId: string): void {
  hooks.emit('table_entry:create', { tableId, entryId });
}

export function emitTableEntryUpdated(
  tableId: string,
  entryId: string,
  changes: TableEntryChange[]
): void {
  hooks.emit('table_entry:update', { tableId, entryId, changes });
}

function emitTableEntriesDeleted(tableId: string, entryIds: string[]): void {
  if (entryIds.length) hooks.emit('table_entry:delete', { tableId, entryIds });
}

export async function createTableEntry(
  tableId: string,
  input: unknown
): Promise<TableEntryResponse & { created: boolean }> {
  refuseAutomationsTable(tableId);
  const body = object(input);
  if (typeof body.id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(body.id))
    throw tableBadRequest('Entry id must be a UUID.');
  if (
    body.beforeEntryId !== undefined &&
    (typeof body.beforeEntryId !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(body.beforeEntryId))
  )
    throw tableBadRequest('beforeEntryId must be an entry UUID.');
  const history = historyContext();
  const result = await TableEntries.createEntry(
    tableId,
    {
      id: body.id,
      values: values(body.values),
      schemaVersion: version(body.schemaVersion, 'schemaVersion'),
      ...(body.beforeEntryId !== undefined ? { beforeEntryId: body.beforeEntryId } : {}),
    },
    history
  );
  if (result.created) {
    emitTableEntriesChanged(tableId, result.entry.id);
    emitTableEntryCreated(tableId, result.entry.id);
    await afterTableWrite(history.actor);
  }
  return result;
}

/**
 * Create several entries as one undoable step (a paste in the grid), all or
 * nothing. Emits one realtime change for the table and a create hook event
 * per new entry, after the commit; a full replay emits nothing.
 */
export async function createTableEntries(
  tableId: string,
  input: unknown
): Promise<CreateTableEntriesResponse & { created: boolean }> {
  refuseAutomationsTable(tableId);
  const body = object(input);
  if (!Array.isArray(body.entries))
    throw tableBadRequest(`entries must list 1 to ${TABLE_ENTRY_CREATE_MAX} new entries.`);
  const entries = body.entries.map((row: unknown, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      throw tableBadRequest(`entries[${index}]: Each entry must be { id, values }.`);
    const { id, values: rowValues } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(id))
      throw tableBadRequest(`entries[${index}]: Entry id must be a UUID.`);
    return { id, values: values(rowValues) };
  });
  if (
    body.afterEntryId !== undefined &&
    (typeof body.afterEntryId !== 'string' || !TABLE_ENTRY_ID_PATTERN.test(body.afterEntryId))
  )
    throw tableBadRequest('afterEntryId must be an entry UUID.');
  const history = historyContext();
  const { createdIds, ...result } = await TableEntries.createEntries(
    tableId,
    {
      entries,
      schemaVersion: version(body.schemaVersion, 'schemaVersion'),
      ...(body.afterEntryId !== undefined ? { afterEntryId: body.afterEntryId } : {}),
    },
    history
  );
  if (createdIds.length) {
    emitTableEntriesChanged(tableId, createdIds);
    for (const id of createdIds) emitTableEntryCreated(tableId, id);
    await afterTableWrite(history.actor);
  }
  return { ...result, created: createdIds.length > 0 };
}

export async function updateTableEntry(
  tableId: string,
  entryId: string,
  input: unknown
): Promise<TableEntryResponse> {
  refuseAutomationsTable(tableId);
  const body = object(input);
  const history = historyContext();
  // Read before the write so the hook event can carry from/to values.
  const previous = await previousEntryValues(tableId, entryId);
  const { updated, occurrences, ...result } = await TableEntries.updateEntry(
    tableId,
    entryId,
    {
      values: values(body.values),
      schemaVersion: version(body.schemaVersion, 'schemaVersion'),
      expectedRevision: version(body.expectedRevision, 'expectedRevision'),
    },
    history
  );
  if (updated) {
    emitTableEntriesChanged(tableId, result.entry.id);
    emitTableEntryUpdated(
      tableId,
      result.entry.id,
      tableEntryChanges(previous, result.entry.values)
    );
    // A done status completed occurrences: after the update event.
    emitOccurrenceEvents(await occurrenceEvents(occurrences, 'status', history.actor));
    await afterTableWrite(history.actor);
  }
  return result;
}

const isString = (value: unknown): value is string => typeof value === 'string';

function revisionMap(input: unknown): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  const bad = tableBadRequest(
    'expectedRevisions must map entry ids to entry revisions returned by the server.'
  );
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw bad;
  const result: Record<string, string> = {};
  for (const [id, revision] of Object.entries(input)) {
    if (!isString(revision)) throw bad;
    Object.defineProperty(result, id, {
      value: revision,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * Delete entries atomically. Emits once for this table when anything was
 * deleted, and once for each other table whose links were cleared.
 */
export async function deleteTableEntries(
  tableId: string,
  input: unknown
): Promise<DeleteTableEntriesResponse> {
  refuseAutomationsTable(tableId);
  const body = object(input);
  const ids = body.entryIds;
  if (!Array.isArray(ids) || !ids.every(isString))
    throw tableBadRequest(`entryIds must list 1 to ${TABLE_ENTRY_DELETE_MAX} entry UUIDs.`);
  const clearReferences = body.clearReferences;
  if (clearReferences !== undefined && typeof clearReferences !== 'boolean')
    throw tableBadRequest('clearReferences must be a boolean.');
  const expectedRevisions = revisionMap(body.expectedRevisions);
  const history = historyContext();
  const { unlinkedEntries, ...result } = await TableEntries.deleteEntries(
    tableId,
    {
      entryIds: ids,
      ...(expectedRevisions ? { expectedRevisions } : {}),
      ...(clearReferences !== undefined ? { clearReferences } : {}),
    },
    history
  );
  if (result.deletedIds.length) emitTableEntriesChanged(tableId, result.deletedIds);
  for (const other of unlinkedEntries) emitTableEntriesChanged(other.tableId, other.entryIds);
  emitTableEntriesDeleted(tableId, result.deletedIds);
  if (result.deletedIds.length) await forgetEntries(tableId, result.deletedIds);
  if (result.deletedIds.length) await afterTableWrite(history.actor);
  return result;
}

// --- per-row repeats ----------------------------------------------
// Routes (proposed for routes/tables.ts):
//   GET  /:id/repeats                                      → TableRepeatsView (every repeating row)
//   GET  /:id/entries/:entryId/repeats                     → EntryRepeatsView
//   PUT  /:id/entries/:entryId/repeats/:fieldId            { rrule, date? } → RepeatActionResult
//   DELETE /:id/entries/:entryId/repeats/:fieldId          (body or query: expectedRevision, schemaVersion)
//   POST /:id/entries/:entryId/repeats/:fieldId/complete   { now? }
//   POST /:id/entries/:entryId/repeats/:fieldId/skip       { toUpcoming?, jump?, now? }
//        (jump: an interval far behind moves to its first upcoming step, logging none;
//         jump and toUpcoming together are a 400)
//   POST /:id/entries/:entryId/repeats/:fieldId/move       { occurrence?, to }
//   POST /:id/entries/:entryId/repeats/:fieldId/shift      { occurrence?, to }
//   POST /:id/entries/:entryId/occurrences/:occurrenceId/undo { fieldId }
// Every write body also carries expectedRevision and schemaVersion (and may
// carry expectedCurrent).

const REPEAT_ACTIONS = [
  'set',
  'clear',
  'complete',
  'skip',
  'move',
  'shift',
  'undoOccurrence',
] as const;
export type RepeatAction = (typeof REPEAT_ACTIONS)[number];

function optionalWall(input: unknown, name: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !input.trim())
    throw tableBadRequest(`${name} must be a date or date-time.`);
  return input;
}

/** Every repeating row of a table with its current occurrence's log. */
export async function getTableRepeats(tableId: string): Promise<TableRepeatsView> {
  return TableEntries.tableRepeats(tableId);
}

/** One entry's repeats and occurrence log. */
export async function getTableEntryRepeats(
  tableId: string,
  entryId: string
): Promise<EntryRepeatsView> {
  return TableEntries.entryRepeats(tableId, entryId);
}

/**
 * A repeat action on one row's repeating date field: one undoable step.
 * Emits like an entry update (realtime + `table_entry:update` hook) when the
 * row's date cell changed, then `table_entry:occurrence` for the occurrence
 * it acted on, and always refreshes the entry when anything changed.
 * `options.clock` is the moment a skip reads without a `now` (tests).
 */
export async function tableEntryRepeatAction(
  tableId: string,
  entryId: string,
  fieldId: string,
  action: RepeatAction,
  input: unknown = {},
  options: RepeatActionOptions = {}
): Promise<Omit<RepeatActionResult, 'occurrences'>> {
  if (!REPEAT_ACTIONS.includes(action)) throw tableBadRequest('Unknown repeat action.');
  if (typeof fieldId !== 'string' || !fieldId) throw tableBadRequest('fieldId is required.');
  const body = object(input);
  const expectedCurrent = body.expectedCurrent;
  if (
    expectedCurrent !== undefined &&
    expectedCurrent !== null &&
    typeof expectedCurrent !== 'string'
  )
    throw tableBadRequest('expectedCurrent must be the repeat’s current occurrence.');
  const common = {
    expectedRevision: version(body.expectedRevision, 'expectedRevision'),
    schemaVersion: version(body.schemaVersion, 'schemaVersion'),
    ...(expectedCurrent !== undefined ? { expectedCurrent } : {}),
  };
  let request: RepeatActionInput;
  switch (action) {
    case 'set':
      if (typeof body.rrule !== 'string') throw tableBadRequest('rrule must be a repeat rule.');
      // "within" (time to do it) was removed. A non-null value is rejected like
      // an unknown field, but `within: null` is accepted and ignored: older
      // clients sent it as the "no window" default, so failing that would break
      // them for no reason.
      if (body.within !== undefined && body.within !== null)
        throw tableBadRequest(
          'within is no longer supported (time-to-do-it windows were removed); drop it.'
        );
      request = {
        ...common,
        action,
        rrule: body.rrule,
        ...(body.date !== undefined ? { date: optionalWall(body.date, 'date') } : {}),
      };
      break;
    case 'complete':
      request = {
        ...common,
        action,
        ...(body.now !== undefined ? { now: optionalWall(body.now, 'now') } : {}),
      };
      break;
    case 'skip':
      if (body.toUpcoming !== undefined && typeof body.toUpcoming !== 'boolean')
        throw tableBadRequest('toUpcoming must be a boolean.');
      if (body.jump !== undefined && typeof body.jump !== 'boolean')
        throw tableBadRequest('jump must be a boolean.');
      // Contradictory: skip each one (logged) or jump past them all (not logged).
      if (body.jump === true && body.toUpcoming === true)
        throw tableBadRequest('Send jump or toUpcoming, not both.');
      request = {
        ...common,
        action,
        ...(body.toUpcoming !== undefined ? { toUpcoming: body.toUpcoming } : {}),
        ...(body.jump !== undefined ? { jump: body.jump } : {}),
        ...(body.now !== undefined ? { now: optionalWall(body.now, 'now') } : {}),
      };
      break;
    case 'move':
    case 'shift': {
      const to = optionalWall(body.to, 'to');
      if (to === undefined) throw tableBadRequest('to is required.');
      const occurrence = optionalWall(body.occurrence, 'occurrence');
      request = { ...common, action, to, ...(occurrence !== undefined ? { occurrence } : {}) };
      break;
    }
    case 'undoOccurrence':
      if (typeof body.occurrenceId !== 'string')
        throw tableBadRequest('occurrenceId must be a logged occurrence id.');
      request = { ...common, action, occurrenceId: body.occurrenceId };
      break;
    default:
      request = { ...common, action };
  }
  const history = historyContext();
  const previous = await previousEntryValues(tableId, entryId);
  const { occurrences, ...result } = await TableEntries.repeatAction(
    tableId,
    entryId,
    fieldId,
    request,
    history,
    options
  );
  if (result.changed) {
    emitTableEntriesChanged(tableId, result.entry.id);
    const changes = tableEntryChanges(previous, result.entry.values);
    if (changes.length) emitTableEntryUpdated(tableId, result.entry.id, changes);
    emitOccurrenceEvents(await occurrenceEvents(occurrences, 'action', history.actor));
    await afterTableWrite(history.actor);
  }
  return result;
}
