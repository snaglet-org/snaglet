/**
 * The app's one table catalog: the workspace tree's project groups, the
 * Database sidebar, every project pane's Tables section, the relation field
 * editor and the wiki preview all read it.
 *
 * Module-level store, same pattern as `./projectList`: `GET /tables` runs
 * once for every mounted reader and the result is shared. It loads lazily
 * the first time a reader mounts `enabled`, then stays cached, so switching
 * sidebar modes or opening a second project pane never refetches or loses
 * rows. `table.created`, `table.updated` and `table.restored` events (local
 * creates/renames/restores and realtime broadcasts) upsert by catalog id, so
 * the originating client's own echo is a no-op and a rename patches its row
 * in place; `table.removed` (archive or delete) drops the row. Events heard
 * while a load is in flight are merged into its result, and the list never
 * shows an archived entry.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { tablesApi } from '@desktop/utils/api';
import { subscribeTableEvents } from './tableEvents';
import { tableEntryState } from './tableLifecycle';

export interface TableCatalogState {
  /** `null` until the first successful load. */
  tables: TableCatalogEntry[] | null;
  error: string | null;
  reload: () => void;
}

interface CatalogSnapshot {
  tables: TableCatalogEntry[] | null;
  error: string | null;
}

function upsert(tables: TableCatalogEntry[], table: TableCatalogEntry): TableCatalogEntry[] {
  const index = tables.findIndex((entry) => entry.id === table.id);
  if (index < 0) return [...tables, table];
  const next = tables.slice();
  next[index] = table;
  return next;
}

let state: CatalogSnapshot = { tables: null, error: null };
let pending: Promise<void> | null = null;
let reloadAfterPending = false;
/** Latches true the first time an enabled reader mounts. */
let requested = false;
let listening = false;
const listeners = new Set<() => void>();
/** Entries heard created/updated/restored while a load is in flight. */
let heard: TableCatalogEntry[] = [];
/** Ids heard removed while a load is in flight; its listing must not bring them back. */
let removed = new Set<string>();

function setState(next: CatalogSnapshot): void {
  state = next;
  for (const listener of listeners) listener();
}

function load(): Promise<void> {
  if (pending) return pending;
  if (state.error) setState({ ...state, error: null });
  // Deferred so a synchronous throw lands in the catch, not in the caller.
  pending = Promise.resolve()
    .then(() => tablesApi.list())
    .then((response) => {
      const listed = response.tables.filter(
        (entry) => tableEntryState(entry) === 'active' && !removed.has(entry.id)
      );
      setState({ tables: heard.reduce(upsert, listed), error: null });
    })
    .catch((err: unknown) => {
      setState({ ...state, error: getErrorMessage(err, 'Could not load tables') });
    })
    .finally(() => {
      pending = null;
      // Later events patch the loaded list directly; a reload starts clean.
      heard = [];
      removed = new Set();
      if (reloadAfterPending) {
        reloadAfterPending = false;
        void load();
      }
    });
  return pending;
}

/** Refetch, or queue one refetch behind the load in flight. */
function reloadTables(): void {
  if (!requested) return;
  if (pending) reloadAfterPending = true;
  else void load();
}

function listenToTableEvents(): void {
  if (listening) return;
  listening = true;
  subscribeTableEvents((event) => {
    switch (event.type) {
      case 'tables.invalidated':
        heard = [];
        removed = new Set();
        reloadTables();
        return;
      case 'table.removed': {
        const { tableId } = event;
        if (pending) {
          removed.add(tableId);
          heard = heard.filter((entry) => entry.id !== tableId);
        }
        if (state.tables?.some((entry) => entry.id === tableId)) {
          setState({ ...state, tables: state.tables.filter((entry) => entry.id !== tableId) });
        }
        return;
      }
      case 'table.created':
      case 'table.updated':
      case 'table.restored':
        if (pending) {
          removed.delete(event.table.id);
          heard = upsert(heard, event.table);
        }
        if (state.tables) setState({ ...state, tables: upsert(state.tables, event.table) });
        return;
      default:
        return;
    }
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test-only: forget the loaded catalog so each case starts unloaded.
 * Tagged `@public` because Knip does not scan test files.
 * @public
 */
export function __resetTableCatalogForTests(): void {
  state = { tables: null, error: null };
  pending = null;
  reloadAfterPending = false;
  requested = false;
  heard = [];
  removed = new Set();
}

/**
 * The shared table catalog. An `enabled` reader triggers the first load; a
 * disabled one never fetches but still reads whatever is cached.
 */
export function useTableCatalog(enabled: boolean): TableCatalogState {
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    listenToTableEvents();
    if (!enabled) return;
    requested = true;
    if (!state.tables && !pending) void load();
  }, [enabled]);
  return useMemo(() => ({ ...snapshot, reload: reloadTables }), [snapshot]);
}
