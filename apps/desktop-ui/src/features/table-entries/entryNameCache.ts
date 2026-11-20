import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { TABLE_ENTRY_RESOLVE_MAX } from '@snaglet/shared/types';
import { tablesApi } from '@desktop/utils/api';
import { parseEntryChipId } from '@desktop/utils/nodeChip/entry';
import { subscribeTableEvents } from '@desktop/features/database/tableEvents';

interface EntryName {
  name: string;
  tableName: string | null;
}

interface Snapshot {
  value: EntryName | false | null;
  /** 1-based row number in the table's order; only looked up for unnamed entries. */
  position: number | null;
}

interface CacheEntry {
  ref: { tableId: string; entryId: string };
  snapshot: Snapshot;
  listeners: Set<() => void>;
  generation: number;
  pending: boolean;
  needsLoad: boolean;
  positionGeneration: number;
  positionPending: boolean;
  positionNeedsLoad: boolean;
}

const cache = new Map<string, CacheEntry>();
const MAX_INACTIVE_ENTRIES = 1000;
const MAX_POSITION_LOOKUPS = 4;
/** Positions a displayed table page already knows, for entries not cached yet. */
const primedPositions = new Map<string, number>();
const positionQueue: CacheEntry[] = [];
let positionLookups = 0;
let scheduled = false;
let epoch = 0;
let stopEvents: (() => void) | undefined;
const UNKNOWN = { name: null, tableName: null, unavailable: false, position: null } as const;
export const UNAVAILABLE_ENTRY_LABEL = 'Unavailable entry';

/**
 * The display label for an entry with an empty Name: "Untitled N", where N is
 * its current row number in the table's order. Display only; never stored.
 */
export function untitledEntryLabel(position?: number | null): string {
  return position ? `Untitled ${position}` : 'Untitled';
}

function setSnapshot(entry: CacheEntry, patch: Partial<Snapshot>): void {
  entry.snapshot = { ...entry.snapshot, ...patch };
  for (const listener of entry.listeners) listener();
}

function wantsPosition(entry: CacheEntry): boolean {
  const value = entry.snapshot.value;
  return (
    entry.listeners.size > 0 &&
    entry.positionNeedsLoad &&
    !entry.positionPending &&
    !!value &&
    !value.name.trim()
  );
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const scheduledEpoch = epoch;
  queueMicrotask(() => {
    if (epoch !== scheduledEpoch) return;
    scheduled = false;
    const ready = [...cache.values()].filter(
      (entry) => entry.listeners.size && entry.needsLoad && !entry.pending
    );
    for (let offset = 0; offset < ready.length; offset += TABLE_ENTRY_RESOLVE_MAX) {
      void resolveBatch(ready.slice(offset, offset + TABLE_ENTRY_RESOLVE_MAX));
    }
    for (const entry of cache.values()) {
      if (!wantsPosition(entry)) continue;
      entry.positionPending = true;
      positionQueue.push(entry);
    }
    drainPositions();
  });
}

async function resolveBatch(entries: CacheEntry[]): Promise<void> {
  const requestEpoch = epoch;
  const batch = entries.map((entry) => {
    entry.pending = true;
    entry.needsLoad = false;
    return { entry, generation: entry.generation };
  });
  try {
    const response = await tablesApi.resolveEntries(entries.map((entry) => entry.ref));
    if (requestEpoch !== epoch) return;
    const found = new Map(
      response.entries.map((entry) => [
        `${entry.tableId}/${entry.entryId.toLowerCase()}`,
        { name: entry.name, tableName: entry.tableName },
      ])
    );
    for (const { entry, generation } of batch) {
      // A rename/delete heard after this request began makes its answer stale,
      // including an absent result. Keep the known label until the next load.
      if (entry.generation !== generation) continue;
      setSnapshot(entry, {
        value: found.get(`${entry.ref.tableId}/${entry.ref.entryId}`) ?? false,
      });
    }
  } catch (error: unknown) {
    console.error('[entryNameCache] resolving entry names failed', getErrorMessage(error));
  } finally {
    if (requestEpoch === epoch) {
      for (const { entry } of batch) entry.pending = false;
      pruneInactiveEntries();
      // A failed request is not proof that an entry is gone. Retry on a new
      // subscriber or a relevant event, without a background retry loop.
      schedule();
    }
  }
}

function drainPositions(): void {
  while (positionLookups < MAX_POSITION_LOOKUPS && positionQueue.length) {
    const entry = positionQueue.shift();
    if (entry) void loadPosition(entry);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

/**
 * With a page size of one, the page holding an entry is its row number, so
 * the existing focus read answers without a dedicated endpoint.
 */
async function loadPosition(entry: CacheEntry): Promise<void> {
  const requestEpoch = epoch;
  const generation = entry.positionGeneration;
  positionLookups++;
  entry.positionNeedsLoad = false;
  try {
    if (!entry.listeners.size) {
      entry.positionNeedsLoad = true;
      return;
    }
    const page = await tablesApi.entries(entry.ref.tableId, {
      focusEntryId: entry.ref.entryId,
      pageSize: 1,
    });
    if (requestEpoch !== epoch || entry.positionGeneration !== generation) return;
    setSnapshot(entry, { position: page.page });
  } catch (error: unknown) {
    if (requestEpoch !== epoch) return;
    // A deleted entry surfaces through the name lookup as unavailable.
    if (!isNotFound(error))
      console.error('[entryNameCache] resolving entry positions failed', getErrorMessage(error));
  } finally {
    if (requestEpoch === epoch) {
      positionLookups--;
      entry.positionPending = false;
      drainPositions();
    }
  }
}

function listen(): void {
  if (stopEvents) return;
  stopEvents = subscribeTableEvents((event) => {
    const tableId =
      event.type === 'table.entries.changed' ||
      event.type === 'table.fields.changed' ||
      event.type === 'table.removed'
        ? event.tableId
        : event.type === 'table.updated' || event.type === 'table.restored'
          ? event.table.id
          : null;
    if (!tableId && event.type !== 'tables.invalidated') return;
    for (const key of [...primedPositions.keys()]) {
      if (!tableId || key.startsWith(`${tableId}/`)) primedPositions.delete(key);
    }
    for (const entry of cache.values()) {
      if (tableId && entry.ref.tableId !== tableId) continue;
      entry.generation++;
      entry.needsLoad = true;
      entry.positionGeneration++;
      entry.positionNeedsLoad = true;
    }
    schedule();
  });
}

function pruneInactiveEntries(): void {
  if (cache.size <= MAX_INACTIVE_ENTRIES) return;
  const inactive = [...cache.entries()].filter(
    ([, entry]) => !entry.listeners.size && !entry.pending && !entry.positionPending
  );
  for (const [id] of inactive.slice(0, Math.max(0, inactive.length - MAX_INACTIVE_ENTRIES))) {
    cache.delete(id);
  }
}

function subscribe(
  id: string | null,
  knownName: string | undefined,
  listener: () => void
): () => void {
  if (!id) return () => {};
  const ref = parseEntryChipId(id);
  if (!ref) return () => {};
  listen();
  let entry = cache.get(id);
  if (!entry) {
    const primed = primedPositions.get(id);
    entry = {
      ref,
      snapshot: {
        value: knownName === undefined ? null : { name: knownName, tableName: null },
        position: primed ?? null,
      },
      listeners: new Set(),
      generation: 0,
      pending: false,
      needsLoad: knownName === undefined,
      positionGeneration: 0,
      positionPending: false,
      positionNeedsLoad: primed === undefined,
    };
    cache.set(id, entry);
  } else if (entry.snapshot.value === null && !entry.pending) {
    entry.needsLoad = true;
  }
  entry.listeners.add(listener);
  schedule();
  return () => {
    entry.listeners.delete(listener);
    pruneInactiveEntries();
  };
}

function cacheKey(tableId: string, entryId: string): string | null {
  const ref = parseEntryChipId(`${tableId}/${entryId}`);
  return ref ? `${ref.tableId}/${ref.entryId}` : null;
}

/**
 * Row numbers a table page already knows (its offset plus each row's index),
 * so the page's unnamed entries label their chips without another request.
 */
export function primeEntryPositions(
  tableId: string,
  positions: ReadonlyArray<readonly [entryId: string, position: number]>
): void {
  for (const [entryId, position] of positions) {
    const key = cacheKey(tableId, entryId);
    if (!key) continue;
    primedPositions.delete(key);
    primedPositions.set(key, position);
    const entry = cache.get(key);
    if (!entry) continue;
    entry.positionGeneration++;
    entry.positionNeedsLoad = false;
    if (entry.snapshot.position !== position) setSnapshot(entry, { position });
  }
  for (const key of primedPositions.keys()) {
    if (primedPositions.size <= MAX_INACTIVE_ENTRIES) break;
    primedPositions.delete(key);
  }
}

/** Live resolution for a table/entry identity; null disables the lookup. */
export function useLiveEntryName(
  id: string | null,
  knownName?: string
): {
  name: string | null;
  tableName: string | null;
  unavailable: boolean;
  position: number | null;
} {
  const ref = id ? parseEntryChipId(id) : null;
  const key = ref ? `${ref.tableId}/${ref.entryId}` : null;
  const subscribeToEntry = useCallback(
    (listener: () => void) => subscribe(key, knownName, listener),
    [key, knownName]
  );
  const getSnapshot = useCallback(() => (key ? (cache.get(key)?.snapshot ?? null) : null), [key]);
  const snapshot = useSyncExternalStore(subscribeToEntry, getSnapshot);
  const value = snapshot?.value ?? null;
  const position = snapshot?.position ?? null;
  if (value === false) return { name: null, tableName: null, unavailable: true, position };
  return value ? { ...value, unavailable: false, position } : { ...UNKNOWN, position };
}

/**
 * Live labels for several entries of one table, such as a picker's rows:
 * the Name, "Untitled N" when it is empty, or undefined while unknown. A
 * `knownName` passed to the reader is preferred over the cached one.
 */
export function useLiveEntryLabels(
  tableId: string | null | undefined,
  entries: ReadonlyArray<{ id: string; name?: string }>
): (entryId: string, knownName?: string) => string | undefined {
  const [version, setVersion] = useState(0);
  const refs = tableId
    ? entries.flatMap((entry) => {
        const key = cacheKey(tableId, entry.id);
        return key ? [{ key, name: entry.name }] : [];
      })
    : [];
  const latest = useRef(refs);
  latest.current = refs;
  const signature = refs.map((ref) => `${ref.key}:${ref.name ?? '\u0000'}`).join('\n');
  useEffect(() => {
    const listener = () => setVersion((previous) => previous + 1);
    const stops = latest.current.map((ref) => subscribe(ref.key, ref.name, listener));
    // Subscribing can seed a primed position this render could not see yet.
    listener();
    return () => {
      for (const stop of stops) stop();
    };
  }, [signature]);
  return useCallback(
    (entryId: string, knownName?: string) => {
      const key = tableId ? cacheKey(tableId, entryId) : null;
      const snapshot = key ? cache.get(key)?.snapshot : undefined;
      // A caller's fresh name (a search result) wins; the cache fills gaps.
      if (knownName === undefined && snapshot?.value === false) return UNAVAILABLE_ENTRY_LABEL;
      const name = knownName ?? (snapshot?.value ? snapshot.value.name : undefined);
      if (name === undefined) return undefined;
      return name.trim() || untitledEntryLabel(snapshot?.position);
    },
    // `version` re-creates the reader whenever a subscribed entry changes.
    [tableId, version]
  );
}

/** @public Test isolation without re-importing the rich markdown module graph. */
export function __resetEntryNameCacheForTests(): void {
  epoch++;
  cache.clear();
  primedPositions.clear();
  positionQueue.length = 0;
  positionLookups = 0;
  scheduled = false;
  stopEvents?.();
  stopEvents = undefined;
}
