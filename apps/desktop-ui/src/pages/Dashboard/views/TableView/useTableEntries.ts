import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TABLE_ENTRY_DEFAULT_PAGE_SIZE,
  TABLE_ENTRY_FILTER_MAX_KEEP,
  TABLE_ENTRY_PAGE_SIZES,
  type TableEntriesQuery,
  type TableEntriesResponse,
  type TableEntry,
  type TableEntrySort,
  type TableEntryWhere,
  type TableField,
} from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { subscribeTableEvents } from '@desktop/features/database';
import { syncRelatedItems } from '@desktop/features/table-entries/snagletItemTitles';
import { tablesApi } from '@desktop/utils/api';

const PAGE_SIZE_KEY = 'snaglet.database.entries.pageSize';

function initialPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return TABLE_ENTRY_PAGE_SIZES.some((size) => size === stored)
      ? stored
      : TABLE_ENTRY_DEFAULT_PAGE_SIZE;
  } catch {
    return TABLE_ENTRY_DEFAULT_PAGE_SIZE;
  }
}

/** The search part of a page read; `keep` only matters with a query. */
function filterQuery(q: string, keep: readonly string[]): Pick<TableEntriesQuery, 'q' | 'keep'> {
  if (!q) return {};
  return keep.length ? { q, keep: [...keep] } : { q };
}

function sortQuery(sort: readonly TableEntrySort[]): Pick<TableEntriesQuery, 'sort'> {
  return sort.length ? { sort: [...sort] } : {};
}

/** Field filters; entries saved under them stay listed (`keep`) like under a search. */
function whereQuery(
  where: readonly TableEntryWhere[],
  keep: readonly string[] = []
): Pick<TableEntriesQuery, 'where' | 'keep'> {
  if (!where.length) return {};
  return keep.length ? { where: [...where], keep: [...keep] } : { where: [...where] };
}

function sortFromKey(key: string): TableEntrySort[] {
  if (!key) return [];
  return key.split(',').map((part) => {
    const at = part.lastIndexOf(':');
    return {
      fieldId: part.slice(0, at),
      direction: part.slice(at + 1) === 'desc' ? 'desc' : 'asc',
    };
  });
}

type ReadOutcome = { page: TableEntriesResponse } | { error: unknown };

interface PageWaiter {
  after: number;
  resolve: (page: TableEntriesResponse | null) => void;
  reject: (err: unknown) => void;
}

interface Location {
  page: number;
  focusEntryId?: string;
  /** The applied search; '' lists every entry. Opening an entry clears it. */
  q: string;
}

/**
 * One table's paged entries. `q` filters them on the server (`setQuery`
 * returns to the first page); entries saved while filtering stay listed
 * until the query changes (`keepEntry`).
 */
export function useTableEntries(
  tableId: string,
  options: {
    initialQuery?: string;
    sort?: readonly TableEntrySort[];
    where?: readonly TableEntryWhere[];
  } = {}
) {
  // Filters, like sorts, re-read only when their content changes.
  const whereKey = JSON.stringify(options.where ?? []);
  const whereRef = useRef<TableEntryWhere[]>([]);
  whereRef.current = JSON.parse(whereKey) as TableEntryWhere[];
  // A stable key, so a new array with the same levels does not re-read.
  const sortKey = (options.sort ?? []).map((s) => `${s.fieldId}:${s.direction}`).join(',');
  const sortRef = useRef<TableEntrySort[]>([]);
  sortRef.current = sortFromKey(sortKey);
  const [location, setLocation] = useState<Location>(() => ({
    page: 1,
    q: options.initialQuery?.trim() ?? '',
  }));
  const locationRef = useRef(location);
  locationRef.current = location;
  const consumedFocus = useRef<Location | null>(null);
  /** Entries created or edited under the current query; listed even when they stop matching. */
  const kept = useRef<string[]>([]);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [result, setResult] = useState<TableEntriesResponse | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  const page = location.focusEntryId ? (result?.page ?? location.page) : location.page;
  const [focusError, setFocusError] = useState<string | null>(null);
  const [focusedEntry, setFocusedEntry] = useState<{ id: string; request: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const requestGeneration = useRef(0);
  const [completedRequest, setCompletedRequest] = useState(0);
  const latestRequest = useCallback(() => requestGeneration.current, []);
  const followAppend = useRef(false);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const mounted = useRef(true);
  /** Newest read started, and the newest read that finished (with its outcome). */
  const startedRead = useRef(0);
  const settledRead = useRef<{ generation: number; outcome: ReadOutcome } | null>(null);
  const pageWaiters = useRef(new Set<PageWaiter>());

  const settleRead = useCallback((generation: number, outcome: ReadOutcome) => {
    if (!settledRead.current || settledRead.current.generation < generation)
      settledRead.current = { generation, outcome };
    for (const waiter of pageWaiters.current) {
      if (generation <= waiter.after) continue;
      pageWaiters.current.delete(waiter);
      if ('page' in outcome) waiter.resolve(outcome.page);
      else waiter.reject(outcome.error);
    }
  }, []);

  /** The first read to finish after `after` supersedes it, successful or not. */
  const newerPage = useCallback(
    (after: number): Promise<TableEntriesResponse | null> => {
      if (!mounted.current) return Promise.resolve(null);
      const settled = settledRead.current;
      if (settled && settled.generation > after)
        return 'page' in settled.outcome
          ? Promise.resolve(settled.outcome.page)
          : Promise.reject(settled.outcome.error);
      return new Promise((resolve, reject) => {
        pageWaiters.current.add({ after, resolve, reject });
        // A local patch (a saved row or a deletion) can supersede a read without
        // starting another one; make sure a newer read follows.
        if (startedRead.current <= after) reload();
      });
    },
    [reload]
  );

  useEffect(() => {
    mounted.current = true;
    const waiters = pageWaiters.current;
    return () => {
      mounted.current = false;
      for (const waiter of waiters) waiter.resolve(null);
      waiters.clear();
    };
  }, []);
  // A new sort starts over from the first page, like a new search.
  const appliedSort = useRef(`${sortKey}|${whereKey}`);
  useEffect(() => {
    const key = `${sortKey}|${whereKey}`;
    if (appliedSort.current === key) return;
    appliedSort.current = key;
    kept.current = [];
    setLocation((current) => (current.page === 1 ? current : { page: 1, q: current.q }));
  }, [sortKey, whereKey]);
  const setPage = useCallback((next: number) => {
    setLocation((current) => ({ page: next, q: current.q }));
    setFocusError(null);
    setFocusedEntry(null);
  }, []);
  /** Opening an entry shows it in the whole table, so it clears the search. */
  const focusEntry = useCallback((entryId: string) => {
    setFocusError(null);
    setFocusedEntry(null);
    kept.current = [];
    setLocation({ page: resultRef.current?.page ?? 1, focusEntryId: entryId, q: '' });
  }, []);
  /** Apply a search (trimmed) from the first page; the same query is a no-op. */
  const setQuery = useCallback((next: string) => {
    const q = next.trim();
    if (q === locationRef.current.q) return;
    kept.current = [];
    setFocusError(null);
    setFocusedEntry(null);
    setLocation({ page: 1, q });
  }, []);
  /** Keep a saved entry listed under the current query, even once it stops matching. */
  const keepEntry = useCallback((entryId: string) => {
    if (!locationRef.current.q && !whereRef.current.length) return;
    kept.current = [entryId, ...kept.current.filter((id) => id !== entryId)].slice(
      0,
      TABLE_ENTRY_FILTER_MAX_KEEP
    );
  }, []);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [tableId]
  );

  /**
   * Schema changes also invalidate every row revision, not just field metadata.
   * Resolves with this read, or with a newer read that superseded it (such as a
   * realtime reload); null only once the grid has unmounted.
   */
  const refreshPage = useCallback(async (): Promise<TableEntriesResponse | null> => {
    const generation = ++requestGeneration.current;
    startedRead.current = generation;
    setLoading(true);
    setError(null);
    let next: TableEntriesResponse;
    try {
      next = await tablesApi.entries(tableId, {
        page: resultRef.current?.page ?? page,
        pageSize,
        ...filterQuery(location.q, kept.current),
        ...sortQuery(sortRef.current),
        ...whereQuery(whereRef.current, kept.current),
      });
    } catch (err) {
      if (generation !== requestGeneration.current) return newerPage(generation);
      setError(getErrorMessage(err, 'Could not refresh entries'));
      setLoading(false);
      settleRead(generation, { error: err });
      throw err;
    }
    if (generation !== requestGeneration.current) return newerPage(generation);
    syncRelatedItems(next.fields, next.entries, next.relatedItems);
    setResult(next);
    setCompletedRequest(generation);
    setLoading(false);
    settleRead(generation, { page: next });
    return next;
  }, [tableId, page, pageSize, location.q, sortKey, whereKey, newerPage, settleRead]);

  useEffect(
    () =>
      subscribeTableEvents((event) => {
        if (
          event.type === 'tables.invalidated' ||
          ((event.type === 'table.entries.changed' || event.type === 'table.fields.changed') &&
            event.tableId === tableId)
        )
          reload();
      }),
    [tableId, reload]
  );

  useEffect(() => {
    let canceled = false;
    const generation = ++requestGeneration.current;
    startedRead.current = generation;
    const isCurrent = () => !canceled && generation === requestGeneration.current;
    setLoading(true);
    setError(null);
    const seeking = location.focusEntryId && consumedFocus.current !== location;
    const requestedPage = location.focusEntryId
      ? (resultRef.current?.page ?? location.page)
      : location.page;
    tablesApi
      .entries(
        tableId,
        seeking
          ? {
              focusEntryId: location.focusEntryId,
              pageSize,
              ...sortQuery(sortRef.current),
              ...whereQuery(whereRef.current),
            }
          : {
              page: requestedPage,
              pageSize,
              ...filterQuery(location.q, kept.current),
              ...sortQuery(sortRef.current),
              ...whereQuery(whereRef.current, kept.current),
            }
      )
      .then((next) => {
        if (!isCurrent()) return;
        const lastPage = Math.max(1, Math.ceil(next.totalCount / pageSize));
        if (!seeking && requestedPage > lastPage) {
          setPage(lastPage);
          return;
        }
        if (seeking && location.focusEntryId) {
          consumedFocus.current = location;
          setFocusedEntry({ id: location.focusEntryId, request: generation });
        }
        syncRelatedItems(next.fields, next.entries, next.relatedItems);
        setResult(next);
        setCompletedRequest(generation);
        settleRead(generation, { page: next });
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        settleRead(generation, { error: err });
        if (seeking) {
          consumedFocus.current = location;
          setFocusError(getErrorMessage(err, 'Could not open this entry'));
          // A direct link can be the pane's first read. Still load its table
          // when the entry is gone, keeping the seek error available to retry.
          if (!resultRef.current) setNonce((value) => value + 1);
        } else setError(getErrorMessage(err, 'Could not load entries'));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [tableId, location, pageSize, sortKey, whereKey, nonce, setPage, settleRead]);

  useEffect(() => {
    if (!result) return;
    const lastPage = Math.max(1, Math.ceil(result.totalCount / pageSize));
    // Use the committed, functional insertion total. Queued creates can
    // complete within one render and cannot each rely on an old page count.
    if (followAppend.current) {
      followAppend.current = false;
      if (page !== lastPage) setPage(lastPage);
    } else if (page > lastPage) setPage(lastPage);
  }, [result, page, pageSize, setPage]);

  /**
   * Patch a saved entry into the current page so it never flashes stale
   * values (or a stale revision) before the reload that follows every save.
   * A new entry is inserted before `beforeEntryId`, or appended.
   */
  const upsertEntry = useCallback((entry: TableEntry, insert?: { beforeEntryId?: string }) => {
    // A read begun before this successful write must not restore its old
    // value/revision before the event-triggered replacement load starts.
    requestGeneration.current += 1;
    setLoading(false);
    setError(null);
    if (insert && !insert.beforeEntryId) followAppend.current = true;
    setResult((current) => {
      if (!current) return current;
      const index = current.entries.findIndex((item) => item.id === entry.id);
      const entries = [...current.entries];
      if (index >= 0) {
        entries[index] = entry;
        return { ...current, entries };
      }
      if (!insert) return current;
      const before = insert.beforeEntryId
        ? entries.findIndex((item) => item.id === insert.beforeEntryId)
        : -1;
      entries.splice(before >= 0 ? before : entries.length, 0, entry);
      return { ...current, entries, totalCount: current.totalCount + 1 };
    });
  }, []);

  /**
   * Patch just-created entries (a paste) into the current page, in order,
   * right after `afterEntryId` or at the page's end, until the reload that
   * follows. `follow` moves to the last page, where appended entries are.
   */
  const insertEntries = useCallback(
    (added: readonly TableEntry[], placement: { afterEntryId?: string; follow?: boolean } = {}) => {
      if (!added.length) return;
      requestGeneration.current += 1;
      setLoading(false);
      setError(null);
      if (placement.follow) followAppend.current = true;
      setResult((current) => {
        if (!current) return current;
        const listed = new Set(current.entries.map((entry) => entry.id));
        const fresh = added.filter((entry) => !listed.has(entry.id));
        if (!fresh.length) return current;
        const entries = [...current.entries];
        const after = placement.afterEntryId
          ? entries.findIndex((entry) => entry.id === placement.afterEntryId)
          : -1;
        entries.splice(after >= 0 ? after + 1 : entries.length, 0, ...fresh);
        return { ...current, entries, totalCount: current.totalCount + fresh.length };
      });
    },
    []
  );

  /** Adopt a field list the server just returned (a column reorder). */
  const replaceFields = useCallback(
    (fields: TableField[]) => setResult((current) => (current ? { ...current, fields } : current)),
    []
  );

  /** Apply a confirmed deletion without waiting for the follow-up reload. */
  const removeEntries = useCallback((ids: readonly string[]) => {
    if (!ids.length) return;
    // A request started before deletion may still contain those rows. Only
    // invalidate that generation; later authoritative reads may reuse an id.
    requestGeneration.current += 1;
    setLoading(false);
    setError(null);
    const removed = new Set(ids);
    setResult((current) => {
      if (!current) return current;
      const entries = current.entries.filter((entry) => !removed.has(entry.id));
      const count = current.entries.length - entries.length;
      if (!count) return current;
      return { ...current, entries, totalCount: Math.max(0, current.totalCount - count) };
    });
  }, []);

  const changePageSize = (size: number) => {
    if (!TABLE_ENTRY_PAGE_SIZES.some((option) => option === size)) return;
    setPage(1);
    setPageSize(size);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      /* Preferences are optional. */
    }
  };

  return {
    result,
    q: location.q,
    /** The shown page was read with a search, so it lists matches only. */
    filtered: result?.rowNumbers !== undefined,
    setQuery,
    keepEntry,
    latestRequest,
    completedRequest,
    page,
    pageSize,
    loading,
    seeking: !!location.focusEntryId && consumedFocus.current !== location,
    error,
    focusError,
    focusedEntry,
    focusEntry,
    setPage,
    changePageSize,
    reload,
    refreshPage,
    upsertEntry,
    insertEntries,
    removeEntries,
    replaceFields,
  };
}
