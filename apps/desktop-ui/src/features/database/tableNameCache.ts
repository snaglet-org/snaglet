/**
 * Live table names for rendered table chips and table pane titles.
 *
 * Chip markdown freezes the title a chip was inserted with. Table chips show
 * the catalog's current name instead, so a rename updates every rendered chip
 * and a chip whose table is gone reads as unavailable rather than showing a
 * stale name. An archived table is not gone: it keeps its name, marked
 * archived, until it is restored or deleted for good.
 *
 * The catalog (and the archived custom tables) loads lazily when the first
 * table chip or pane renders, then follows `table.created` / `table.updated`
 * / `table.restored` (local and realtime) by catalog id; `table.removed`
 * marks a table archived or drops a deleted one, and `tables.invalidated`
 * refetches. A failed load changes nothing: a chip is only unavailable once
 * a catalog has loaded without its id.
 *
 * It also answers which table a name is, for rows linked as
 * `[Title](<table name>:<entry uuid>)` (see nodeRef's parseNodeRef).
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { archiveApi, tablesApi } from '@desktop/utils/api';
import { subscribeTableEvents } from './tableEvents';
import { tableEntryState } from './tableLifecycle';

/** Catalog id → current entry; `null` until the first successful load. */
let entries: Map<string, TableCatalogEntry> | null = null;
/** Catalog id → an archived custom table's entry (`state: 'archived'`). */
let archived = new Map<string, TableCatalogEntry>();
/** Entries heard before the first load or while a load is in flight. */
let heard = new Map<string, TableCatalogEntry>();
let pending: Promise<void> | null = null;
let reloadAfterPending = false;
let listeningToEvents = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function applyEntry(table: TableCatalogEntry): void {
  if (pending || !entries) heard.set(table.id, table);
  entries?.set(table.id, table);
  archived.delete(table.id);
  notify();
}

/**
 * Keep an archived table's last known name; forget a deleted one. Returns
 * whether the cache knew the table at all.
 */
function applyRemoval(tableId: string, state: 'archived' | 'deleted'): boolean {
  const known = entries?.get(tableId) ?? heard.get(tableId) ?? archived.get(tableId);
  heard.delete(tableId);
  entries?.delete(tableId);
  if (state === 'archived' && known) archived.set(tableId, { ...known, state: 'archived' });
  else archived.delete(tableId);
  notify();
  return known !== undefined;
}

/** Archived custom tables, or `null` when they could not be read. */
function loadArchived(): Promise<TableCatalogEntry[] | null> {
  // Deferred so a synchronous throw lands in the catch, not in the caller.
  return Promise.resolve()
    .then(() => archiveApi.tables())
    .then(
      (response) => response.tables,
      () => null
    );
}

function load(): Promise<void> {
  if (pending) return pending;
  pending = Promise.all([tablesApi.list(), loadArchived()])
    .then(([response, archivedTables]) => {
      const next = new Map(
        response.tables
          .filter((table) => tableEntryState(table) === 'active')
          .map((table) => [table.id, table])
      );
      // Events heard while the request was in flight may be newer than it.
      for (const [id, table] of heard) next.set(id, table);
      entries = next;
      heard = new Map();
      // Without the archived list, keep the names archive events left.
      if (archivedTables) {
        archived = new Map(
          archivedTables.map((table) => [table.id, { ...table, state: 'archived' as const }])
        );
      }
      for (const id of next.keys()) archived.delete(id);
    })
    .catch((err: unknown) => {
      console.error('[tableNameCache] loading the table catalog failed', getErrorMessage(err));
    })
    .finally(() => {
      pending = null;
      notify();
      if (reloadAfterPending) {
        reloadAfterPending = false;
        void load();
      }
    });
  return pending;
}

function listenToTableEvents(): void {
  if (listeningToEvents) return;
  listeningToEvents = true;
  subscribeTableEvents((event) => {
    if (
      event.type === 'table.created' ||
      event.type === 'table.updated' ||
      event.type === 'table.restored'
    ) {
      applyEntry(event.table);
    } else if (event.type === 'table.removed') {
      const known = applyRemoval(event.tableId, event.state);
      // A load in flight may predate the removal, so it reloads once it
      // settles; an archived table this cache never saw needs its name read.
      if (pending) reloadAfterPending = true;
      else if (!known && event.state === 'archived' && entries) void load();
    } else if (event.type === 'tables.invalidated') {
      if (pending) reloadAfterPending = true;
      else void load();
    }
  });
}

/** Load the catalog once; later calls resolve immediately. */
export function ensureTableNames(): Promise<void> {
  listenToTableEvents();
  return entries ? Promise.resolve() : load();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: forget the loaded catalog so each case starts unloaded, without
 * re-importing the chip renderer graph. Tagged `@public` because Knip does not
 * scan test files.
 * @public
 */
export function __resetTableNameCacheForTests(): void {
  entries = null;
  archived = new Map();
  heard = new Map();
  pending = null;
  reloadAfterPending = false;
}

/** The cached active catalog entry for an id, when one has been loaded or heard. */
export function getCachedTableEntry(tableId: string): TableCatalogEntry | null {
  return entries?.get(tableId) ?? heard.get(tableId) ?? null;
}

/** Whether the catalog has loaded once, so a lookup by name can be trusted. */
export function tableNamesLoaded(): boolean {
  return entries !== null;
}

/**
 * The table with this name (active, else archived), matched case-insensitively
 * as table names are unique; `null` when none is loaded or heard.
 */
export function getCachedTableByName(name: string): TableCatalogEntry | null {
  const wanted = name.toLowerCase();
  for (const source of [entries, heard, archived]) {
    for (const table of source?.values() ?? []) {
      if (table.name.toLowerCase() === wanted) return table;
    }
  }
  return null;
}

/**
 * The entry (active, else archived), `false` when a loaded catalog has
 * neither, `null` when not yet known. Entries are stable map values, so the
 * snapshot only changes when the cache does.
 */
function snapshotFor(tableId: string): TableCatalogEntry | false | null {
  const entry = getCachedTableEntry(tableId) ?? archived.get(tableId);
  if (entry) return entry;
  return entries ? false : null;
}

export interface LiveTableName {
  /** The current name (an archived table's last one), or `null` while unknown or unavailable. */
  name: string | null;
  /** The catalog loaded and this id is in neither the catalog nor the archive. */
  unavailable: boolean;
  /** The table is archived; it restores from the Archived drawer. */
  archived: boolean;
}

/** Label a table chip shows once its table is gone. */
export const UNAVAILABLE_TABLE_LABEL = 'Unavailable table';

const UNKNOWN: LiveTableName = { name: null, unavailable: false, archived: false };
const UNAVAILABLE: LiveTableName = { name: null, unavailable: true, archived: false };

/** Live name of a table chip's catalog entry. Pass `null` for non-table chips. */
export function useLiveTableName(tableId: string | null): LiveTableName {
  const snapshot = useSyncExternalStore(subscribe, () => (tableId ? snapshotFor(tableId) : null));
  useEffect(() => {
    if (tableId) void ensureTableNames();
  }, [tableId]);
  if (snapshot === false) return UNAVAILABLE;
  if (!snapshot) return UNKNOWN;
  return {
    name: snapshot.name,
    unavailable: false,
    archived: tableEntryState(snapshot) === 'archived',
  };
}
