/**
 * Sidebar mini month: ‹ month ›, 7-column grid from the locale week
 * start. Today = filled primary circle; in Week, 3-day and Day the days the
 * pane shows get a selected band (Month and Year show a month or more, which
 * would paint the whole grid); a dot under days that have items in visible
 * calendars (from the occurrences the pane already loaded — no extra request). Click a
 * day → that day opens in the pane (`jumpCalendarTo`: Month → Day view,
 * Week / 3-day → its range with the day marked, Day → that day).
 */
import { useMemo, useState } from 'react';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { cn } from '@desktop/utils/classNames';
import type { StoredZoom } from '@desktop/features/calendar/calendarDates';
import {
  addDays,
  addMonths,
  dayOfMonth,
  instantToZoned,
  lastDate,
  lastZonedDate,
  longDayLabel,
  monthGridDays,
  monthTitle,
  weekdayShort,
} from '@desktop/features/calendar/calendarDates';
import styles from './CalendarSidebar.module.scss';

interface MiniMonthProps {
  today: string;
  anchor: string;
  weekStart: number;
  zone: string;
  loaded: { from: string; to: string; occurrences: CalendarOccurrence[] } | null;
  visibleCalendarIds: ReadonlySet<string>;
  /** The pane's zoom: Week (3-day too) and Day band their range; Month and Year don't. */
  zoom?: StoredZoom;
  onPick: (day: string) => void;
}

/** Days with at least one item (every day a span touches), from the loaded occurrences. */
export function daysWithItems(
  occurrences: readonly CalendarOccurrence[],
  zone: string,
  visible: ReadonlySet<string>
): Set<string> {
  const out = new Set<string>();
  for (const o of occurrences) {
    if (!visible.has(o.calendarId)) continue;
    const [first, last] =
      o.time.kind === 'all_day'
        ? [o.time.startDate, lastDate(o.time.startDate, o.time.endDate)]
        : [instantToZoned(o.time.start, zone).date, lastZonedDate(o.time.start, o.time.end, zone)];
    for (let d = first; d <= last; d = addDays(d, 1)) out.add(d);
  }
  return out;
}

export function MiniMonth({
  today,
  anchor,
  weekStart,
  zone,
  loaded,
  visibleCalendarIds,
  zoom,
  onPick,
}: MiniMonthProps) {
  const band = zoom !== 'month' && zoom !== 'year';
  const [month, setMonth] = useState(() => anchor.slice(0, 7) + '-01');
  // Follow the pane when it moves to another month.
  const [lastAnchor, setLastAnchor] = useState(anchor);
  if (anchor !== lastAnchor) {
    setLastAnchor(anchor);
    if (anchor.slice(0, 7) !== month.slice(0, 7)) setMonth(anchor.slice(0, 7) + '-01');
  }
  const days = useMemo(() => monthGridDays(month, weekStart), [month, weekStart]);
  const dots = useMemo(
    () =>
      loaded ? daysWithItems(loaded.occurrences, zone, visibleCalendarIds) : new Set<string>(),
    [loaded, zone, visibleCalendarIds]
  );

  return (
    <div className={styles.mini}>
      <div className={styles.miniHead}>
        <button
          type="button"
          className={styles.miniNav}
          aria-label="Previous month"
          onClick={() => setMonth(addMonths(month, -1))}
        >
          ‹
        </button>
        <span className={styles.miniTitle}>{monthTitle(month)}</span>
        <button
          type="button"
          className={styles.miniNav}
          aria-label="Next month"
          onClick={() => setMonth(addMonths(month, 1))}
        >
          ›
        </button>
      </div>
      <div className={styles.miniGrid} role="group" aria-label={monthTitle(month)}>
        {days.slice(0, 7).map((d) => (
          <span key={`h-${d}`} className={styles.miniDow} aria-hidden>
            {weekdayShort(d)[0]}
          </span>
        ))}
        {days.map((d) => {
          const inRange = band && loaded ? d >= loaded.from && d < loaded.to : false;
          return (
            <button
              key={d}
              type="button"
              className={cn(
                styles.miniDay,
                d.slice(0, 7) !== month.slice(0, 7) && styles.miniOther,
                inRange && styles.miniInRange,
                d === today && styles.miniToday
              )}
              aria-label={longDayLabel(d)}
              aria-current={d === today ? 'date' : undefined}
              onClick={() => onPick(d)}
            >
              {dayOfMonth(d)}
              {dots.has(d) && <span className={styles.miniDot} aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
