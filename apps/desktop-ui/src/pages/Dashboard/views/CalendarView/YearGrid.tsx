/**
 * Year grid: the twelve months of the anchor's year as small calendars. A day
 * with a notable item (`notableByDay` in `@snaglet/shared/utils`, the same rules as
 * the calendar tool's `dates` op) is circled in its calendar's color; hover
 * it for the day's list, click it to open that day. The list is a popover
 * (`role="dialog"`), not a tooltip, so the pointer can travel onto it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { notableByDay } from '@snaglet/shared/utils';
import { cn } from '@desktop/utils/classNames';
import {
  addDays,
  addMonths,
  dayOfMonth,
  dayOfWeek,
  formatMinutes,
  instantToZoned,
  longDayLabel,
  monthName,
  startOfWeek,
  weekdayShort,
} from '@desktop/features/calendar/calendarDates';
import { AnchoredSurface } from '@desktop/features/calendar/AnchoredSurface';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { displayTitle } from './occurrenceText';
import styles from './YearGrid.module.scss';

/** Items listed in a day's popover before "+N more". */
const LIST_MAX = 6;
/**
 * How long the list stays open after the pointer leaves the day or the list,
 * so the pointer can travel across the gap between them without it closing.
 */
const CLOSE_DELAY_MS = 150;

export interface YearGridProps {
  /** Any day of the year shown. */
  anchor: string;
  weekStart: number;
  today: string;
  zone: string;
  occurrences: CalendarOccurrence[];
  /** A calendar's color: a circled day wears its first item's. */
  colorOf?: (calendarId: string) => string;
  /** A month's name was picked: open it in Month view. */
  onOpenMonth: (firstOfMonth: string) => void;
  /** A day was picked: open it in Day view. */
  onOpenDay: (day: string) => void;
  /** An item in a day's list was picked: open that entry (as in Month view). */
  onOpenItem?: (o: CalendarOccurrence, el: HTMLElement, focusTitle?: boolean) => void;
}

const repeatText = (o: CalendarOccurrence): string | null =>
  o.source === 'event'
    ? (o.repeatSummary ?? null)
    : o.source === 'row'
      ? (o.repeat?.summary ?? null)
      : null;

/** What a day's popover shows: the date, then what is on it, each clickable. */
function DayList({
  day,
  items,
  zone,
  expanded,
  autoFocusFirst,
  onExpand,
  onOpenItem,
  onMouseEnter,
  onMouseLeave,
}: {
  day: string;
  items: CalendarOccurrence[];
  zone: string;
  expanded: boolean;
  /** A keyboard open moves focus to the first item. */
  autoFocusFirst: boolean;
  onExpand: () => void;
  onOpenItem?: (o: CalendarOccurrence, el: HTMLElement, focusTitle?: boolean) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const shown = expanded ? items : items.slice(0, LIST_MAX);
  return (
    <div className={styles.list} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <strong className={styles.listDay}>{longDayLabel(day)}</strong>
      <ul>
        {shown.map((o, i) => {
          const again = repeatText(o);
          const settled = o.status === 'done' || o.status === 'skipped';
          return (
            <li key={o.key} className={settled ? styles.settled : undefined}>
              <button
                type="button"
                className={styles.listItem}
                disabled={!onOpenItem}
                data-autofocus={autoFocusFirst && i === 0 ? '' : undefined}
                aria-label={displayTitle(o)}
                onClick={(e) => onOpenItem?.(o, e.currentTarget)}
              >
                {o.time.kind === 'timed' && (
                  <span className={styles.listTime}>
                    {formatMinutes(instantToZoned(o.time.start, zone).minutes)}
                  </span>
                )}
                <span className={styles.listTitle}>{displayTitle(o)}</span>
                {again && <span className={styles.listRepeat}>↻ {again}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {!expanded && items.length > shown.length && (
        <button type="button" className={styles.listMore} onClick={onExpand}>
          +{items.length - shown.length} more
        </button>
      )}
    </div>
  );
}

function itemsLabel(count: number): string {
  return count === 0 ? '' : `, ${count} ${count === 1 ? 'item' : 'items'}`;
}

/** The day whose list is open, and how it was opened. */
interface OpenDay {
  day: string;
  items: CalendarOccurrence[];
  anchor: HTMLElement;
  /** Keyboard opens move focus into the list and return it to the day on close. */
  keyboard: boolean;
}

export function YearGrid({
  anchor,
  weekStart,
  today,
  zone,
  occurrences,
  colorOf,
  onOpenMonth,
  onOpenDay,
  onOpenItem,
}: YearGridProps) {
  const year = anchor.slice(0, 4);
  const byDay = useMemo(
    () => notableByDay(occurrences, (instant) => instantToZoned(instant, zone).date),
    [occurrences, zone]
  );
  const months = Array.from(
    { length: 12 },
    (_, m) => `${year}-${String(m + 1).padStart(2, '0')}-01`
  );
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    weekdayShort(addDays(startOfWeek(`${year}-01-01`, weekStart), i)).slice(0, 1)
  );

  const [open, setOpen] = useState<OpenDay | null>(null);
  const [expanded, setExpanded] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const openDayList = useCallback(
    (day: string, items: CalendarOccurrence[], el: HTMLElement, keyboard: boolean) => {
      clearCloseTimer();
      setExpanded(false);
      setOpen({ day, items, anchor: el, keyboard });
    },
    [clearCloseTimer]
  );

  const closeNow = useCallback(() => {
    clearCloseTimer();
    setOpen(null);
  }, [clearCloseTimer]);

  /** Leave the day or the list: close after the bridge delay unless re-entered. */
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(null);
    }, CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  return (
    <div className={styles.year} role="group" aria-label={`Year ${year}`}>
      {months.map((first) => {
        const lead = (dayOfWeek(first) - weekStart + 7) % 7;
        const length = Math.round(
          (Date.parse(addMonths(first, 1)) - Date.parse(first)) / 86_400_000
        );
        const isCurrent = anchor.slice(0, 7) === first.slice(0, 7);
        return (
          <section key={first} className={cn(styles.month, isCurrent && styles.currentMonth)}>
            <button
              type="button"
              className={styles.monthName}
              aria-label={`Open ${monthName(first)} ${year}`}
              onClick={() => onOpenMonth(first)}
            >
              {monthName(first)}
            </button>
            <div className={styles.days}>
              {weekdays.map((w, i) => (
                <span key={i} className={styles.weekday} aria-hidden>
                  {w}
                </span>
              ))}
              {Array.from({ length: lead }, (_, i) => (
                <span key={`b${i}`} aria-hidden />
              ))}
              {Array.from({ length }, (_, i) => {
                const day = addDays(first, i);
                const items = byDay.get(day) ?? [];
                const noted = items.length > 0;
                const isOpen = open?.day === day;
                return (
                  <button
                    key={day}
                    type="button"
                    // A circled day is a tab stop so it can be opened by
                    // keyboard; an empty day stays out of the tab order.
                    tabIndex={noted ? 0 : -1}
                    className={cn(styles.day, noted && styles.noted, day === today && styles.today)}
                    data-noted={noted ? '' : undefined}
                    {...calendarColorProps(noted ? colorOf?.(items[0].calendarId) : undefined)}
                    aria-label={`${longDayLabel(day)}${itemsLabel(items.length)}`}
                    aria-haspopup={noted ? 'dialog' : undefined}
                    aria-expanded={noted ? isOpen : undefined}
                    onClick={() => onOpenDay(day)}
                    onMouseEnter={
                      noted ? (e) => openDayList(day, items, e.currentTarget, false) : undefined
                    }
                    onMouseLeave={noted ? scheduleClose : undefined}
                    onKeyDown={
                      noted
                        ? (e: KeyboardEvent<HTMLButtonElement>) => {
                            if (e.key === 'Enter' || e.key === 'ArrowDown') {
                              e.preventDefault();
                              openDayList(day, items, e.currentTarget, true);
                            }
                          }
                        : undefined
                    }
                  >
                    {dayOfMonth(day)}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {open && (
        <AnchoredSurface
          key={open.day}
          anchor={open.anchor}
          label={`${longDayLabel(open.day)}${itemsLabel(open.items.length)}`}
          width={220}
          className={styles.popover}
          returnFocusTo={open.keyboard ? open.anchor : null}
          onDismiss={closeNow}
        >
          <DayList
            day={open.day}
            items={open.items}
            zone={zone}
            expanded={expanded}
            autoFocusFirst={open.keyboard}
            onExpand={() => setExpanded(true)}
            onOpenItem={onOpenItem}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
          />
        </AnchoredSurface>
      )}
    </div>
  );
}
