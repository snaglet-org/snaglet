/**
 * Typed emit helpers for the Database surface (`public.table_catalog`).
 *
 * Catalog entries are table identities, not workspace nodes, so they never
 * ride the `workspace.*` tree events. Every path that creates, renames or edits a custom
 * table's schema or entries must call these after its transaction commits (the chokepoint rule from
 * `docs/architecture.md`) — never `emitWorkspaceEvent` directly.
 */

import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { ActorKind } from '@snaglet/shared/types/workspace-events';
import { emitWorkspaceEvent } from '../emit';
import { emitRemindersChangedForTable } from './reminders';
import { noteEntriesChanged } from '@server/services/tableSemantic/sweepState';

export function emitTableCreated(table: TableCatalogEntry): void {
  emitWorkspaceEvent({ type: 'table.created', table });
}

export function emitTableUpdated(table: TableCatalogEntry): void {
  emitWorkspaceEvent({ type: 'table.updated', table });
}

export function emitTableFieldsChanged(tableId: string): void {
  emitWorkspaceEvent({ type: 'table.fields.changed', tableId });
  emitRemindersChangedForTable(tableId);
}

/** Past this many ids, `table.entries.changed` says `allEntries` instead of listing them. */
const LISTED_ENTRY_IDS_MAX = 500;

/**
 * A committed write to one or more entries of a table. A batch emits once,
 * never once per entry: `entryIds` lists every entry it wrote, or, past
 * {@link LISTED_ENTRY_IDS_MAX} ids (an agent purge clearing links is
 * uncapped), `allEntries: true` stands in for the list. `entryId` is always
 * the first entry, for readers that predate the list. Table- and page-scoped
 * consumers reload their page; entry-scoped ones (an open row, its repeats)
 * reload when their entry is named. An empty batch emits nothing.
 */
export function emitTableEntriesChanged(
  tableId: string,
  entryIds: string | readonly string[]
): void {
  const ids = typeof entryIds === 'string' ? [entryIds] : [...new Set(entryIds)];
  const entryId = ids[0];
  if (entryId === undefined) return;
  emitWorkspaceEvent({
    type: 'table.entries.changed',
    tableId,
    entryId,
    ...(ids.length > LISTED_ENTRY_IDS_MAX ? { allEntries: true as const } : { entryIds: ids }),
  });
  // A row's date (or its repeat) may carry reminders.
  emitRemindersChangedForTable(tableId);
  // A table with semantic search on re-reads its rows on its next sweep.
  noteEntriesChanged(tableId);
}

/** A custom table was archived or deleted (a deleted one stays undoable from history). */
export function emitTableRemoved(tableId: string, state: 'archived' | 'deleted'): void {
  emitWorkspaceEvent({ type: 'table.removed', tableId, state });
  emitRemindersChangedForTable(tableId);
}

/** An archived or deleted table is active again (restore, undo or redo). */
export function emitTableRestored(table: TableCatalogEntry): void {
  emitWorkspaceEvent({ type: 'table.restored', table });
  emitRemindersChangedForTable(table.id);
}

/** An actor's table undo stack changed; clients showing it refresh Undo/Redo. */
export function emitTableHistoryChanged(stack: { kind: ActorKind; id: string }): void {
  emitWorkspaceEvent({ type: 'table.history.changed', stack });
}
