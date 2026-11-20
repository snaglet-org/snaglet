/**
 * Module-level bus for database table events.
 *
 * Table lifecycle events (`table.created`, `table.updated`, `table.removed`,
 * `table.restored`) come both from the workspace WebSocket bridge and from
 * the local UI once its request succeeds; receivers apply them idempotently
 * by catalog id, so hearing a change twice never duplicates a row.
 * `table.entries.changed` is one event per batch ({@link affectsEntry} tells
 * entry-scoped readers whether it concerns them). `table.history.changed`
 * refreshes the Undo/Redo controls. `draft.discarded` is local only: the
 * Dashboard drops that draft from every pane and history stack.
 */

import type {
  TableCatalogEntry,
  TableHistoryActorKind,
  TableLifecycleState,
} from '@snaglet/shared/types';
import type {
  TableEntriesChangedEvent,
  WorkspaceEventMeta,
} from '@snaglet/shared/types/workspace-events';

/** `table.entries.changed` on this bus: the wire event without its meta. */
type TableEntriesChange = Omit<TableEntriesChangedEvent, keyof WorkspaceEventMeta>;

export type TableEvent =
  | { type: 'table.created'; table: TableCatalogEntry }
  | { type: 'table.updated'; table: TableCatalogEntry }
  | { type: 'table.fields.changed'; tableId: string }
  | TableEntriesChange
  | { type: 'table.removed'; tableId: string; state: Exclude<TableLifecycleState, 'active'> }
  | { type: 'table.restored'; table: TableCatalogEntry }
  | { type: 'table.history.changed'; stack: { kind: TableHistoryActorKind; id: string } }
  | { type: 'tables.invalidated' }
  | { type: 'draft.discarded'; draftId: string };

type EntriesNamed = Pick<TableEntriesChange, 'entryId' | 'entryIds' | 'allEntries'>;

/**
 * The entries a change wrote, or null when it was too big to list
 * (`allEntries`: any of the table's entries). Falls back to `entryId` when
 * `entryIds` is absent (a single write).
 */
export function changedEntryIds(change: EntriesNamed): readonly string[] | null {
  return change.allEntries === true ? null : (change.entryIds ?? [change.entryId]);
}

/** Whether an entries change may have written `entryId`. */
export function affectsEntry(change: EntriesNamed, entryId: string): boolean {
  const ids = changedEntryIds(change);
  return ids === null || ids.includes(entryId);
}

const target = new EventTarget();
const EVENT_NAME = 'database-table';

export function emitTableEvent(event: TableEvent): void {
  target.dispatchEvent(new CustomEvent<TableEvent>(EVENT_NAME, { detail: event }));
}

export function subscribeTableEvents(handler: (event: TableEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<TableEvent>).detail);
  target.addEventListener(EVENT_NAME, listener);
  return () => target.removeEventListener(EVENT_NAME, listener);
}
