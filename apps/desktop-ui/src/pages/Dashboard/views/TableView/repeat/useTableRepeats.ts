import { useCallback, useEffect, useRef, useState } from 'react';
import type { TableRepeat } from '@snaglet/shared/utils';
import { subscribeTableEvents } from '@desktop/features/database';
import { tableRepeatsApi, type OccurrenceLogRow } from '@desktop/utils/api/tableRepeats';

/** One repeating cell: its repeat and its current occurrence's log. */
export interface CellRepeat {
  repeat: TableRepeat;
  log: OccurrenceLogRow[];
}

/** `fieldId/entryId` → the cell's repeat. */
export type TableRepeatsMap = ReadonlyMap<string, CellRepeat>;

export const cellRepeatKey = (fieldId: string, entryId: string) => `${fieldId}/${entryId}`;

const REFETCH_MS = 250;

/**
 * Every repeating row of a table, for the grid's and Board's
 * cell text (the next occurrence) without opening rows. Loads when `enabled`
 * (the table has a repeating field) and reloads, coalesced, when the
 * table's entries or fields change. A failed load leaves the map empty:
 * cells then read as plain dates.
 */
export function useTableRepeats(tableId: string, enabled: boolean): TableRepeatsMap {
  const [map, setMap] = useState<TableRepeatsMap>(() => new Map());
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const view = await tableRepeatsApi.list(tableId);
      if (mine !== generation.current) return;
      setMap(
        new Map(
          view.rows.map((row) => [
            cellRepeatKey(row.fieldId, row.entryId),
            { repeat: row.repeat, log: row.log },
          ])
        )
      );
    } catch {
      // Keep what was on screen; the cells fall back to their dates.
    }
  }, [tableId]);

  useEffect(() => {
    if (!enabled) {
      generation.current++;
      setMap(new Map());
      return;
    }
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeTableEvents((event) => {
      const mine =
        event.type === 'tables.invalidated' ||
        // An undo or redo may leave the row itself unchanged.
        event.type === 'table.history.changed' ||
        ((event.type === 'table.entries.changed' || event.type === 'table.fields.changed') &&
          event.tableId === tableId);
      if (!mine) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), REFETCH_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, tableId, load]);

  return map;
}
