/**
 * One occurrence as a focusable button. Events and table rows look alike in
 * every view: a soft tint of the calendar's color with a left bar in the
 * full color (an automation wake keeps its dashed outline and ◷). What a
 * row belongs to (its table) and a repeat's sentence live in the hover title
 * and the popover; the only mark of a repeat on the item is a small ↻, on a
 * full-size block in Week / Day. History states (done ✓ / skipped struck
 * through / moved ↷), the overdue dot and the resize handles are drawn here.
 * Color comes only from the calendar (`calendarColorProps`).
 */
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { cn } from '@desktop/utils/classNames';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { formatMinutes } from '@desktop/features/calendar/calendarDates';
import { displayTitle, isOverdue, movedFrom } from './occurrenceText';
import type { DragKind } from './dropTargets';
import type { ItemMenuEvent } from './gridTypes';
import styles from './CalendarView.module.scss';

export interface OccurrenceItemProps {
  occurrence: CalendarOccurrence;
  color: string;
  variant: 'chip' | 'block' | 'bar';
  ariaLabel: string;
  hover: string;
  /** Start minutes for the time prefix (timed items in Month, chips and lane bars). */
  startMinutes?: number;
  style?: CSSProperties;
  compact?: boolean;
  tabIndex?: number;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  /** Focus this item when its surface opens (`AnchoredSurface`'s `[data-autofocus]`). */
  autoFocusInSurface?: boolean;
  onOpen: (occurrence: CalendarOccurrence, el: HTMLElement, focusTitle?: boolean) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, occurrence: CalendarOccurrence) => void;
  /** Press on the item (move) or on a resize handle. */
  onDragStart?: (
    event: PointerEvent<HTMLElement>,
    occurrence: CalendarOccurrence,
    kind: DragKind
  ) => void;
  onContextMenu?: (event: ItemMenuEvent, occurrence: CalendarOccurrence) => void;
  /**
   * Resize handles: the end only, or start and end (Week/Day, block ≥ 30 px).
   * A timed block's end is its bottom edge; an all-day item's is its right edge.
   */
  resize?: 'none' | 'end' | 'both';
}

export function OccurrenceItem({
  occurrence: o,
  color,
  variant,
  ariaLabel,
  hover,
  startMinutes,
  style,
  compact,
  tabIndex = 0,
  continuesBefore,
  continuesAfter,
  autoFocusInSurface,
  onOpen,
  onKeyDown,
  onDragStart,
  onContextMenu,
  resize = 'none',
}: OccurrenceItemProps) {
  const isAutomation = o.source === 'automation';
  const overdue = isOverdue(o);
  // Readable without color: "↷ Mon" on the item; the hover card has the full time.
  const moved = movedFrom(o);
  const title = displayTitle(o);
  const open = (e: MouseEvent<HTMLButtonElement>, focusTitle = false) => {
    e.stopPropagation();
    onOpen(o, e.currentTarget, focusTitle);
  };
  const press = (e: PointerEvent<HTMLElement>, kind: DragKind) => {
    if (e.button !== 0 || e.ctrlKey || !onDragStart) return;
    if (kind !== 'move') e.stopPropagation();
    onDragStart(e, o, kind);
  };
  const canResize = o.canMove && o.canResize && resize !== 'none';
  const allDay = o.time.kind === 'all_day';
  // A full-size block has room for its time line and a small ↻; a chip, a
  // bar or a compact block shows the title alone.
  const roomy = variant === 'block' && !compact;
  const repeats =
    (o.source === 'row' && Boolean(o.repeat)) || (o.source === 'event' && Boolean(o.repeatSummary));
  return (
    <button
      type="button"
      className={cn(
        styles.item,
        styles[variant],
        isAutomation ? styles.automation : styles.tinted,
        o.note === 'failed' && styles.failed,
        o.status === 'done' && styles.done,
        o.status === 'skipped' && styles.skipped,
        o.status === 'moved' && styles.moved,
        continuesBefore && styles.continuesBefore,
        continuesAfter && styles.continuesAfter,
        !o.canMove && styles.readOnly
      )}
      {...calendarColorProps(color, style)}
      data-key={o.key}
      data-calendar-item=""
      data-source={o.source}
      data-autofocus={autoFocusInSurface ? '' : undefined}
      data-automation={isAutomation ? '' : undefined}
      data-overdue={overdue ? '' : undefined}
      aria-label={ariaLabel}
      title={o.canMove ? hover : `${hover}\nRead-only: it can't be moved here`}
      tabIndex={tabIndex}
      onPointerDown={o.canMove ? (e) => press(e, 'move') : undefined}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, o);
            }
          : undefined
      }
      onClick={(e) => open(e)}
      onDoubleClick={(e) => open(e, true)}
      onKeyDown={onKeyDown ? (e) => onKeyDown(e, o) : undefined}
    >
      {overdue && <span className={styles.overdue} aria-hidden />}
      {o.status === 'done' && (
        <span className={styles.check} aria-hidden>
          ✓
        </span>
      )}
      <span className={styles.itemText}>
        <span className={styles.itemTitle}>
          {/* A bar cut by a week row: ◂ / ▸ say it goes on, so the piece
              doesn't read as a second item. */}
          {variant === 'bar' && continuesBefore && (
            <span className={styles.continues} data-continues="before" aria-hidden>
              ◂{' '}
            </span>
          )}
          {variant !== 'block' && startMinutes !== undefined && (
            <span className={styles.itemTime}>
              {formatMinutes(startMinutes, { compact: true })}{' '}
            </span>
          )}
          {isAutomation && (
            <span className={styles.glyph} data-automation-glyph="" aria-hidden>
              ◷{' '}
            </span>
          )}
          <span className={styles.titleText}>{title}</span>
          {roomy && repeats && (
            <span className={styles.repeat} data-repeat-glyph="" aria-hidden>
              {' '}
              ↻
            </span>
          )}
          {moved && (
            <span className={styles.movedFrom} data-moved-from="" aria-hidden>
              {' '}
              ↷ {moved.day}
            </span>
          )}
          {variant === 'bar' && continuesAfter && (
            <span className={styles.continues} data-continues="after" aria-hidden>
              {' '}
              ▸
            </span>
          )}
        </span>
        {roomy && isAutomation && <span className={styles.itemSub}>{o.agentName}</span>}
        {roomy && !isAutomation && o.time.kind === 'timed' && startMinutes !== undefined && (
          <span className={styles.itemSub}>{formatMinutes(startMinutes)}</span>
        )}
      </span>
      {canResize && resize === 'both' && !allDay && (
        <span
          className={cn(styles.resizeHandle, styles.resizeTop)}
          data-cal-resize="start"
          aria-hidden
          onPointerDown={(e) => press(e, 'resize-start')}
        />
      )}
      {canResize && (
        <span
          className={cn(styles.resizeHandle, allDay ? styles.resizeRight : styles.resizeBottom)}
          data-cal-resize="end"
          aria-hidden
          onPointerDown={(e) => press(e, 'resize-end')}
        />
      )}
    </button>
  );
}

/** The grid item drawn for `key`, found from a piece of it (its Due tail). */
