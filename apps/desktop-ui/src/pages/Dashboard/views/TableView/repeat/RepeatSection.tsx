import { useId, useRef, useState } from 'react';
import type { TableField } from '@snaglet/shared/types';
import {
  isTableRepeatOverdue,
  tableRepeatIntervalSeconds,
  tableRepeatSummary,
} from '@snaglet/shared/utils';
import { Button, DateInput } from '@desktop/components';
import type { OccurrenceLogRow } from '@desktop/utils/api/tableRepeats';
import { RepeatPanel } from './RepeatPanel';
import { RepeatSurface } from './RepeatSurface';
import { canShiftAllUpcoming, formatWallDate, wallParts } from './repeatWallDates';
import { cellWall, cellWallEnd, useEntryRepeats } from './useEntryRepeats';
import { rangeKindOf } from '../dateRange';
import { dateRangeText } from '../dateRangeText';
import styles from './RepeatSection.module.scss';

export interface RepeatSectionProps {
  tableId: string;
  entryId: string;
  /** A date or datetime field with `recurrence` on. */
  field: TableField;
}

function shortDate(wall: string, refYear: number): string {
  const p = wallParts(wall);
  return formatWallDate(wall, { weekday: false, year: !p || p.year !== refYear });
}

/**
 * One history line: "Oct 5 ✓ done", "Oct 12 skipped", "Oct 26 moved → Tue,
 * Oct 27".
 */
export function describeLogRow(row: OccurrenceLogRow, refYear: number): string {
  const when = shortDate(row.occurrence, refYear);
  if (row.kind === 'done') return `${when} ✓ done`;
  if (row.kind === 'skipped') return `${when} skipped`;
  const to = row.movedTo
    ? formatWallDate(row.movedTo, { year: (wallParts(row.movedTo)?.year ?? refYear) !== refYear })
    : '?';
  return `${when} moved → ${to}`;
}

const STAMP = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * The repeat block in the row modal: the repeat's
 * sentence + Edit, then the current occurrence with Done ·
 * Skip · Move… — then the History list (newest first) with Undo per entry.
 * Every action is one table history step.
 */
export function RepeatSection({ tableId, entryId, field }: RepeatSectionProps) {
  const ids = useId();
  const repeats = useEntryRepeats(tableId, entryId);
  const editRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState('');

  const { state, busy } = repeats;
  const repeat = state?.repeats[field.id] ?? null;
  const wall = state ? cellWall(field, state.entry.values[field.id]) : null;
  const anchor = repeat?.current ?? wall;
  const summary = repeat ? tableRepeatSummary(repeat, { hasEnd: field.range }) : null;
  const log = state ? state.log.filter((row) => row.fieldId === field.id) : [];
  // A range is overdue only once its END has passed, not its start (a running
  // multi-day/timed span is not overdue); single-day/point rows pass no end.
  const occurrenceEnd =
    state && field.range
      ? (cellWallEnd(field, state.entry.values[field.id]) ?? undefined)
      : undefined;
  // An interval (sub-daily) is overdue once its time has passed, the same day.
  const overdue = repeat ? isTableRepeatOverdue(repeat, new Date(), { log, occurrenceEnd }) : false;
  // An interval behind may be thousands of steps back: one jump to its next
  // time, logging none of them (Skip moves one interval).
  const canJump = overdue && repeat !== null && tableRepeatIntervalSeconds(repeat.rrule) !== null;
  const refYear = wallParts(anchor ?? '')?.year ?? new Date().getFullYear();
  const shift = repeat ? canShiftAllUpcoming(repeat.rrule) : null;
  const isDateTime = field.type === 'datetime';
  // A moved current occurrence shows where the cell is now.
  const shown = wall ?? repeat?.current ?? null;
  // A range shows its whole span; it moves by its start and keeps its length.
  const rangeKind = rangeKindOf(field);
  const cellValue = state?.entry.values[field.id];
  const shownRange =
    rangeKind && wall && typeof cellValue === 'string' ? dateRangeText(cellValue, rangeKind) : null;

  const startMove = () => {
    setMoveTo(isDateTime ? (shown ?? '').slice(0, 16) : (shown ?? ''));
    setMoving(true);
  };
  const moveWall = isDateTime && moveTo.length === 16 ? `${moveTo}:00` : moveTo;
  const doMove = async (action: 'move' | 'shift') => {
    if (!moveWall) return;
    if (await repeats.run(field.id, { action, to: moveWall })) setMoving(false);
  };

  return (
    <section className={styles.section} aria-label={`Repeat: ${field.name}`}>
      <header className={styles.header}>
        <h3 id={`${ids}-title`} className={styles.title}>
          <span aria-hidden>↻ </span>
          {field.name}
        </h3>
        {state && anchor && (
          <Button
            ref={editRef}
            size="xs"
            variant="ghost"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            disabled={busy}
          >
            {repeat ? 'Edit repeat' : 'Set repeat'}
          </Button>
        )}
      </header>

      {repeats.loadError ? (
        <div className={styles.error} role="alert">
          {repeats.loadError}{' '}
          <Button size="xs" variant="link" onClick={() => void repeats.reload()}>
            Retry
          </Button>
        </div>
      ) : !state ? (
        <p className={styles.muted}>Loading repeat…</p>
      ) : (
        <>
          <p className={styles.summary} data-testid="repeat-section-summary">
            {summary ?? (anchor ? 'Doesn’t repeat' : `Set ${field.name} to repeat it.`)}
          </p>
          <div className={styles.dueSlot} data-repeat-due-slot="">
            {overdue && <span className={styles.overdue}>Overdue</span>}
          </div>

          {repeat && shown && (
            <div className={styles.current}>
              <div className={styles.currentDate}>
                <span className={styles.muted}>Current</span>
                <span className={styles.date} title={shownRange?.label}>
                  {shownRange ? shownRange.text : formatWallDate(shown)}
                </span>
              </div>
              <div className={styles.actions}>
                <Button
                  size="sm"
                  onClick={() => void repeats.run(field.id, { action: 'complete' })}
                  disabled={busy}
                >
                  Done
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void repeats.run(field.id, { action: 'skip' })}
                  disabled={busy}
                >
                  Skip
                </Button>
                {canJump && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void repeats.run(field.id, { action: 'jump' })}
                    disabled={busy}
                    title="Go to its next time from now, without logging the missed ones"
                  >
                    Jump to now
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => (moving ? setMoving(false) : startMove())}
                  aria-expanded={moving}
                  disabled={busy}
                >
                  Move…
                </Button>
              </div>
              {moving && (
                <div className={styles.move}>
                  <label className={styles.moveLabel}>
                    <span>{rangeKind ? 'Move start to' : 'Move to'}</span>
                    <DateInput
                      size="sm"
                      type={isDateTime ? 'datetime-local' : 'date'}
                      required
                      value={moveTo}
                      onChange={setMoveTo}
                      aria-label={rangeKind ? 'Move start to' : 'Move to'}
                    />
                  </label>
                  <div className={styles.actions}>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || !moveTo}
                      onClick={() => void doMove('move')}
                    >
                      Only this one
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !moveTo || !shift?.ok}
                      aria-describedby={shift && !shift.ok ? `${ids}-shift` : undefined}
                      onClick={() => void doMove('shift')}
                    >
                      All upcoming
                    </Button>
                  </div>
                  {shift && !shift.ok && (
                    <p id={`${ids}-shift`} className={styles.muted}>
                      {shift.reason}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {repeats.actionError && !editing && (
            <p className={styles.error} role="alert">
              {repeats.actionError}
            </p>
          )}

          {log.length > 0 && (
            <div className={styles.history}>
              <p className={styles.historyTitle} id={`${ids}-history`}>
                History
              </p>
              <ul aria-labelledby={`${ids}-history`} className={styles.historyList}>
                {log.map((row) => (
                  <li key={row.id} className={styles.historyRow} data-kind={row.kind}>
                    <span className={styles.historyText} data-log-text="">
                      {describeLogRow(row, refYear)}
                    </span>
                    <time className={styles.stamp} dateTime={row.createdAt}>
                      {STAMP.format(new Date(row.createdAt))}
                    </time>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Undo ${describeLogRow(row, refYear)}`}
                      onClick={() =>
                        void repeats.run(field.id, {
                          action: 'undoOccurrence',
                          occurrenceId: row.id,
                        })
                      }
                    >
                      Undo
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {editing && state && anchor && editRef.current && (
        <RepeatSurface
          anchor={editRef.current}
          label={`Repeat ${field.name}`}
          width={340}
          flush
          onDismiss={() => {
            setEditing(false);
            repeats.clearActionError();
          }}
        >
          <RepeatPanel
            key={`${repeat ? JSON.stringify(repeat) : ''}|${anchor}`}
            anchor={anchor}
            repeat={repeat}
            hasEnd={field.range}
            busy={busy}
            error={repeats.actionError}
            onClose={() => setEditing(false)}
            onSave={(input) =>
              void repeats
                .run(field.id, input === null ? { action: 'clear' } : { action: 'set', ...input })
                .then((ok) => {
                  if (ok) setEditing(false);
                })
            }
          />
        </RepeatSurface>
      )}
    </section>
  );
}
