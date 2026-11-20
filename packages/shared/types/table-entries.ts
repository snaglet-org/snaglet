import type { TableField } from './table-fields';
import type { RelatedTableItems } from './table-references';

/**
 * Exact decimals and dates cross the wire as strings; keys are stable field
 * ids. A relation's value is an entry UUID, or the id of a Snaglet item for a
 * relation with a `referenceKind` (`doc-…`, an agent slug, …). A multiple
 * relation's value is an ordered list of them (`[]` when empty; writing null
 * stores `[]`).
 */
export type TableEntryValue = string | boolean | null | string[];
export type TableEntryValues = Record<string, TableEntryValue>;

export interface TableEntry {
  id: string;
  createdAt: string;
  /** Opaque optimistic concurrency token; never interpret or mint on the client. */
  revision: string;
  values: TableEntryValues;
}

export const TABLE_ENTRY_PAGE_SIZES = [10, 25, 50, 100] as const;
export const TABLE_ENTRY_DEFAULT_PAGE_SIZE = 25;
export const TABLE_ENTRY_MAX_PAGE_SIZE = 100;
export const TABLE_ENTRY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest `q` a filtered entry list accepts, in characters. */
export const TABLE_ENTRY_FILTER_QUERY_MAX_LENGTH = 200;
/** Most words (or "quoted phrases") one filter may combine. */
export const TABLE_ENTRY_FILTER_MAX_TERMS = 16;
/** Most entry ids a filtered list may keep listed without matching. */
export const TABLE_ENTRY_FILTER_MAX_KEEP = 100;

/** Most sorts one entries read may combine. */
export const TABLE_ENTRY_SORT_MAX = 8;

/**
 * One level of a multi-level sort, by field id. Levels apply in order: the
 * first decides, each next only breaks the ties left above it. Text sorts
 * A–Z (desc Z–A), a select by its option order, numbers low–high, dates and
 * datetimes oldest–newest, a checkbox unchecked before checked (desc puts
 * checked first). Empty values are last in both directions; any remaining
 * tie keeps the table's own row order.
 */
export interface TableEntrySort {
  fieldId: string;
  direction: 'asc' | 'desc';
}

/** Most filter conditions one entries read may combine. */
export const TABLE_ENTRY_WHERE_MAX = 20;

/**
 * Filter operators, by field type:
 * - text: contains, not_contains, is, is_not, starts_with, ends_with
 * - number: eq, neq, gt, gte, lt, lte
 * - select: is, is_not (one value); contains, not_contains (multi-select)
 * - date, datetime: is, before, after, on_or_before, on_or_after (by day,
 *   a datetime in the user's time zone)
 * - checkbox: is (value true or false)
 * - every type, relations included: is_empty, is_not_empty
 */
export const TABLE_ENTRY_WHERE_OPERATORS = [
  'contains',
  'not_contains',
  'is',
  'is_not',
  'starts_with',
  'ends_with',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'is_empty',
  'is_not_empty',
] as const;
export type TableEntryWhereOperator = (typeof TABLE_ENTRY_WHERE_OPERATORS)[number];

/**
 * One filter condition on a field. Conditions combine with AND. `value` is
 * text for text, select labels, numbers (decimal text) and dates
 * (`YYYY-MM-DD`), a boolean for a checkbox, and absent for is_empty /
 * is_not_empty. "Not" operators also match empty values.
 */
export interface TableEntryWhere {
  fieldId: string;
  operator: TableEntryWhereOperator;
  value?: string | boolean;
}

export interface TableEntriesQuery {
  /** One-based page. */
  page?: number;
  pageSize?: number;
  /** Return the page holding this entry (in row order) instead of `page`. Not with `q`. */
  focusEntryId?: string;
  /**
   * Keep only entries matching every word (or "quoted phrase") of `q` in some
   * field, still in row order; `page`, `pageSize` and `totalCount` then count
   * matches. The Name matches fuzzily (a typo still finds it), text and select
   * labels by substring, numbers by their digits, dates and datetimes by an
   * ISO prefix (`2026-09`), and relations by the linked entry's Name or Snaglet
   * item's title. Blank lists every entry.
   */
  q?: string;
  /**
   * Entries listed with `q` even when they do not match, such as rows created
   * or edited while filtering (at most 100). Ignored without `q`.
   */
  keep?: string[];
  /**
   * Order by these levels instead of row order (at most TABLE_ENTRY_SORT_MAX,
   * each field once; multi-value fields are not sortable). Not with
   * `focusEntryId`. Row numbers stay the table's own order.
   */
  sort?: TableEntrySort[];
  /**
   * Only entries meeting every condition (at most TABLE_ENTRY_WHERE_MAX).
   * Combines with `q`, `sort` and `focusEntryId`; filtered pages carry
   * `rowNumbers` like a search.
   */
  where?: TableEntryWhere[];
}

/**
 * Names of the entries that relation values point at, keyed by the target
 * table id and then the entry id (UUIDs can repeat across tables). Targets
 * that no longer exist are absent. '' means the entry is unnamed.
 */
export type RelatedTableEntries = Record<string, Record<string, { name: string }>>;

export interface TableEntriesResponse {
  entries: TableEntry[];
  fields: TableField[];
  totalCount: number;
  page: number;
  pageSize: number;
  schemaVersion: string;
  relatedEntries: RelatedTableEntries;
  /** Titles of the Snaglet items kind relations link to (one query per kind). */
  relatedItems: RelatedTableItems;
  /**
   * Present only when `q` filters the list: each listed entry's one-based row
   * number in the whole table's order, keyed by entry id, so "Untitled N"
   * labels stay the same with or without a filter.
   */
  rowNumbers?: Record<string, number>;
}

export interface TableEntryResponse {
  entry: TableEntry;
  schemaVersion: string;
  relatedEntries: RelatedTableEntries;
  /** As on {@link TableEntriesResponse}; also in a 409's details. */
  relatedItems: RelatedTableItems;
}

/** An entry anywhere in the Database: its catalog table id and entry UUID. */
export interface TableEntryRef {
  tableId: string;
  entryId: string;
}

/** Most refs one resolve request may name. */
export const TABLE_ENTRY_RESOLVE_MAX = 200;

export interface ResolveTableEntriesRequest {
  /** 1–200 refs. */
  refs: TableEntryRef[];
}

export interface ResolveTableEntriesResponse {
  /** Refs that exist in custom tables; missing entries and tables are absent. */
  entries: Array<TableEntryRef & { name: string; tableName: string }>;
}

export const TABLE_ENTRY_SEARCH_DEFAULT_LIMIT = 20;
export const TABLE_ENTRY_SEARCH_MAX_LIMIT = 50;
export const TABLE_ENTRY_SEARCH_QUERY_MAX_LENGTH = 200;
/** Most entry ids one search may exclude (a multiple relation's link cap). */
export const TABLE_ENTRY_SEARCH_MAX_EXCLUDE = 100;
/** Deepest result a search can page to. */
export const TABLE_ENTRY_SEARCH_MAX_OFFSET = 10_000;

export interface TableEntrySearchQuery {
  /** Trimmed; empty lists the first entries in row order. */
  q?: string;
  /** 1–50, default 20. */
  limit?: number;
  /** Results to skip, 0–10,000, default 0. */
  offset?: number;
  /** Entry ids left out of the results, e.g. ones a relation already links (at most 100). */
  exclude?: string[];
}

export interface TableEntrySearchResult {
  id: string;
  name: string;
  /**
   * Up to two other text, number, date or datetime values (a datetime as
   * `YYYY-MM-DD HH:MM` in the user's time zone), joined with " · ".
   */
  preview: string;
}

export interface TableEntrySearchResponse {
  results: TableEntrySearchResult[];
  /** More matches follow; ask again with `offset` advanced by `results.length`. */
  hasMore: boolean;
}

export interface CreateTableEntryRequest {
  /** Stable client-minted UUID, reused for every retry of this creation. */
  id: string;
  values: TableEntryValues;
  schemaVersion: string;
  /** Insert immediately before this entry; omit to append in creation order. */
  beforeEntryId?: string;
}

/** Most entries one batch create may add: a full page of the grid. */
export const TABLE_ENTRY_CREATE_MAX = 100;

export interface CreateTableEntriesRequest {
  /**
   * 1–100 new entries, created in this order. Each id is client-minted and
   * reused on a retry, which replays it like a single create.
   */
  entries: Array<Pick<CreateTableEntryRequest, 'id' | 'values'>>;
  schemaVersion: string;
  /** Place them, in order, right after this entry; omit to append them. */
  afterEntryId?: string;
}

export interface CreateTableEntriesResponse {
  /** The entries in request order (a replayed one as it is saved). */
  entries: TableEntry[];
  schemaVersion: string;
  relatedEntries: RelatedTableEntries;
  relatedItems: RelatedTableItems;
}

export interface UpdateTableEntryRequest {
  /** Sparse patch; omitted fields retain their saved values. */
  values: TableEntryValues;
  schemaVersion: string;
  expectedRevision: string;
}

/** Most entries one delete request may name. */
export const TABLE_ENTRY_DELETE_MAX = 500;

export interface DeleteTableEntriesRequest {
  /** 1–500 unique entry UUIDs, deleted together or not at all. */
  entryIds: string[];
  /** Revisions the caller saw, by entry id; a changed entry refuses the delete (409). */
  expectedRevisions?: Record<string, string>;
  /** Clear other entries' links to the deleted entries instead of refusing (409). */
  clearReferences?: boolean;
}

/** Entries of one relation field that link to entries being deleted. */
export interface TableEntryReferenceCount {
  tableId: string;
  tableName: string;
  fieldId: string;
  fieldName: string;
  count: number;
}

export interface DeleteTableEntriesResponse {
  deletedIds: string[];
  /** Requested ids that no longer exist, e.g. deleted by an earlier attempt. */
  alreadyDeleted: string[];
  clearedReferences: { tableId: string; fieldId: string; count: number }[];
}
