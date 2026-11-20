/**
 * Month grid. Whole weeks; each day cell is a gridcell
 * (roving tabindex, arrows move by day / week). Multi-day all-day items are
 * spanning bars on top of each week, before single-day chips. Each cell
 * shows as many items as fit (min 2; 2 in a narrow pane), then "+N more"
 * opens a popover with that day's items. Clicking empty space = all-day
 * quick add; the date number opens the day in Day view.
 *
 * Every automations: a small dot per automation active that day, in its
 * calendar's color, side by side after the date and
 * before the day's items ({@link IntervalDots}).
 */
import { Fragment, useMemo, useState, type KeyboardEvent } from 'react';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { cn } from '@desktop/utils/classNames';
import {
  addDays,
  dayOfMonth,
  instantToZoned,
  longDayLabel,
  weekdayShort,
} from '@desktop/features/calendar/calendarDates';
import {
  allDayLanes,
  intervalsByDay,
  placeOccurrences,
  type DayIndexSpan,
} from '@desktop/features/calendar/calendarLayout';
import { AnchoredSurface } from '@desktop/features/calendar/AnchoredSurface';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import popoverStyles from '@desktop/features/calendar/CalendarPopovers.module.scss';
import { OccurrenceItem } from './OccurrenceItem';
import { IntervalDots } from './IntervalMarks';
import { ariaLabelFor, hoverText } from './occurrenceText';
import type { GridProps } from './gridTypes';
import styles from './CalendarView.module.scss';

interface MonthGridProps extends GridProps {
  /** Day whose month is shown (other-month days are muted). */
  anchor: string;
  /** Items each cell has room for (measured by the parent; min 2). */
  maxPerCell: number;
}

interface DayItem {
  occurrence: CalendarOccurrence;
  start?: number;
}

/** One piece of a lane bar inside a week: columns 0–6, and whether it runs on past the week. */
interface WeekPart {
  startIndex: number;
  endIndex: number;
  cb: boolean;
  ca: boolean;
}

/** An item drawn in a week's bar lanes: itself, when it falls in this week. */
interface LaneBar {
  key: string;
  o: CalendarOccurrence;
  item: WeekPart | null;
  /** A timed item keeps its time in the lane. */
  start?: number;
}

/** `span` (visible day indexes) clipped to week `w`, or null when it misses it. */
function inWeek(span: DayIndexSpan, w: number): WeekPart | null {
  const ws = w * 7;
  const we = ws + 6;
  if (span.endIndex < ws || span.startIndex > we) return null;
  return {
    startIndex: Math.max(span.startIndex, ws) - ws,
    endIndex: Math.min(span.endIndex, we) - ws,
    cb: span.startIndex < ws || span.continuesBefore,
    ca: span.endIndex > we || span.continuesAfter,
  };
}

export function MonthGrid({
  days,
  anchor,
  today,
  zone,
  occurrences,
  intervals,
  onOpenInterval,
  calendarsById,
  colorOf,
  draft,
  draftColor,
  onDraft,
  onOpenItem,
  onOpenDay,
  onItemKeyDown,
  ghostRef,
  maxPerCell,
  dragPreview = null,
  onItemDragStart,
  onItemContextMenu,
}: MonthGridProps) {
  const month = anchor.slice(0, 7);
  const weeks = useMemo(() => {
    const out: string[][] = [];
    for (let i = 0; i < days.length; i += 7) out.push(days.slice(i, i + 7));
    return out;
  }, [days]);

  const placed = useMemo(
    () => placeOccurrences(occurrences, days, zone),
    [occurrences, days, zone]
  );

  // Multi-day all-day spans → per-week lane bars; other single-day items →
  // per-day lists.
  const { barsByWeek, itemsByDay } = useMemo(() => {
    const barsByWeek = weeks.map(() => [] as LaneBar[]);
    const itemsByDay = new Map<string, DayItem[]>();
    const push = (map: Map<string, DayItem[]>, day: string, item: DayItem) => {
      const list = map.get(day) ?? [];
      list.push(item);
      map.set(day, list);
    };
    const addLane = (key: string, o: CalendarOccurrence, item: DayIndexSpan, start?: number) => {
      for (let w = 0; w < weeks.length; w += 1) {
        const itemPart = inWeek(item, w);
        if (!itemPart) continue;
        barsByWeek[w].push({ key, o, item: itemPart, start });
      }
    };
    for (const span of placed.allDay) {
      if (span.endIndex > span.startIndex || span.continuesBefore || span.continuesAfter) {
        addLane(span.key, span.occurrence, span);
      } else {
        push(itemsByDay, days[span.startIndex]!, { occurrence: span.occurrence });
      }
    }
    const seen = new Set<string>();
    for (const seg of placed.timed) {
      const k = `${seg.key}:${seg.day}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const item: DayItem = {
        occurrence: seg.occurrence,
        start: seg.continuesBefore ? undefined : seg.start,
      };
      push(itemsByDay, seg.day, item);
    }
    for (const list of itemsByDay.values()) {
      list.sort((a, b) => (a.start ?? -1) - (b.start ?? -1));
    }
    return { barsByWeek, itemsByDay };
  }, [occurrences, placed, weeks, days, zone]);

  const intervalDays = useMemo(() => intervalsByDay(intervals ?? []), [intervals]);

  const [focusIndex, setFocusIndex] = useState(() => Math.max(0, days.indexOf(today)));
  // Moving on to a month with fewer weeks keeps a tab stop (its last cell).
  const tabStop = Math.min(focusIndex, days.length - 1);
  const [more, setMore] = useState<{ day: string; anchor: HTMLElement } | null>(null);

  const cellKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (event.target !== event.currentTarget) return;
    const delta: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const d = delta[event.key];
    if (d !== undefined && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      const next = Math.min(Math.max(index + d, 0), days.length - 1);
      setFocusIndex(next);
      (
        event.currentTarget.parentElement?.parentElement?.querySelector(
          `[data-day-index="${next}"]`
        ) as HTMLElement | null
      )?.focus();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const day = days[index]!;
      onDraft({ kind: 'all_day', startDate: day, endDate: addDays(day, 1) }, event.currentTarget);
    }
  };

  // A one-day all-day chip keeps its right edge: a date range grows from there.
  const chip = (item: DayItem, keySuffix = '') => (
    <OccurrenceItem
      key={`${item.occurrence.key}${keySuffix}`}
      occurrence={item.occurrence}
      color={colorOf(item.occurrence.calendarId)}
      variant="chip"
      startMinutes={item.start}
      ariaLabel={ariaLabelFor(item.occurrence, zone)}
      hover={hoverText(item.occurrence, zone, calendarsById.get(item.occurrence.calendarId))}
      onOpen={onOpenItem}
      onKeyDown={onItemKeyDown}
      onDragStart={onItemDragStart}
      onContextMenu={onItemContextMenu}
      resize={item.occurrence.time.kind === 'all_day' ? 'end' : 'none'}
    />
  );

  // Drag ghost: a chip in the day cell the item would land on (snaps to a day).
  const dragTime = dragPreview?.time;
  const ghostDay = !dragTime
    ? null
    : dragTime.kind === 'all_day'
      ? dragTime.startDate
      : instantToZoned(dragTime.start, zone).date;

  return (
    <div className={styles.monthGrid} role="grid" aria-label="Calendar" aria-colcount={7}>
      <div className={styles.monthHead} role="row">
        {weeks[0].map((day) => (
          <div key={day} className={styles.monthHeadCell} role="columnheader">
            {weekdayShort(day)}
          </div>
        ))}
      </div>
      <div
        className={styles.monthBody}
        style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {weeks.map((week, w) => {
          const bars = barsByWeek[w]!;
          const lanes = allDayLanes(
            bars.map((b) => ({
              key: b.key,
              startIndex: b.item?.startIndex ?? 6,
              endIndex: b.item?.endIndex ?? 0,
            }))
          );
          const barLanes = bars.reduce((n, b) => Math.max(n, (lanes.get(b.key) ?? 0) + 1), 0);
          return (
            <div
              key={week[0]}
              className={styles.monthWeek}
              role="row"
              style={{ ['--bar-lanes' as string]: barLanes }}
            >
              {week.map((day, i) => {
                const index = w * 7 + i;
                const items = itemsByDay.get(day) ?? [];
                // Rows left under this week's spanning bars; the last row
                // becomes "+N more" when the day has more than fit.
                // Always at least 2 chips before "+N more".
                const room = Math.max(maxPerCell - barLanes, 2);
                const fits = items.length <= room ? items.length : Math.max(room - 1, 2);
                const hidden = items.length - fits;
                const isGhost = draft?.kind === 'all_day' && draft.startDate === day;
                return (
                  <div
                    key={day}
                    role="gridcell"
                    data-day-index={index}
                    data-cal-drop="month"
                    data-cal-day={day}
                    tabIndex={index === tabStop ? 0 : -1}
                    aria-label={longDayLabel(day)}
                    className={cn(
                      styles.monthCell,
                      day.slice(0, 7) !== month && styles.otherMonth,
                      day === today && styles.monthToday
                    )}
                    onFocus={(e) => {
                      if (e.target === e.currentTarget) setFocusIndex(index);
                    }}
                    onKeyDown={(e) => cellKeyDown(e, index)}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button')) return;
                      onDraft(
                        { kind: 'all_day', startDate: day, endDate: addDays(day, 1) },
                        e.currentTarget
                      );
                    }}
                  >
                    <div className={styles.cellHead}>
                      <button
                        type="button"
                        className={styles.dateNum}
                        aria-label={`Open ${longDayLabel(day).replace(',', '')}`}
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDay(day);
                        }}
                      >
                        {dayOfMonth(day)}
                      </button>
                      {onOpenInterval && (
                        <IntervalDots
                          spans={intervalDays.get(day)}
                          colorOf={colorOf}
                          onOpen={onOpenInterval}
                        />
                      )}
                    </div>
                    <div className={styles.monthItems}>
                      {items.slice(0, fits).map((item) => chip(item))}
                      {hidden > 0 && (
                        <button
                          type="button"
                          className={styles.moreLink}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMore({ day, anchor: e.currentTarget });
                          }}
                        >
                          +{hidden} more
                        </button>
                      )}
                      {ghostDay === day && (
                        <div
                          data-calendar-drag-ghost=""
                          className={cn(
                            styles.ghost,
                            styles.dragGhost,
                            !dragPreview?.valid && styles.ghostInvalid
                          )}
                        >
                          {dragPreview?.label}
                        </div>
                      )}
                      {isGhost && (
                        <div
                          ref={ghostRef}
                          data-calendar-ghost=""
                          {...calendarColorProps(draftColor)}
                          className={cn(styles.ghost, styles.draftGhost)}
                        >
                          New event
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {bars.length > 0 && (
                <div className={styles.monthBars} aria-hidden={false}>
                  {bars.map((b) => {
                    const row = (lanes.get(b.key) ?? 0) + 1;
                    return (
                      <Fragment key={b.key}>
                        {b.item && (
                          <OccurrenceItem
                            occurrence={b.o}
                            color={colorOf(b.o.calendarId)}
                            variant="bar"
                            startMinutes={b.item.cb ? undefined : b.start}
                            ariaLabel={ariaLabelFor(b.o, zone)}
                            hover={hoverText(b.o, zone, calendarsById.get(b.o.calendarId))}
                            continuesBefore={b.item.cb}
                            continuesAfter={b.item.ca}
                            style={{
                              gridColumn: `${b.item.startIndex + 1} / ${b.item.endIndex + 2}`,
                              gridRow: row,
                            }}
                            onOpen={onOpenItem}
                            onKeyDown={onItemKeyDown}
                            onDragStart={onItemDragStart}
                            onContextMenu={onItemContextMenu}
                            resize={b.item.ca ? 'none' : 'end'}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {more && (
        <AnchoredSurface
          anchor={more.anchor}
          label={`${longDayLabel(more.day)} items`}
          width={260}
          onDismiss={() => setMore(null)}
        >
          {/* The date opens that day, like the cell's date number. */}
          <button
            type="button"
            className={popoverStyles.moreTitle}
            aria-label={`Open ${longDayLabel(more.day).replace(',', '')}`}
            onClick={() => {
              setMore(null);
              onOpenDay(more.day);
            }}
          >
            {longDayLabel(more.day)}
          </button>
          <div className={popoverStyles.moreList}>
            {[
              ...placed.allDay
                .filter(
                  (s) =>
                    s.startIndex <= days.indexOf(more.day) && s.endIndex >= days.indexOf(more.day)
                )
                .map((s) => ({ occurrence: s.occurrence }) as DayItem),
              ...[...(itemsByDay.get(more.day) ?? [])]
                .filter((item) => item.occurrence.time.kind === 'timed')
                .sort((a, b) => (a.start ?? -1) - (b.start ?? -1)),
            ].map((item) => (
              <OccurrenceItem
                key={item.occurrence.key}
                occurrence={item.occurrence}
                color={colorOf(item.occurrence.calendarId)}
                variant="chip"
                startMinutes={
                  item.occurrence.time.kind === 'timed'
                    ? instantToZoned(item.occurrence.time.start, zone).minutes
                    : undefined
                }
                ariaLabel={ariaLabelFor(item.occurrence, zone)}
                hover={hoverText(
                  item.occurrence,
                  zone,
                  calendarsById.get(item.occurrence.calendarId)
                )}
                onOpen={(o, el, focusTitle) => {
                  setMore(null);
                  onOpenItem(o, el, focusTitle);
                }}
                onKeyDown={onItemKeyDown}
              />
            ))}
          </div>
        </AnchoredSurface>
      )}
    </div>
  );
}
