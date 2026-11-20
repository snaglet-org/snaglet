import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableEntry, TableField } from '@snaglet/shared/types';
import { getErrorMessage, type TableRepeat } from '@snaglet/shared/utils';
import { affectsEntry, emitTableEvent, subscribeTableEvents } from '@desktop/features/database';
import { newestTableStep, stepTableHistory } from '@desktop/features/database/tableHistory';
import { tablesApi } from '@desktop/utils/api';
import {
  isStaleRepeatError,
  tableRepeatsApi,
  type OccurrenceLogRow,
  type RepeatActionResult,
  type RepeatRevision,
} from '@desktop/utils/api/tableRepeats';
import { showToast } from '@desktop/utils/toast';
import { rangeParts } from '../dateRange';
import { toDateTimeInput } from '../dateTimeInput';

export const STALE_REPEAT_MESSAGE =
  'This entry changed elsewhere. Reloaded the latest version; try again.';

export interface EntryRepeatsState {
  entry: TableEntry;
  schemaVersion: string;
  repeats: Record<string, TableRepeat>;
  /** Newest first. */
  log: OccurrenceLogRow[];
}

export type RepeatWrite =
  | {
      action: 'set';
      rrule: string;
      date: string;
    }
  | { action: 'clear' }
  | { action: 'complete' }
  | { action: 'skip' }
  /** A repeat at an interval that is behind: straight to its next time from now, nothing logged. */
  | { action: 'jump' }
  | { action: 'move'; to: string }
  | { action: 'shift'; to: string }
  | { action: 'undoOccurrence'; occurrenceId: string };

const DONE_MESSAGES: Record<RepeatWrite['action'], string> = {
  set: 'Repeat updated',
  clear: 'Repeat removed',
  complete: 'Marked done',
  skip: 'Skipped',
  jump: 'Jumped to now',
  move: 'Moved this one',
  shift: 'Moved all upcoming',
  undoOccurrence: 'Undone',
};

/**
 * A repeating cell's wall value: the date as is, a datetime in the user's
 * zone with seconds (`YYYY-MM-DDTHH:MM:SS`), null when empty. A range
 * repeats on its start, so this is the start's wall.
 */
export function cellWall(field: TableField, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const start = field.range ? rangeParts(value).start : value;
  if (!start) return null;
  if (field.type === 'date') return start.slice(0, 10);
  const wall = toDateTimeInput(start);
  if (!wall) return null;
  return wall.length === 16 ? `${wall}:00` : wall.slice(0, 19);
}

/**
 * A repeating range cell's END as a wall time, same kind as {@link cellWall}'s
 * start (`YYYY-MM-DD` last day for a date range, `YYYY-MM-DDTHH:MM:SS` for a
 * timed one). Returns null for a single value or an empty/non-range cell, so
 * overdue falls back to the start-day comparison. A range repeats on its
 * start but is overdue only once this end has passed.
 */
export function cellWallEnd(field: TableField, value: unknown): string | null {
  if (!field.range || typeof value !== 'string' || !value) return null;
  const end = rangeParts(value).end;
  if (!end) return null;
  if (field.type === 'date') return end.slice(0, 10);
  const wall = toDateTimeInput(end);
  if (!wall) return null;
  return wall.length === 16 ? `${wall}:00` : wall.slice(0, 19);
}

/**
 * A repeat write's confirmation. Its Undo reverts exactly the step that write
 * made (the same one Cmd+Z reverts), never a newer step of the user's; when
 * that step can't be read, the toast says where to undo instead.
 */
async function confirmWrite(tableId: string, message: string): Promise<void> {
  const step = await newestTableStep(tableId);
  if (!step) {
    showToast(`${message}. To undo it, use the table's history.`, { durationMs: 6000 });
    return;
  }
  showToast(message, {
    action: {
      label: 'Undo',
      run: () => void stepTableHistory('undo', { expected: step, tableId }),
    },
  });
}

function mergeLog(log: OccurrenceLogRow[], result: RepeatActionResult): OccurrenceLogRow[] {
  const removed = new Set(result.removed);
  return [...result.logged, ...log.filter((row) => !removed.has(row.id))].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

export interface EntryRepeatsOptions {
  /**
   * A write saved the entry (its date may have moved): an editor open on
   * the row takes it as its base, so its own save doesn't go stale.
   */
  onWritten?: (entry: TableEntry, schemaVersion: string) => void;
}

/**
 * One entry's repeats and occurrence log, loaded on demand (`enabled`), and
 * the writes on them. Every write carries the loaded revision pair and the
 * repeat's `current`; a 409 reloads and reports {@link STALE_REPEAT_MESSAGE}.
 * Each write is one server history step: Cmd+Z in the table undoes it, and
 * the confirmation toast offers Undo too.
 */
export function useEntryRepeats(
  tableId: string,
  entryId: string,
  enabled = true,
  options: EntryRepeatsOptions = {}
) {
  const [state, setState] = useState<EntryRepeatsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const onWritten = useRef(options.onWritten);
  onWritten.current = options.onWritten;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const [entry, view] = await Promise.all([
        tablesApi.entry(tableId, entryId),
        tableRepeatsApi.get(tableId, entryId),
      ]);
      if (mine !== generation.current) return;
      setState({
        entry: entry.entry,
        schemaVersion: entry.schemaVersion,
        repeats: view.repeats,
        log: view.log,
      });
      setLoadError(null);
    } catch (error) {
      if (mine === generation.current)
        setLoadError(getErrorMessage(error, 'Could not load the repeat'));
    }
  }, [tableId, entryId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  // Someone (an agent, another pane, a status change that advanced the row)
  // wrote this entry, in a batch or alone, or changed the table's fields (an
  // undo that changed both sends only that): reload unless our own write is
  // in flight.
  useEffect(() => {
    if (!enabled) return;
    return subscribeTableEvents((event) => {
      if (
        (event.type === 'table.entries.changed' &&
          event.tableId === tableId &&
          affectsEntry(event, entryId)) ||
        (event.type === 'table.fields.changed' && event.tableId === tableId) ||
        event.type === 'tables.invalidated'
      ) {
        if (!busyRef.current) void load();
      }
    });
  }, [enabled, tableId, entryId, load]);

  const run = useCallback(
    async (fieldId: string, write: RepeatWrite): Promise<boolean> => {
      if (!state || busyRef.current) return false;
      const revision: RepeatRevision = {
        expectedRevision: state.entry.revision,
        schemaVersion: state.schemaVersion,
        expectedCurrent: state.repeats[fieldId]?.current ?? null,
      };
      busyRef.current = true;
      setBusy(true);
      setActionError(null);
      try {
        let result: RepeatActionResult;
        switch (write.action) {
          case 'set':
            result = await tableRepeatsApi.set(tableId, entryId, fieldId, {
              ...revision,
              rrule: write.rrule,
              date: write.date,
            });
            break;
          case 'clear':
            result = await tableRepeatsApi.clear(tableId, entryId, fieldId, revision);
            break;
          case 'complete':
            result = await tableRepeatsApi.complete(tableId, entryId, fieldId, revision);
            break;
          case 'skip':
            result = await tableRepeatsApi.skip(tableId, entryId, fieldId, revision);
            break;
          case 'jump':
            result = await tableRepeatsApi.skip(tableId, entryId, fieldId, {
              ...revision,
              jump: true,
            });
            break;
          case 'move':
            result = await tableRepeatsApi.move(tableId, entryId, fieldId, {
              ...revision,
              to: write.to,
            });
            break;
          case 'shift':
            result = await tableRepeatsApi.shift(tableId, entryId, fieldId, {
              ...revision,
              to: write.to,
            });
            break;
          case 'undoOccurrence':
            result = await tableRepeatsApi.undoOccurrence(tableId, entryId, write.occurrenceId, {
              ...revision,
              fieldId,
            });
            break;
        }
        // A read still in flight must not bring back an earlier revision.
        generation.current += 1;
        setState((previous) => {
          if (!previous) return previous;
          const repeats = { ...previous.repeats };
          if (result.repeat) repeats[fieldId] = result.repeat;
          else delete repeats[fieldId];
          return {
            entry: result.entry,
            schemaVersion: result.schemaVersion,
            repeats,
            log: mergeLog(previous.log, result),
          };
        });
        if (result.changed) {
          onWritten.current?.(result.entry, result.schemaVersion);
          emitTableEvent({ type: 'table.entries.changed', tableId, entryId });
          void confirmWrite(tableId, DONE_MESSAGES[write.action]);
        }
        return true;
      } catch (error) {
        if (isStaleRepeatError(error)) {
          setActionError(STALE_REPEAT_MESSAGE);
          void load();
        } else {
          setActionError(getErrorMessage(error, 'Could not change the repeat'));
        }
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [state, tableId, entryId, load]
  );

  return {
    state,
    loadError,
    actionError,
    clearActionError: () => setActionError(null),
    busy,
    reload: load,
    run,
  };
}
