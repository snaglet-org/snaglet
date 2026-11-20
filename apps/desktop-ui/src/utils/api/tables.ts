/**
 * Database catalog tables API — `/api/tables`.
 *
 * Catalog ids are table identities, not workspace node ids. Every call
 * unwraps the standard envelope through `fetchData`, so a non-2xx response
 * surfaces as a thrown `FetchError` carrying the server's message and status
 * (404 unknown table, 409 duplicate name, id/name mismatch or stale rename,
 * 403 renaming a built-in, 400 invalid).
 */

import type {
  ArchivedTableFieldsResponse,
  RestoreTableItemRequest,
  TableFieldLifecycleResponse,
  CreateTableRequest,
  CreateTableResponse,
  RenameTableRequest,
  RenameTableResponse,
  SetTableProjectResponse,
  UpdateTablePlacementRequest,
  TableDetailResponse,
  TableListResponse,
  TableFieldsResponse,
  TableFieldResponse,
  CreateTableFieldRequest,
  UpdateTableFieldRequest,
  ReorderTableFieldsRequest,
  UpdateTableFieldViewRequest,
  SetTableFieldCalendarRequest,
  TableEntriesQuery,
  TableEntriesResponse,
  TableEntryResponse,
  CreateTableEntryRequest,
  CreateTableEntriesRequest,
  CreateTableEntriesResponse,
  UpdateTableEntryRequest,
  DeleteTableEntriesRequest,
  DeleteTableEntriesResponse,
  ResolveTableEntriesRequest,
  ResolveTableEntriesResponse,
  TableEntrySearchQuery,
  TableEntrySearchResponse,
  TableSelectOptionUsageResponse,
  TableHistoryResponse,
  TableHistoryStepRequest,
  TableHistoryStepResponse,
  SemanticOverviewResponse,
  SemanticStatus,
  UpdateSemanticSearchRequest,
} from '@snaglet/shared/types';
import { fetchData, getApiUrl } from './core';

export const tablesApi = {
  /** Every active custom table: search by meaning on or off, rows, rows embedded, build state (embeddings pane). */
  semanticOverview: () => fetchData<SemanticOverviewResponse>(getApiUrl('/tables/semantic-search')),
  /** One table's switch, size estimate and build state. */
  semanticStatus: (id: string) =>
    fetchData<SemanticStatus>(getApiUrl(`/tables/${encodeURIComponent(id)}/semantic-search`)),
  /** Turn search by meaning on or off; on above the row cap is a 400 until `confirm: true`. */
  setSemanticSearch: (id: string, input: UpdateSemanticSearchRequest) =>
    fetchData<SemanticStatus>(getApiUrl(`/tables/${encodeURIComponent(id)}/semantic-search`), {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** Embed the table's missing or changed rows now (runs in the background; poll the overview). */
  semanticBackfill: (id: string) =>
    fetchData<SemanticStatus>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/semantic-search/backfill`),
      { method: 'POST' }
    ),
  /** The caller's own undo stack, newest first, with the steps undo and redo would take. */
  history: (limit?: number) =>
    fetchData<TableHistoryResponse>(
      getApiUrl(`/tables/history${limit === undefined ? '' : `?limit=${limit}`}`)
    ),
  /**
   * Undo or redo the caller's next step. With `stepId`, a 409 (`reason:
   * 'stale'`) refuses when that is no longer the next step; any other change
   * since is a 409 too (`TableHistoryConflictDetails`), and nothing changes.
   */
  stepHistory: (direction: 'undo' | 'redo', input: TableHistoryStepRequest = {}) =>
    fetchData<TableHistoryStepResponse>(getApiUrl(`/tables/history/${direction}`), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /**
   * With `focusEntryId`, the page holding that entry (404 if gone); `page` is ignored.
   * With `q`, only matching entries (plus `keep`) are paged, with their `rowNumbers`.
   */
  entries: (id: string, query: TableEntriesQuery = {}) => {
    const params = new URLSearchParams();
    if (query.focusEntryId !== undefined) params.set('focusEntryId', query.focusEntryId);
    else if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if ((query.q || query.where?.length) && query.keep?.length)
      params.set('keep', query.keep.join(','));
    if (query.sort?.length)
      params.set('sort', query.sort.map((s) => `${s.fieldId}:${s.direction}`).join(','));
    if (query.where?.length) params.set('where', JSON.stringify(query.where));
    return fetchData<TableEntriesResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/entries?${params}`)
    );
  },
  /**
   * Name matches first, then other text; an empty `q` lists the first entries.
   * `exclude` drops already-linked entries before paging; `hasMore` pages with `offset`.
   */
  searchEntries: (id: string, query: TableEntrySearchQuery = {}) => {
    const params = new URLSearchParams();
    if (query.q !== undefined) params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    if (query.exclude?.length) params.set('exclude', query.exclude.join(','));
    return fetchData<TableEntrySearchResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/entries/search?${params}`)
    );
  },
  /** Names for up to 200 entry refs across tables; missing entries are left out. */
  resolveEntries: (refs: ResolveTableEntriesRequest['refs']) =>
    fetchData<ResolveTableEntriesResponse>(getApiUrl('/tables/entries/resolve'), {
      method: 'POST',
      body: JSON.stringify({ refs } satisfies ResolveTableEntriesRequest),
    }),
  entry: (id: string, entryId: string) =>
    fetchData<TableEntryResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`)
    ),
  createEntry: (id: string, input: CreateTableEntryRequest) =>
    fetchData<TableEntryResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}/entries`), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /**
   * 1–100 entries created together, in order, as one undo step: right after
   * `afterEntryId` (400 when it is gone) or appended. Idempotent on the ids.
   */
  createEntries: (id: string, input: CreateTableEntriesRequest) =>
    fetchData<CreateTableEntriesResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/entries/batch`),
      { method: 'POST', body: JSON.stringify(input) }
    ),
  updateEntry: (id: string, entryId: string, input: UpdateTableEntryRequest) =>
    fetchData<TableEntryResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`),
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      }
    ),
  /**
   * All or nothing; ids already gone come back in `alreadyDeleted`. A 409's
   * `FetchError.details` carries `entries` (changed since loaded) or
   * `references` (`TableEntryReferenceCount[]`, retry with `clearReferences`).
   */
  deleteEntries: (id: string, input: DeleteTableEntriesRequest) =>
    fetchData<DeleteTableEntriesResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/entries/delete`),
      { method: 'POST', body: JSON.stringify(input) }
    ),
  fields: (id: string) =>
    fetchData<TableFieldsResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}/fields`)),
  selectOptionUsage: (id: string, fieldId: string) =>
    fetchData<TableSelectOptionUsageResponse>(
      getApiUrl(
        `/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/options/usage`
      )
    ),
  createField: (id: string, input: CreateTableFieldRequest) =>
    fetchData<TableFieldResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}/fields`), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateField: (id: string, fieldId: string, input: UpdateTableFieldRequest) =>
    fetchData<TableFieldResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}`),
      { method: 'PATCH', body: JSON.stringify(input) }
    ),
  /** The table's archived fields, newest first. */
  listArchivedFields: (id: string) =>
    fetchData<ArchivedTableFieldsResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/archived`)
    ),
  /** Hide a field, keeping its values; a step in the caller's undo history. */
  archiveField: (id: string, fieldId: string) =>
    fetchData<TableFieldLifecycleResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/archive`),
      { method: 'POST' }
    ),
  /**
   * Bring an archived field back, under `name` when its old one is taken
   * now (a 409 with `reason: 'nameTaken'` otherwise). `madeOptional` says a
   * required field came back optional because entries added meanwhile
   * have no value for it.
   */
  restoreField: (id: string, fieldId: string, input: RestoreTableItemRequest = {}) =>
    fetchData<TableFieldLifecycleResponse & { madeOptional: boolean }>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/restore`),
      { method: 'POST', body: JSON.stringify(input) }
    ),
  /** Delete a field; undoable while the step is in the caller's history. */
  deleteField: (id: string, fieldId: string) =>
    fetchData<TableFieldLifecycleResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/delete`),
      { method: 'POST' }
    ),
  /** Drop a field and every value in it for good, in any state. Not undoable. */
  purgeField: (id: string, fieldId: string) =>
    fetchData<TableFieldLifecycleResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}`),
      { method: 'DELETE' }
    ),
  /** Display order from every field id of the table, managed included. */
  reorderFields: (id: string, input: ReorderTableFieldsRequest) =>
    fetchData<TableFieldsResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}/fields/order`), {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  /** Collapse or expand a field's column; a view preference, so last write wins. */
  setFieldView: (id: string, fieldId: string, input: UpdateTableFieldViewRequest) =>
    fetchData<TableFieldResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/view`),
      { method: 'PATCH', body: JSON.stringify(input) }
    ),
  /**
   * Show any date / datetime field on a calendar ('default' = the Default
   * calendar), managed `created_at` too, or null to take it off.
   * Revision-checked; not a table history step.
   */
  setFieldCalendar: (id: string, fieldId: string, input: SetTableFieldCalendarRequest) =>
    fetchData<TableFieldResponse>(
      getApiUrl(`/tables/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/calendar`),
      { method: 'PUT', body: JSON.stringify(input) }
    ),
  /** Built-in and custom catalog entries. */
  list: () => fetchData<TableListResponse>(getApiUrl('/tables')),
  /** Metadata only — columns and row count, never row contents. */
  get: (id: string) =>
    fetchData<TableDetailResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}`)),
  /** Idempotent on the client-minted id: a retry replays the original create. */
  create: (input: CreateTableRequest) =>
    fetchData<CreateTableResponse>(getApiUrl('/tables'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /**
   * Custom tables only. A 409 is either a taken name or a stale
   * `expectedName`; the stale one carries the current entry in
   * `FetchError.details.table`.
   */
  rename: (id: string, input: RenameTableRequest) =>
    fetchData<RenameTableResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  /**
   * Place a custom table: `projectId` links it to a project or unlinks it
   * (`null` = workspace-wide), landing at the bottom of that list unless
   * `sortOrder` is given; `sortOrder` alone reorders it within its current
   * list. A slot shifts every live table at or after it down by one, and the
   * server announces each moved table with `table.updated`. Only the keys
   * provided are sent; at least one is required. 400 built-in table, bad slot
   * or non-project / archived target, 404 unknown table or project, 409
   * archived table (`FetchError.details.table` carries the current entry when
   * the server has one). Not an undo-history step.
   */
  setPlacement: (id: string, placement: UpdateTablePlacementRequest) =>
    fetchData<SetTableProjectResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      body: JSON.stringify({
        ...(placement.projectId !== undefined ? { projectId: placement.projectId } : {}),
        ...(placement.sortOrder !== undefined ? { sortOrder: placement.sortOrder } : {}),
      } satisfies UpdateTablePlacementRequest),
    }),
  /** Link a custom table to a project, or unlink it (`null`): {@link setPlacement} with no slot. */
  setProject: (id: string, projectId: string | null) =>
    fetchData<SetTableProjectResponse>(getApiUrl(`/tables/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      body: JSON.stringify({ projectId } satisfies UpdateTablePlacementRequest),
    }),
};
