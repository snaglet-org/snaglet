/**
 * "Repeat…" from the item context menu: the table's Repeat panel
 * (`RepeatPanel`, the same one the date popover and the row's Repeat
 * section show) in its floating card (`RepeatSurface`), anchored at the
 * item. It loads the row's repeat and the field (End date → set days only)
 * when it opens. Done sets the repeat when it changed
 * (Doesn't repeat clears it); each is one table history step with Undo on
 * the calendar stack. A refused save stays open with the reason; a stale one
 * reloads and says so.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarRowOccurrence, TableField } from '@snaglet/shared/types';
import { getErrorMessage, tableRepeatSummary, type TableRepeatInput } from '@snaglet/shared/utils';
import { Button } from '@desktop/components';
import { tablesApi } from '@desktop/utils/api';
import {
  isStaleRepeatError,
  tableRepeatsApi,
  type EntryRepeatsView,
} from '@desktop/utils/api/tableRepeats';
import { instantToZoned } from '@desktop/features/calendar/calendarDates';
import popoverStyles from '@desktop/features/calendar/CalendarPopovers.module.scss';
import { setOrClearRepeat } from '@desktop/features/calendar/occurrenceWrites';
import { RepeatPanel } from '../TableView/repeat/RepeatPanel';
import { RepeatSurface } from '../TableView/repeat/RepeatSurface';
import { STALE_REPEAT_MESSAGE } from '../TableView/repeat/useEntryRepeats';
import { displayTitle } from './occurrenceText';

export interface RepeatEditPopoverProps {
  anchor: HTMLElement;
  occurrence: CalendarRowOccurrence;
  /** The viewer's zone: a timed row's wall time is read in it. */
  zone: string;
  onClose: () => void;
  /** Saved: close, refetch the window, announce `message`. */
  onDone: (message: string) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The cell's wall value from its occurrence: the date of a date row; a
 * datetime row's start in the viewer's zone (`YYYY-MM-DDTHH:MM:SS`).
 */
function occurrenceWall(o: CalendarRowOccurrence, zone: string): string {
  if (o.time.kind === 'all_day') return o.time.startDate;
  const at = instantToZoned(o.time.start, zone);
  return `${at.date}T${pad(Math.floor(at.minutes / 60))}:${pad(at.minutes % 60)}:00`;
}

interface Loaded {
  view: EntryRepeatsView;
  field: TableField | undefined;
}

export function RepeatEditPopover({
  anchor,
  occurrence: o,
  zone,
  onClose,
  onDone,
}: RepeatEditPopoverProps) {
  const title = displayTitle(o);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setLoadError(null);
    try {
      const [view, { fields }] = await Promise.all([
        tableRepeatsApi.get(o.tableId, o.entryId),
        tablesApi.fields(o.tableId),
      ]);
      if (mine === generation.current)
        setLoaded({ view, field: fields.find((f) => f.id === o.fieldId) });
    } catch (err) {
      if (mine === generation.current)
        setLoadError(getErrorMessage(err, "Couldn't load the repeat"));
    }
  }, [o.tableId, o.entryId, o.fieldId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const repeat = loaded?.view.repeats[o.fieldId] ?? null;
  const hasEnd = loaded?.field?.range ?? o.range;

  const apply = async (input: TableRepeatInput | null) => {
    if (!loaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const message = await setOrClearRepeat(
        o,
        input,
        { expectedRevision: loaded.view.revision, expectedCurrent: repeat?.current ?? null },
        (result) => `${title}: ${tableRepeatSummary(result?.repeat ?? null, { hasEnd })}`
      );
      onDone(message);
    } catch (err) {
      setBusy(false);
      if (isStaleRepeatError(err)) {
        setError(STALE_REPEAT_MESSAGE);
        void load();
      } else {
        setError(getErrorMessage(err, "Couldn't change the repeat"));
      }
    }
  };

  return (
    <RepeatSurface
      anchor={anchor}
      label={`Repeat ${title}`}
      width={340}
      flush={loaded !== null && !loadError}
      onDismiss={onClose}
    >
      {loadError ? (
        <p className={popoverStyles.error} role="alert">
          {loadError}{' '}
          <Button size="xs" variant="link" onClick={() => void load()}>
            Retry
          </Button>
        </p>
      ) : !loaded ? (
        <p className={popoverStyles.muted}>Loading repeat…</p>
      ) : (
        <RepeatPanel
          key={`${repeat?.rrule ?? ''}|${repeat?.current ?? ''}`}
          anchor={repeat?.current ?? occurrenceWall(o, zone)}
          repeat={repeat}
          hasEnd={hasEnd}
          busy={busy}
          error={error}
          onSave={(input) => void apply(input)}
          onClose={onClose}
        />
      )}
    </RepeatSurface>
  );
}
