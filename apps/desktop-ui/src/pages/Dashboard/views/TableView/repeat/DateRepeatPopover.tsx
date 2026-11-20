import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TableEntry, TableField } from '@snaglet/shared/types';
import { isTableRepeatOverdue, tableRepeatSummary, type TableRepeat } from '@snaglet/shared/utils';
import { Button, DateInput } from '@desktop/components';
import type { DateInputProps } from '@desktop/components/controls/DateInput/DateInput';
import type {
  DatePickerAddon,
  DatePickerMarks,
} from '@desktop/components/controls/DateInput/DatePicker';
import { cn } from '@desktop/utils/classNames';
import { RepeatRow } from '@desktop/components/RepeatPicker/RepeatRow';
import { RepeatPanel } from './RepeatPanel';
import {
  canShiftAllUpcoming,
  formatWallDate,
  repeatDaysInMonth,
  wallParts,
} from './repeatWallDates';
import { cellWallEnd, useEntryRepeats } from './useEntryRepeats';
import styles from './DateRepeatPopover.module.scss';

export interface DateRepeatInputProps extends Omit<
  DateInputProps,
  'pickerAddon' | 'defaultOpen' | 'onOpenChange' | 'type'
> {
  tableId: string;
  entryId: string;
  /** A date or datetime field with `recurrence` on; a range's Start. */
  field: TableField;
  /** A repeat action saved the row: the editor takes it as its base. */
  onEntryWritten?: (entry: TableEntry, schemaVersion: string) => void;
}

type View = 'date' | 'repeat';

/** The width the Repeat view asks of the card. */
const REPEAT_VIEW_WIDTH = 340;

/** "Thu, Oct 15, 9:00 AM": the year only when it isn't this one. */
function shortWall(wall: string): string {
  return formatWallDate(wall, { year: wallParts(wall)?.year !== new Date().getFullYear() });
}

/** The field's wire value as a repeat wall (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS`), or null. */
function wallOf(value: string, datetime: boolean): string | null {
  if (!value) return null;
  if (!datetime) return value.slice(0, 10);
  return value.length === 16 ? `${value}:00` : value.slice(0, 19);
}

/**
 * A repeating date field's DateInput: a date + repeat popover, one card with
 * two views. The date view shows the days (and times), a Repeat row naming
 * the rule that opens the Repeat view (`RepeatPanel`), and, while the row
 * repeats, This one with Done and Skip. Picking another day on a repeating
 * row asks "Move to …?" (Just this one / All upcoming) instead of writing the
 * date. A repeating row with an empty date keeps its Repeat row, so the
 * repeat can still be edited or stopped. Escape steps back one layer; an
 * outside press closes the card and drops an unsaved repeat draft. Every
 * write is one table history step with its toast.
 */
export function DateRepeatInput({
  tableId,
  entryId,
  field,
  onEntryWritten,
  value,
  ...input
}: DateRepeatInputProps) {
  const datetime = field.type === 'datetime';
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('date');
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const repeats = useEntryRepeats(tableId, entryId, open, { onWritten: onEntryWritten });
  const rowRef = useRef<HTMLButtonElement>(null);
  const focusRow = useRef(false);

  const { state, busy } = repeats;
  // undefined while the row's repeat loads.
  const repeat: TableRepeat | null | undefined = state
    ? (state.repeats[field.id] ?? null)
    : undefined;
  const wall = wallOf(value, datetime);
  const anchor = repeat?.current ?? wall;
  const summaryOptions = { hasEnd: field.range };
  const log = useMemo(
    () => (state ? state.log.filter((row) => row.fieldId === field.id) : []),
    [state, field.id]
  );
  // The grid's dots on the next occurrences, worked out for the month shown.
  const marks = useMemo<DatePickerMarks | undefined>(
    () =>
      repeat
        ? { label: 'repeats', daysIn: (month) => repeatDaysInMonth(repeat, month, log) }
        : undefined,
    [repeat, log]
  );

  // Back on the date view, focus the Repeat row (the panel had it).
  useEffect(() => {
    if (view !== 'date' || !focusRow.current) return;
    focusRow.current = false;
    rowRef.current?.focus({ preventScroll: true });
  }, [view]);

  const reset = () => {
    setView('date');
    setPending(null);
    setNotice(null);
    repeats.clearActionError();
  };
  const toDate = () => {
    focusRow.current = true;
    setView('date');
    repeats.clearActionError();
  };
  const toRepeat = () => {
    setPending(null);
    setNotice(null);
    repeats.clearActionError();
    setView('repeat');
  };

  const interceptPick = (next: string): boolean => {
    // A failed read leaves the field a plain date (Retry is on the Repeat row).
    if (repeats.loadError) return false;
    // Still loading: hold picks rather than write a repeating row's date.
    if (repeat === undefined) return true;
    if (repeat === null) return false;
    setNotice(null);
    // An empty date picked back onto its current one: just the date again.
    if (!wall && wallOf(next, datetime) === repeat.current) {
      setPending(null);
      return false;
    }
    setPending(wallOf(next, datetime) === wall ? null : next);
    return true;
  };

  const onEscape = (): boolean => {
    if (view === 'repeat') {
      toDate();
      return true;
    }
    if (pending || notice) {
      setPending(null);
      setNotice(null);
      return true;
    }
    return false;
  };

  const move = (action: 'move' | 'shift') => {
    const to = pending ? wallOf(pending, datetime) : null;
    if (!to) return;
    void repeats.run(field.id, { action, to }).then((ok) => {
      if (ok) setPending(null);
    });
  };

  const rowValue = repeats.loadError
    ? 'Couldn’t load'
    : repeat === undefined
      ? '…'
      : repeat
        ? tableRepeatSummary(repeat, summaryOptions)
        : 'Never';

  let thisOne: ReactNode = null;
  if (repeat && !pending && !notice) {
    // A range is overdue only once its END has passed, not its start; a
    // single-day/point value passes no end and keeps the start-day comparison.
    const occurrenceEnd = field.range ? (cellWallEnd(field, value) ?? undefined) : undefined;
    const overdue = isTableRepeatOverdue(repeat, new Date(), { log, occurrenceEnd });
    // A moved one shows where the cell is now.
    const shown = wall ?? repeat.current;
    thisOne = (
      <div className={styles.thisOne}>
        <div className={styles.thisOneText}>
          <span className={styles.caps}>This one</span>
          <span className={cn(styles.thisOneWhen, overdue && styles.overdue)}>
            {shortWall(shown)}
            {overdue && ' · Overdue'}
          </span>
        </div>
        <Button
          size="sm"
          variant="primary"
          aria-label="Mark this one done"
          disabled={busy}
          onClick={() => void repeats.run(field.id, { action: 'complete' })}
        >
          Done
        </Button>
        <Button
          size="sm"
          variant="neutral"
          aria-label="Skip this one"
          disabled={busy}
          onClick={() => void repeats.run(field.id, { action: 'skip' })}
        >
          Skip
        </Button>
      </div>
    );
  }

  const pendingWall = pending ? wallOf(pending, datetime) : null;
  const shift = repeat ? canShiftAllUpcoming(repeat.rrule) : null;
  // The Repeat row is always in the card, so a date, its time and its repeat are set in
  // one place; without a date there is nothing to start from, so it waits for one.
  const noDate = !wall && !repeat;
  const below: ReactNode = (
    <div className={styles.extras}>
      {pendingWall && (
        <div className={styles.move} role="group" aria-label="Move this one">
          <p className={styles.moveText}>
            Move {field.range ? 'the start ' : ''}to <strong>{shortWall(pendingWall)}</strong>?
          </p>
          <div className={styles.moveActions}>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => move('move')}>
              Just this one
            </Button>
            <Button
              size="sm"
              variant="neutral"
              disabled={busy || !shift?.ok}
              title={shift && !shift.ok ? shift.reason : undefined}
              onClick={() => move('shift')}
            >
              All upcoming
            </Button>
          </div>
          {shift && !shift.ok && <p className={styles.muted}>{shift.reason}</p>}
        </div>
      )}
      {notice && (
        <p className={styles.muted} role="status">
          {notice}
        </p>
      )}
      <RepeatRow
        ref={rowRef}
        value={noDate && !repeats.loadError ? 'Pick a date first' : rowValue}
        on={Boolean(repeat)}
        disabled={noDate || (!repeats.loadError && repeat === undefined)}
        onClick={() => (repeats.loadError ? void repeats.reload() : toRepeat())}
      />
      {thisOne}
      {repeats.actionError && view === 'date' && (
        <p className={styles.error} role="alert">
          {repeats.actionError}
        </p>
      )}
    </div>
  );

  const repeatView: ReactNode =
    view !== 'repeat' ? null : repeats.loadError ? (
      <div className={styles.status} role="alert">
        <p>{repeats.loadError}</p>
        <Button size="xs" variant="link" onClick={() => void repeats.reload()}>
          Retry
        </Button>
      </div>
    ) : repeat === undefined ? (
      <p className={styles.status}>Loading repeat…</p>
    ) : !anchor ? (
      // An empty date whose repeat stopped elsewhere: nothing to start from.
      <p className={styles.status}>Pick a date first: a repeat starts from it.</p>
    ) : (
      <RepeatPanel
        key={`${repeat ? JSON.stringify(repeat) : ''}|${anchor}`}
        nested
        anchor={anchor}
        repeat={repeat}
        hasEnd={field.range}
        busy={busy}
        error={repeats.actionError}
        onClose={toDate}
        onSave={(next) =>
          void repeats
            .run(field.id, next === null ? { action: 'clear' } : { action: 'set', ...next })
            .then((ok) => {
              if (ok) toDate();
            })
        }
      />
    );

  const addon: DatePickerAddon = {
    below,
    view: repeatView,
    viewWidth: REPEAT_VIEW_WIDTH,
    pending,
    interceptPick,
    onEscape,
    marks,
    stayOpenOnTime: true,
  };

  return (
    <DateInput
      {...input}
      type={datetime ? 'datetime-local' : 'date'}
      value={value}
      pickerAddon={addon}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    />
  );
}
