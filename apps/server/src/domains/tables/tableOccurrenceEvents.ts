/**
 * The `table_entry:occurrence` hook event: one event per
 * occurrence action on a repeating row (done, counted, skipped, moved,
 * shifted, jumped, undone), built from the occurrence changes a committed
 * write returns. Every path that makes them sends them here after commit:
 * the repeat actions (`via: 'action'`), a status set to done in an entry
 * update or agent batch (`'status'`, after that row's `table_entry:update`)
 * and table undo/redo (`'history'`).
 */
import { TableEntries, type OccurrenceChange } from '@snaglet/db/tables/table_entries';
import type { HistoryActor } from '@snaglet/db/tables/table_history';
import { TABLE_ENTRY_RESOLVE_MAX } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { currentHookOrigin } from '@server/realtime/runContext';
import { hooks, type TableEntryOccurrenceEvent } from '@server/services/HookService';

/**
 * The names of the rows `changes` are on, read after the commit: the only
 * row value an occurrence event carries. A failed read leaves them unnamed
 * rather than failing a write that already happened.
 */
async function occurrenceEntryNames(
  changes: readonly OccurrenceChange[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const refs = [
    ...new Map(
      changes.map((change) => [
        `${change.tableId}/${change.entryId}`,
        { tableId: change.tableId, entryId: change.entryId },
      ])
    ).values(),
  ];
  try {
    for (let at = 0; at < refs.length; at += TABLE_ENTRY_RESOLVE_MAX) {
      const { entries } = await TableEntries.resolveEntries(
        refs.slice(at, at + TABLE_ENTRY_RESOLVE_MAX)
      );
      for (const entry of entries) names.set(`${entry.tableId}/${entry.entryId}`, entry.name);
    }
  } catch (err) {
    logger.warn(`table_entry:occurrence: could not read row names: ${getErrorMessage(err)}`);
  }
  return names;
}

/**
 * The `table_entry:occurrence` payloads for a committed write's occurrence
 * changes, in order. `via` says which path made them, `actor`
 * who; a hook's own tool call stamps it as the `origin`, so the self-origin
 * guard keeps that hook from firing on what it did.
 */
export async function occurrenceEvents(
  changes: readonly OccurrenceChange[],
  via: TableEntryOccurrenceEvent['via'],
  actor: HistoryActor
): Promise<TableEntryOccurrenceEvent[]> {
  if (!changes.length) return [];
  const names = await occurrenceEntryNames(changes);
  const origin = currentHookOrigin();
  return changes.map((change) => ({
    tableId: change.tableId,
    entryId: change.entryId,
    fieldId: change.fieldId,
    entryName: names.get(`${change.tableId}/${change.entryId}`) ?? '',
    action: change.action,
    occurrence: change.occurrence,
    lastOccurrence: change.lastOccurrence,
    count: change.count,
    tz: change.tz,
    movedTo: change.movedTo,
    undoneAction: change.undoneAction,
    current: change.current,
    ended: change.ended,
    logId: change.logIds[0] ?? null,
    logIds: change.logIds,
    via,
    actor: { kind: actor.kind, id: actor.id },
    ...(origin ? { origin } : {}),
  }));
}

export function emitOccurrenceEvents(events: readonly TableEntryOccurrenceEvent[]): void {
  for (const event of events) hooks.emit('table_entry:occurrence', event);
}
