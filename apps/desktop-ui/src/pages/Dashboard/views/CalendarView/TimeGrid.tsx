/**
 * Week / 3-day / Day grid: sticky day headers and all-day band, a time
 * gutter, and day columns of 30-minute gridcells with a roving tabindex.
 * A click on an empty slot opens quick add for 30 minutes; a press and sweep
 * (`createSweep.ts`) picks a range. A press while a popover or menu is open
 * only closes it. Positions come from minutes times the pane's scale
 * (`useTimeScaleContext`), never from pointer offsets.
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { cn } from '@desktop/utils/classNames';
import { startCalendarDrag } from '@desktop/features/calendar/calendarDrag';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { AnchoredSurface } from '@desktop/features/calendar/AnchoredSurface';
import popoverStyles from '@desktop/features/calendar/CalendarPopovers.module.scss';
import {
  columnAtX,
  sameSlot,
  sweepAllDay,
  sweepLabel,
  sweepTimed,
  timedPieces,
  type GridPoint,
} from '@desktop/features/calendar/createSweep';
import { minutesAtY } from '@desktop/features/calendar/occurrenceMoves';
import type { QuickAddSlot } from '@desktop/features/calendar/QuickAddPopover';
import {
  addDays,
  dayOfMonth,
  formatClock,
  formatMinutes,
  instantToZoned,
  longDayLabel,
  weekdayShort,
} from '@desktop/features/calendar/calendarDates';
import {
  allDayLanes,
  type TimedSegment,
  INTERVAL_LANE_PAD_PX,
  intervalLane,
  intervalStart,
  intervalsByDay,
  openingScrollMinutes,
  packTimed,
  placeOccurrences,
} from '@desktop/features/calendar/calendarLayout';
import { showsDots } from '@desktop/features/calendar/timeScale';
import { OccurrenceItem } from './OccurrenceItem';
import { IntervalLine, IntervalRunDots } from './IntervalMarks';
import {
  PointClusterMark,
  PointMark,
  clusterOfSegment,
  clusterPoints,
  isPointRow,
  pointSegment,
  type PointCluster,
} from './PointMarks';
import { ariaLabelFor, hoverText } from './occurrenceText';
import type { GridProps } from './gridTypes';
import { useRenderWindow, useTimeScaleContext, type ViewportStore } from './timeScaleContext';
import styles from './CalendarView.module.scss';

const SLOT_MIN = 30;
const SLOTS = (24 * 60) / SLOT_MIN;
const MIN_BLOCK_PX = 22;
/** The all-day band's most lanes; past that the last one holds each day's "+N". */
const ALL_DAY_ROWS = 3;
/** The "+N" list key for a day's all-day items (a block's list uses its own key). */
const ALL_DAY_MORE = 'all-day';
/** Open surfaces a press closes first: it must not also add (one click, one layer). */
const OPEN_LAYER_SELECTOR = '[data-floating-layer], [role="menu"], [aria-modal="true"]';

export function useNowMinutes(zone: string): { date: string; minutes: number } {
  const [now, setNow] = useState(() => instantToZoned(new Date().toISOString(), zone));
  useEffect(() => {
    const tick = () => setNow(instantToZoned(new Date().toISOString(), zone));
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [zone]);
  return now;
}

/**
 * Gutter labels between the hours (":15", "9:05"), only around the visible
 * range: at 5-minute labels a whole day would be hundreds of them.
 */
function MinorLabels({
  px,
  step,
  narrow,
  viewport,
}: {
  px: number;
  step: number;
  narrow: boolean;
  viewport: ViewportStore;
}) {
  const range = useRenderWindow(viewport);
  const labels: number[] = [];
  for (let m = Math.ceil(range.from / step) * step; m < range.to; m += step) {
    if (m % 60 !== 0) labels.push(m);
  }
  return (
    <>
      {labels.map((m) => (
        <div
          key={m}
          className={cn(styles.hourLabel, styles.minorLabel)}
          style={{ top: m * px }}
          data-minor-label=""
        >
          {narrow ? `:${String(m % 60).padStart(2, '0')}` : formatClock(m)}
        </div>
      ))}
    </>
  );
}

export function TimeGrid({
  days,
  today,
  zone,
  occurrences,
  intervals,
  onOpenInterval,
  calendarsById,
  colorOf,
  narrow,
  draft,
  draftColor,
  onDraft,
  focusDay = null,
  onOpenItem,
  onOpenDay,
  onItemKeyDown,
  ghostRef,
  itemsReady = true,
  dragPreview = null,
  onItemDragStart,
  onItemContextMenu,
}: GridProps) {
  const scale = useTimeScaleContext();
  const { px, snapStep, tickStep, labelStep } = scale;
  /** Minutes → layout px down the day. */
  const y = (minutes: number) => minutes * px;
  // A row with a time and no end is a dot and hairline, not a block.
  const points = useMemo(() => {
    const byDay = new Map<string, { o: (typeof occurrences)[number]; minutes: number }[]>();
    for (const o of occurrences) {
      if (!isPointRow(o) || o.time.kind !== 'timed') continue;
      const at = instantToZoned(o.time.start, zone);
      if (!days.includes(at.date)) continue;
      byDay.set(at.date, [...(byDay.get(at.date) ?? []), { o, minutes: at.minutes }]);
    }
    return byDay;
  }, [occurrences, days, zone]);
  // Points that would overlap at this scale draw as one "+N" mark.
  const pointClusters = useMemo(() => {
    const byDay = new Map<string, PointCluster[]>();
    for (const [day, list] of points) byDay.set(day, clusterPoints(list, px));
    return byDay;
  }, [points, px]);
  // The open point group's list: its day and first key, read live so a refetch updates it.
  const [pointList, setPointList] = useState<{
    day: string;
    key: string;
    anchor: HTMLElement;
  } | null>(null);
  const pointListItems = pointList
    ? ((pointClusters.get(pointList.day) ?? []).find((c) => c.key === pointList.key)?.points ?? [])
    : [];
  const pointListOpen = pointList !== null && pointListItems.length > 1;
  useEffect(() => {
    if (pointList && pointListItems.length <= 1) setPointList(null);
  }, [pointList, pointListItems.length]);
  const placed = useMemo(
    () =>
      placeOccurrences(
        occurrences.filter((o) => !isPointRow(o)),
        days,
        zone
      ),
    [occurrences, days, zone]
  );
  const lanes = useMemo(() => allDayLanes([...placed.allDay]), [placed.allDay]);
  const laneCount = placed.allDay.reduce((n, s) => Math.max(n, (lanes.get(s.key) ?? 0) + 1), 0);
  // At most three lanes: with more, two show and the third is each day's "+N".
  const allDayOverflow = laneCount > ALL_DAY_ROWS;
  const visibleLanes = allDayOverflow ? ALL_DAY_ROWS - 1 : laneCount;
  const bandRows = Math.max(Math.min(laneCount, ALL_DAY_ROWS), 1);
  /** A day's all-day items in lane order (what its "+N" list shows). */
  const allDayOn = (dayIndex: number) =>
    placed.allDay
      .filter((s) => s.startIndex <= dayIndex && s.endIndex >= dayIndex)
      .sort((a, b) => (lanes.get(a.key) ?? 0) - (lanes.get(b.key) ?? 0));
  const hiddenAllDayOn = (dayIndex: number) =>
    allDayOverflow
      ? allDayOn(dayIndex).filter((s) => (lanes.get(s.key) ?? 0) >= visibleLanes).length
      : 0;
  // The open "+N" list: the items one block's marker hides, or a day's
  // all-day items (`key` ALL_DAY_MORE).
  const [more, setMore] = useState<{ day: string; key: string; anchor: HTMLElement } | null>(null);
  const now = useNowMinutes(zone);

  // Drag ghost: drawn at the snapped preview from minutes / day indexes,
  // never from pointer px, so the pane's CSS zoom can't skew it.
  const dragTime = dragPreview?.time;
  // One piece per day the preview covers (a range row can run over several);
  // the label sits on the first.
  const timedGhosts = useMemo(() => {
    const map = new Map<string, { start: number; end: number; first: boolean }>();
    if (dragTime?.kind !== 'timed') return map;
    const start = instantToZoned(dragTime.start, zone);
    const end = instantToZoned(dragTime.end, zone);
    for (let day = start.date, i = 0; day <= end.date && i < 62; day = addDays(day, 1), i++) {
      const from = day === start.date ? start.minutes : 0;
      const to = day === end.date ? end.minutes : 24 * 60;
      if (day !== start.date && to <= 0) break; // ends at this midnight
      map.set(day, { start: from, end: Math.max(to, from + 15), first: day === start.date });
    }
    return map;
  }, [dragTime, zone]);
  const allDayGhost = useMemo(() => {
    if (dragTime?.kind !== 'all_day') return null;
    const last = addDays(dragTime.endDate, -1);
    const start = days.indexOf(dragTime.startDate);
    const end = days.indexOf(last);
    if (start === -1 && end === -1) return null;
    return { start: start === -1 ? 0 : start, end: end === -1 ? days.length - 1 : end };
  }, [dragTime, days]);

  // Every automations' lines, per day in lane order.
  const intervalDays = useMemo(() => intervalsByDay(intervals ?? []), [intervals]);

  // A point group packs as a segment as tall as its mark, beside the blocks.
  const packedByDay = useMemo(() => {
    const map = new Map<string, ReturnType<typeof packTimed>>();
    for (const day of days) {
      const marks = (pointClusters.get(day) ?? []).map((c) => pointSegment(c, day, px));
      map.set(day, packTimed([...placed.timed.filter((s) => s.day === day), ...marks]));
    }
    return map;
  }, [placed.timed, pointClusters, days, px]);

  /** What a list shows for packed segments: a point group's stand-in lists its points. */
  const listEntries = (day: string, segments: readonly TimedSegment[]) =>
    segments.flatMap((segment) => {
      const cluster = clusterOfSegment(segment.key, pointClusters.get(day));
      if (cluster)
        return cluster.points.map((p) => ({ key: p.o.key, occurrence: p.o, start: p.minutes }));
      return [
        {
          key: segment.key,
          occurrence: segment.occurrence,
          start: segment.continuesBefore ? undefined : segment.start,
        },
      ];
    });

  // Read live from the packing, so a refetch updates (or closes) an open list.
  const moreItems: { key: string; occurrence: CalendarOccurrence; start?: number }[] = !more
    ? []
    : more.key === ALL_DAY_MORE
      ? allDayOn(days.indexOf(more.day)).map((s) => ({ key: s.key, occurrence: s.occurrence }))
      : listEntries(
          more.day,
          (packedByDay.get(more.day) ?? []).find((p) => p.key === more.key)?.more ?? []
        );
  const moreOpen = more !== null && moreItems.length > 0;
  // A refetch that empties the list closes it for good, so "+N" isn't left
  // aria-expanded and doesn't reopen itself when items come back.
  useEffect(() => {
    if (more && moreItems.length === 0) setMore(null);
  }, [more, moreItems.length]);

  // A day picked in the mini month (Week / 3-day): its header wears a focus
  // ring and the grid's tab stop moves onto it.
  const markedDay = days.length > 1 && focusDay && days.includes(focusDay) ? focusDay : null;

  // Roving focus over slots: [dayIndex, slotIndex].
  const [focus, setFocus] = useState<[number, number]>([
    Math.max(0, days.indexOf(markedDay ?? today)),
    18,
  ]);
  const [lastMarked, setLastMarked] = useState(markedDay);
  if (markedDay !== lastMarked) {
    setLastMarked(markedDay);
    if (markedDay) setFocus(([, s]) => [days.indexOf(markedDay), s]);
  }
  const slotRefs = useRef(new Map<string, HTMLDivElement>());
  const focusSlot = (d: number, s: number) => {
    const dd = Math.min(Math.max(d, 0), days.length - 1);
    const ss = Math.min(Math.max(s, 0), SLOTS - 1);
    setFocus([dd, ss]);
    slotRefs.current.get(`${dd}:${ss}`)?.focus();
  };

  // Opening scroll: 1 h before the earlier of the first timed item and
  // now (today shown), else 8 AM. The grid remounts per view / range (its
  // key), so this runs on first paint, and once more when this range's items
  // arrive, unless the user scrolled (or zoomed) meanwhile. Refetches keep
  // the scroll. It compares minutes, so a scale change that keeps the top
  // (the pane resized at fit) doesn't read as a scroll.
  const bodyRef = useRef<HTMLDivElement>(null);
  const opening = useRef<{ settled: boolean; top: number | null }>({ settled: false, top: null });
  const nowShown = days.includes(today) ? now.minutes : null;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useLayoutEffect(() => {
    const { registerGrid } = scaleRef.current;
    registerGrid(bodyRef.current);
    return () => registerGrid(null);
  }, []);
  useLayoutEffect(() => {
    const state = opening.current;
    if (state.settled) return;
    const { topMinute, scrollToMinute, px: scalePx } = scaleRef.current;
    if (state.top !== null && Math.abs(topMinute() - state.top) * scalePx > 1) {
      state.settled = true; // the user scrolled (or zoomed) before the items came
      return;
    }
    scrollToMinute(openingScrollMinutes(itemsReady ? placed.timed : [], nowShown));
    state.top = topMinute();
    if (itemsReady) state.settled = true;
  }, [itemsReady, placed.timed, nowShown]);

  const slotKeyDown = (event: KeyboardEvent<HTMLDivElement>, d: number, s: number) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
    };
    const move = moves[event.key];
    if (move && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      focusSlot(d + move[0], s + move[1]);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const start = s * SLOT_MIN;
      onDraft({ kind: 'timed', day: days[d]!, start, end: start + 30 }, event.currentTarget);
    }
  };

  /** Start minutes of the snap step of 30-minute slot `s` under the pointer. */
  const pressedMinutes = (el: HTMLElement, clientY: number, s: number) => {
    // A ratio of two viewport-px measures, so the pane's CSS zoom cancels out.
    const rect = el.getBoundingClientRect();
    const ratio =
      rect.height > 0 ? Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1) : 0;
    const within = Math.floor((ratio * SLOT_MIN) / snapStep) * snapStep;
    return s * SLOT_MIN + Math.min(within, SLOT_MIN - snapStep);
  };

  // Click or drag to create
  // Press on empty grid (never an item: items aren't inside the slots). A
  // press without travel past the drag threshold is a click: quick add for
  // the slot under it (`clickSlot`). Past the threshold it sweeps: the ghost
  // follows live and release opens quick add with the range (its click is
  // swallowed, so it never adds a second one). A press while a popover or
  // menu is open closes that and adds nothing. The grid has no touch drags.
  const [sweep, setSweep] = useState<QuickAddSlot | null>(null);
  const cancelSweep = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelSweep.current?.(), []);
  const trackRef = useRef<HTMLDivElement>(null);
  // Whether a popover or menu was open when this press began. Read in the
  // window's capture phase, before the press can close it.
  const layerOpenAtPress = useRef(false);
  useEffect(() => {
    const note = () => {
      layerOpenAtPress.current = document.querySelector(OPEN_LAYER_SELECTOR) !== null;
    };
    window.addEventListener('pointerdown', note, true);
    return () => window.removeEventListener('pointerdown', note, true);
  }, []);

  const startSweep = (
    event: PointerEvent<HTMLElement>,
    scroller: HTMLElement | null,
    resolve: (clientX: number, clientY: number) => QuickAddSlot,
    clickSlot: QuickAddSlot
  ) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
      return;
    if (event.pointerType === 'touch') return;
    const anchor = event.currentTarget;
    const closesALayer = layerOpenAtPress.current;
    cancelSweep.current?.();
    cancelSweep.current = startCalendarDrag<QuickAddSlot>({
      scroller,
      zoomOf: anchor,
      startX: event.clientX,
      startY: event.clientY,
      cursor: 'crosshair',
      resolve,
      onPreview: (slot) => setSweep((prev) => (slot && prev && sameSlot(prev, slot) ? prev : slot)),
      onDrop: (slot) => onDraft(slot, anchor),
      onEnd: (dragged) => {
        setSweep(null);
        cancelSweep.current = null;
        if (!dragged && !closesALayer) onDraft(clickSlot, anchor);
      },
    });
  };

  /** The day column and minutes under a viewport point (clamped into the grid). */
  const timedPointAt = (clientX: number, clientY: number): GridPoint | null => {
    const cols = Array.from(
      bodyRef.current?.querySelectorAll<HTMLElement>('[data-cal-drop="timed"]') ?? []
    );
    if (cols.length === 0) return null;
    const rects = cols.map((c) => c.getBoundingClientRect());
    const dayIndex = columnAtX(rects, clientX);
    return { dayIndex, minutes: minutesAtY(clientY, rects[dayIndex]!) };
  };

  const startTimedSweep = (event: PointerEvent<HTMLDivElement>, d: number, s: number) => {
    const from: GridPoint = {
      dayIndex: d,
      minutes: pressedMinutes(event.currentTarget, event.clientY, s),
    };
    const scroller = bodyRef.current?.closest<HTMLElement>('[data-calendar-scroll]') ?? null;
    // A click adds 30 minutes from the slot's start; zoomed in past
    // 15-minute snapping, from the quarter hour under the pointer.
    const start = snapStep >= 15 ? s * SLOT_MIN : Math.floor(from.minutes / 15) * 15;
    const click: QuickAddSlot = {
      kind: 'timed',
      day: days[d]!,
      start,
      end: Math.min(start + SLOT_MIN, 24 * 60),
    };
    startSweep(
      event,
      scroller,
      (x, cy) => sweepTimed(days, from, timedPointAt(x, cy) ?? from, snapStep),
      click
    );
  };

  const startAllDaySweep = (event: PointerEvent<HTMLDivElement>, i: number) => {
    // The band is sticky at the scroller's top: no auto-scroll for it.
    startSweep(
      event,
      null,
      (x) => {
        const cells = Array.from(
          trackRef.current?.querySelectorAll<HTMLElement>('[data-cal-drop="allday"]') ?? []
        );
        const to = cells.length
          ? columnAtX(
              cells.map((c) => c.getBoundingClientRect()),
              x
            )
          : i;
        return sweepAllDay(days, i, to);
      },
      sweepAllDay(days, i, i)
    );
  };

  // The sweep in progress, else the open quick add's slot.
  const ghostSlot = sweep ?? draft;
  const timedGhost = useMemo(
    () => (ghostSlot?.kind === 'timed' ? timedPieces(ghostSlot, days) : null),
    [ghostSlot, days]
  );
  const allDayGhostSpan = useMemo(() => {
    if (ghostSlot?.kind !== 'all_day') return null;
    const start = days.indexOf(ghostSlot.startDate);
    if (start === -1) return null;
    const end = days.indexOf(addDays(ghostSlot.endDate, -1));
    return { start, end: end === -1 ? days.length - 1 : Math.max(end, start) };
  }, [ghostSlot, days]);

  // The slots don't depend on the scale (their rows are `--cal-hour`), so a
  // zoom doesn't redraw them; their handlers are the latest render's.
  const slotHandlers = useRef({ slotKeyDown, startTimedSweep });
  slotHandlers.current = { slotKeyDown, startTimedSweep };
  const [focusDayIndex, focusSlotIndex] = focus;
  const slotsByDay = useMemo(
    () =>
      days.map((day, d) =>
        Array.from({ length: SLOTS }, (_, s) => (
          <div
            key={s}
            ref={(el) => {
              if (el) slotRefs.current.set(`${d}:${s}`, el);
              else slotRefs.current.delete(`${d}:${s}`);
            }}
            role="gridcell"
            tabIndex={focusDayIndex === d && focusSlotIndex === s ? 0 : -1}
            className={cn(styles.slot, s % 2 === 1 && styles.slotHalf)}
            aria-label={`${longDayLabel(day)}, ${formatMinutes(s * SLOT_MIN)}`}
            onFocus={() => setFocus([d, s])}
            onKeyDown={(e) => slotHandlers.current.slotKeyDown(e, d, s)}
            onPointerDown={(e) => slotHandlers.current.startTimedSweep(e, d, s)}
          />
        ))
      ),
    [days, focusDayIndex, focusSlotIndex]
  );

  const columns = `var(--cal-gutter) repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <div
      className={styles.timeGrid}
      data-time-grid=""
      role="grid"
      aria-label="Calendar"
      aria-colcount={days.length + 1}
      style={{ '--cal-hour': `${y(60)}px` } as CSSProperties}
      data-minute-px={px}
      data-creating={ghostSlot ? '' : undefined}
    >
      <div className={styles.timeHead} style={{ gridTemplateColumns: columns }} role="row">
        <div className={styles.gutterCorner} role="columnheader" aria-label="Time" />
        {days.map((day) => (
          <div
            key={day}
            role="columnheader"
            className={cn(
              styles.dayHead,
              day === today && styles.dayHeadToday,
              day === markedDay && styles.dayHeadMarked
            )}
          >
            <button
              type="button"
              className={styles.dayHeadButton}
              aria-label={`Open ${longDayLabel(day).replace(',', '')}`}
              onClick={() => onOpenDay(day)}
            >
              <span className={styles.dayHeadName}>{weekdayShort(day)}</span>
              <span className={styles.dayHeadNum}>{dayOfMonth(day)}</span>
            </button>
          </div>
        ))}
      </div>

      <div className={styles.allDayBand} style={{ gridTemplateColumns: columns }} role="row">
        <div className={styles.allDayLabel} role="rowheader">
          <span>{narrow ? '' : 'all-day'}</span>
        </div>
        <div
          ref={trackRef}
          className={styles.allDayTrack}
          style={{
            gridColumn: `2 / span ${days.length}`,
            gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${bandRows}, var(--cal-chip-h))`,
          }}
        >
          {days.map((day, i) => (
            <div
              key={day}
              role="gridcell"
              data-cal-drop="allday"
              data-cal-day={day}
              className={styles.allDayCell}
              style={{ gridColumn: i + 1, gridRow: `1 / span ${bandRows}` }}
              aria-label={`${longDayLabel(day)}, all day`}
              onPointerDown={(e) => startAllDaySweep(e, i)}
            />
          ))}
          {placed.allDay.map((span) => {
            const lane = lanes.get(span.key) ?? 0;
            if (lane >= visibleLanes) return null;
            return (
              <Fragment key={span.key}>
                <OccurrenceItem
                  occurrence={span.occurrence}
                  color={colorOf(span.occurrence.calendarId)}
                  variant="bar"
                  ariaLabel={ariaLabelFor(span.occurrence, zone)}
                  hover={hoverText(
                    span.occurrence,
                    zone,
                    calendarsById.get(span.occurrence.calendarId)
                  )}
                  continuesBefore={span.continuesBefore}
                  continuesAfter={span.continuesAfter}
                  style={{
                    gridColumn: `${span.startIndex + 1} / ${span.endIndex + 2}`,
                    gridRow: lane + 1,
                  }}
                  onOpen={onOpenItem}
                  onKeyDown={onItemKeyDown}
                  onDragStart={onItemDragStart}
                  onContextMenu={onItemContextMenu}
                  resize={span.continuesAfter ? 'none' : 'end'}
                />
              </Fragment>
            );
          })}
          {days.map((day, i) => {
            // The last lane: a "+N" per day with more than the lanes show.
            const hidden = hiddenAllDayOn(i);
            if (hidden === 0) return null;
            return (
              <button
                key={`more-${day}`}
                type="button"
                className={styles.allDayMore}
                data-cal-more={`${day}|${ALL_DAY_MORE}`}
                style={{ gridColumn: i + 1, gridRow: ALL_DAY_ROWS }}
                aria-label={`${hidden} more all-day on ${longDayLabel(day)}`}
                aria-haspopup="dialog"
                aria-expanded={moreOpen && more.key === ALL_DAY_MORE && more.day === day}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setMore({ day, key: ALL_DAY_MORE, anchor: e.currentTarget });
                }}
              >
                +{hidden} more
              </button>
            );
          })}
          {allDayGhost && (
            <div
              data-calendar-drag-ghost=""
              className={cn(
                styles.ghost,
                styles.dragGhost,
                !dragPreview?.valid && styles.ghostInvalid
              )}
              style={{
                gridColumn: `${allDayGhost.start + 1} / ${allDayGhost.end + 2}`,
                gridRow: 1,
              }}
            >
              {dragPreview?.label}
            </div>
          )}
          {allDayGhostSpan && (
            <div
              ref={sweep ? undefined : ghostRef}
              data-calendar-ghost=""
              data-sweeping={sweep ? '' : undefined}
              className={cn(styles.ghost, styles.draftGhost)}
              {...calendarColorProps(draftColor, {
                gridColumn: `${allDayGhostSpan.start + 1} / ${allDayGhostSpan.end + 2}`,
                gridRow: 1,
              })}
            >
              New event
            </div>
          )}
        </div>
      </div>

      <div ref={bodyRef} className={styles.timeBody} style={{ gridTemplateColumns: columns }}>
        <div className={styles.gutter} aria-hidden>
          {tickStep < 60 && (
            <div
              className={styles.gutterTicks}
              data-tick-step={tickStep}
              style={{ backgroundSize: `100% ${y(tickStep)}px` }}
            />
          )}
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className={styles.hourLabel} style={{ top: y(h * 60) }}>
              {h === 0 ? '' : formatMinutes(h * 60, { compact: narrow })}
            </div>
          ))}
          {labelStep < 60 && (
            <MinorLabels px={px} step={labelStep} narrow={narrow} viewport={scale.viewport} />
          )}
        </div>
        {days.map((day, d) => {
          const packed = packedByDay.get(day) ?? [];
          const lines = onOpenInterval ? (intervalDays.get(day) ?? []) : [];
          const lane = intervalLane(lines.length);
          // Runs with room for a dot each take the lane: the day's blocks
          // narrow by it. Lines alone draw behind the blocks, full width.
          const dotted = lines.map((span) => showsDots(span.everyMs, px));
          const laneWidth = dotted.some(Boolean) ? lane.width : 0;
          // Blocks share what the lane leaves of the column.
          const blockLeft = (share: number) =>
            laneWidth
              ? `calc(${laneWidth}px + (100% - ${laneWidth}px) * ${share} + 1px)`
              : `calc(${share * 100}% + 1px)`;
          const blockWidth = (share: number) =>
            laneWidth
              ? `calc((100% - ${laneWidth}px) * ${share} - 3px)`
              : `calc(${share * 100}% - 3px)`;
          return (
            <div
              key={day}
              className={cn(
                styles.dayColumn,
                day === today && styles.dayColumnToday,
                labelStep < SLOT_MIN && styles.dayColumnGuides
              )}
              style={
                labelStep < SLOT_MIN
                  ? ({ '--cal-guide-step': `${y(labelStep)}px` } as CSSProperties)
                  : undefined
              }
              role="row"
              data-cal-drop="timed"
              data-cal-day={day}
            >
              {slotsByDay[d]}
              {packed.map((p) => {
                const { segment } = p;
                if (p.hidden) return null;
                const left = blockLeft(p.left);
                const width = blockWidth(p.width);
                const cluster = clusterOfSegment(segment.key, pointClusters.get(day));
                // Its own button beside the item (not inside it): opens the
                // list of what it hides (every item reachable).
                const badge = (top: number) =>
                  p.moreCount > 0 && (
                    <button
                      type="button"
                      className={styles.moreBadge}
                      data-cal-more={`${day}|${segment.key}`}
                      aria-label={`${p.moreCount} more at ${formatMinutes(segment.start)}`}
                      aria-haspopup="dialog"
                      aria-expanded={moreOpen && more.key === segment.key && more.day === day}
                      title={`${p.moreCount} more`}
                      style={{ top, left: `calc(${left} + ${width} - 3px)` }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMore({ day, key: segment.key, anchor: e.currentTarget });
                      }}
                    >
                      +{p.moreCount}
                    </button>
                  );
                if (cluster) {
                  const first = cluster.points[0].o;
                  const place = { top: y(cluster.minutes), left, width };
                  if (cluster.points.length === 1)
                    return (
                      <Fragment key={segment.key}>
                        <PointMark
                          occurrence={first}
                          color={colorOf(first.calendarId)}
                          place={place}
                          ariaLabel={ariaLabelFor(first, zone)}
                          hover={hoverText(first, zone, calendarsById.get(first.calendarId))}
                          onOpen={onOpenItem}
                          onDragStart={onItemDragStart}
                          onKeyDown={onItemKeyDown}
                          onContextMenu={onItemContextMenu}
                        />
                        {badge(place.top - 8)}
                      </Fragment>
                    );
                  const lastMinutes = cluster.points[cluster.points.length - 1].minutes;
                  const span =
                    lastMinutes === cluster.minutes
                      ? formatMinutes(cluster.minutes)
                      : `${formatMinutes(cluster.minutes)}–${formatMinutes(lastMinutes)}`;
                  return (
                    <Fragment key={segment.key}>
                      <PointClusterMark
                        cluster={cluster}
                        color={colorOf(first.calendarId)}
                        place={place}
                        firstTitle={first.title}
                        ariaLabel={`${cluster.points.length} items, ${span}`}
                        expanded={
                          pointListOpen && pointList.day === day && pointList.key === cluster.key
                        }
                        onOpen={(c, anchor) => setPointList({ day, key: c.key, anchor })}
                      />
                      {badge(place.top - 8)}
                    </Fragment>
                  );
                }
                const top = y(segment.start);
                const height = Math.max(y(segment.end - segment.start), MIN_BLOCK_PX);
                return (
                  <Fragment key={`${segment.key}:${day}`}>
                    <OccurrenceItem
                      occurrence={segment.occurrence}
                      color={colorOf(segment.occurrence.calendarId)}
                      variant="block"
                      compact={height < 36}
                      startMinutes={segment.continuesBefore ? undefined : segment.start}
                      ariaLabel={ariaLabelFor(segment.occurrence, zone)}
                      hover={hoverText(
                        segment.occurrence,
                        zone,
                        calendarsById.get(segment.occurrence.calendarId)
                      )}
                      continuesBefore={segment.continuesBefore}
                      continuesAfter={segment.continuesAfter}
                      style={{ top, height, left, width }}
                      onOpen={onOpenItem}
                      onKeyDown={onItemKeyDown}
                      onDragStart={onItemDragStart}
                      onContextMenu={onItemContextMenu}
                      resize={
                        segment.continuesAfter
                          ? 'none'
                          : height >= 30 && !segment.continuesBefore
                            ? 'both'
                            : 'end'
                      }
                    />
                    {badge(top + 1)}
                  </Fragment>
                );
              })}
              {lines.map((span, i) => {
                const start = intervalStart(span, zone);
                const left = INTERVAL_LANE_PAD_PX + i * lane.step;
                if (dotted[i]) {
                  return (
                    <IntervalRunDots
                      key={span.key}
                      span={span}
                      color={colorOf(span.calendarId)}
                      zone={zone}
                      px={px}
                      startMinutes={start.minutes}
                      left={left}
                      width={lane.step}
                      viewport={scale.viewport}
                      onOpen={onOpenInterval!}
                    />
                  );
                }
                return (
                  <IntervalLine
                    key={span.key}
                    span={span}
                    color={colorOf(span.calendarId)}
                    startMinutes={start.minutes}
                    startsHere={start.startsHere}
                    onOpen={onOpenInterval!}
                    style={{
                      top: y(start.minutes),
                      height: y(24 * 60 - start.minutes),
                      left,
                      width: lane.step,
                    }}
                  />
                );
              })}
              {(() => {
                const ghost = timedGhosts.get(day);
                if (!ghost) return null;
                return (
                  <div
                    data-calendar-drag-ghost={ghost.first ? '' : undefined}
                    className={cn(
                      styles.ghost,
                      styles.ghostTimed,
                      styles.dragGhost,
                      !dragPreview?.valid && styles.ghostInvalid
                    )}
                    style={{
                      top: y(ghost.start),
                      height: Math.max(y(ghost.end - ghost.start), MIN_BLOCK_PX),
                    }}
                  >
                    {ghost.first ? dragPreview?.label : null}
                  </div>
                );
              })()}
              {(() => {
                const piece = timedGhost?.get(day);
                if (!piece || ghostSlot?.kind !== 'timed') return null;
                return (
                  <div
                    ref={piece.first && !sweep ? ghostRef : undefined}
                    data-calendar-ghost=""
                    data-sweeping={sweep ? '' : undefined}
                    className={cn(styles.ghost, styles.ghostTimed, styles.draftGhost)}
                    {...calendarColorProps(draftColor, {
                      top: y(piece.start),
                      height: Math.max(y(piece.end - piece.start), MIN_BLOCK_PX),
                    })}
                  >
                    {piece.first ? sweepLabel(ghostSlot) : null}
                  </div>
                );
              })()}
              {day === now.date && (
                <div className={styles.nowLine} style={{ top: y(now.minutes) }} aria-hidden />
              )}
            </div>
          );
        })}
      </div>
      {moreOpen && (
        <AnchoredSurface
          anchor={more.anchor}
          resolveAnchor={() =>
            document.querySelector<HTMLElement>(
              `[data-cal-more="${CSS.escape(`${more.day}|${more.key}`)}"]`
            )
          }
          label={
            more.key === ALL_DAY_MORE
              ? `${longDayLabel(more.day)}, ${moreItems.length} all-day`
              : `${longDayLabel(more.day)}, ${moreItems.length} more`
          }
          width={260}
          onDismiss={() => setMore(null)}
        >
          {/* The date opens that day, as in Month's "+N more". */}
          <button
            type="button"
            className={popoverStyles.moreTitle}
            aria-label={`Open ${longDayLabel(more.day).replace(',', '')}`}
            onClick={() => {
              const day = more.day;
              setMore(null);
              onOpenDay(day);
            }}
          >
            {longDayLabel(more.day)}
          </button>
          <div className={popoverStyles.moreList}>
            {moreItems.map((entry, i) => (
              <OccurrenceItem
                key={entry.key}
                occurrence={entry.occurrence}
                color={colorOf(entry.occurrence.calendarId)}
                variant="chip"
                startMinutes={entry.start}
                ariaLabel={ariaLabelFor(entry.occurrence, zone)}
                hover={hoverText(
                  entry.occurrence,
                  zone,
                  calendarsById.get(entry.occurrence.calendarId)
                )}
                autoFocusInSurface={i === 0}
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
      {pointListOpen && (
        <AnchoredSurface
          anchor={pointList.anchor}
          resolveAnchor={() =>
            document.querySelector<HTMLElement>(`[data-cal-points="${CSS.escape(pointList.key)}"]`)
          }
          label={`${longDayLabel(pointList.day)}, ${pointListItems.length} items`}
          width={260}
          onDismiss={() => setPointList(null)}
        >
          <button
            type="button"
            className={popoverStyles.moreTitle}
            aria-label={`Open ${longDayLabel(pointList.day).replace(',', '')}`}
            onClick={() => {
              const day = pointList.day;
              setPointList(null);
              onOpenDay(day);
            }}
          >
            {longDayLabel(pointList.day)}
          </button>
          <div className={popoverStyles.moreList}>
            {pointListItems.map(({ o, minutes }, i) => (
              <OccurrenceItem
                key={o.key}
                occurrence={o}
                color={colorOf(o.calendarId)}
                variant="chip"
                startMinutes={minutes}
                ariaLabel={ariaLabelFor(o, zone)}
                hover={hoverText(o, zone, calendarsById.get(o.calendarId))}
                autoFocusInSurface={i === 0}
                onOpen={(occ, el, focusTitle) => {
                  setPointList(null);
                  onOpenItem(occ, el, focusTitle);
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
