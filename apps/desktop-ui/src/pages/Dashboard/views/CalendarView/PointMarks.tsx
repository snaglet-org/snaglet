/**
 * Table rows with a time but no end (Week / Day): a dot and a hairline at the
 * start time, like an Every automation, not a default-length block.
 *
 * Only the dot and its label (right of the dot, on the line) take the
 * pointer: a click opens the row, a press drags it to another time. The
 * hairline is drawn under them and lets presses through, so it never steals
 * a click from a block or an empty slot. Each mark takes part in the day's
 * packing as a segment as tall as itself ({@link pointSegment}), so a mark at
 * the time a block starts sits beside it, not over it.
 */
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { CalendarOccurrence } from '@snaglet/shared/types';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import type { TimedSegment } from '@desktop/features/calendar/calendarLayout';
import type { DragKind } from './dropTargets';
import type { ItemMenuEvent } from './gridTypes';
import styles from './CalendarView.module.scss';

/** A row occurrence that holds a time and no end. */
export function isPointRow(o: CalendarOccurrence): boolean {
  return o.source === 'row' && o.time.kind === 'timed' && !o.hasEnd;
}

/** One mark's height in px: points closer than this would overlap. */
export const POINT_GAP_PX = 18;

export interface PlacedPoint {
  o: CalendarOccurrence;
  minutes: number;
}

/** Points that would overlap at this scale, drawn as one mark. */
export interface PointCluster {
  key: string;
  minutes: number;
  points: PlacedPoint[];
}

/**
 * Groups a day's points so no two marks overlap: a point joins the group above
 * it when it sits within `gapPx` of that group's first point. Zooming in
 * (`px` up) splits groups back into single marks.
 */
export function clusterPoints(
  points: PlacedPoint[],
  px: number,
  gapPx = POINT_GAP_PX
): PointCluster[] {
  const sorted = [...points].sort((a, b) => a.minutes - b.minutes);
  const out: PointCluster[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && (p.minutes - last.minutes) * px < gapPx) last.points.push(p);
    else out.push({ key: p.o.key, minutes: p.minutes, points: [p] });
  }
  return out;
}

/** Key prefix of a point group's stand-in segment in a day's packing. */
const POINT_SEGMENT_PREFIX = 'points:';

/**
 * A point group as a segment for `packTimed`: as tall as its mark at this
 * scale (`px` a minute) and centered on its time, so blocks it would cover
 * share the column with it.
 */
export function pointSegment(cluster: PointCluster, day: string, px: number): TimedSegment {
  const height = Math.max(1, Math.ceil(POINT_GAP_PX / Math.max(px, 0.001)));
  const start = Math.min(Math.max(0, Math.round(cluster.minutes - height / 2)), 1440 - height);
  return {
    key: `${POINT_SEGMENT_PREFIX}${cluster.key}`,
    day,
    start,
    end: start + height,
    occurrence: cluster.points[0].o,
    continuesBefore: false,
    continuesAfter: false,
  };
}

/** The group a packed segment stands for, or null when it is a block. */
export function clusterOfSegment(
  key: string,
  clusters: readonly PointCluster[] | undefined
): PointCluster | null {
  if (!key.startsWith(POINT_SEGMENT_PREFIX)) return null;
  const clusterKey = key.slice(POINT_SEGMENT_PREFIX.length);
  return clusters?.find((c) => c.key === clusterKey) ?? null;
}

/** Where a mark sits: its time's px, and its share of the column (CSS lengths). */
interface MarkPlace {
  top: number;
  left: string;
  width: string;
}

/** The hairline across the mark's share of the column; presses pass through it. */
function PointLine({ color, place }: { color: string; place: MarkPlace }) {
  return (
    <span
      className={styles.pointLine}
      aria-hidden
      {...calendarColorProps(color, { top: place.top, left: place.left, width: place.width })}
    />
  );
}

/** The button's place: from the left of its share, never wider than it. */
const buttonStyle = (place: MarkPlace): CSSProperties => ({
  top: place.top,
  left: place.left,
  maxWidth: place.width,
});

interface PointClusterMarkProps {
  cluster: PointCluster;
  color: string;
  place: MarkPlace;
  ariaLabel: string;
  /** The first title, shown before the count. */
  firstTitle: string;
  expanded: boolean;
  onOpen: (cluster: PointCluster, el: HTMLElement) => void;
}

/** Several points at nearly one time: one dot and line, "title +N", opens the list. */
export function PointClusterMark({
  cluster,
  color,
  place,
  ariaLabel,
  firstTitle,
  expanded,
  onOpen,
}: PointClusterMarkProps) {
  return (
    <>
      <PointLine color={color} place={place} />
      <button
        type="button"
        className={styles.pointMark}
        {...calendarColorProps(color, buttonStyle(place))}
        data-point-cluster={cluster.points.length}
        data-cal-points={cluster.key}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        title={ariaLabel}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(cluster, e.currentTarget);
        }}
      >
        <span className={styles.intervalDot} aria-hidden />
        <span className={styles.pointTitle}>
          <span className={styles.pointTitleText}>{firstTitle}</span>
          <span className={styles.pointCount}>+{cluster.points.length - 1}</span>
        </span>
      </button>
    </>
  );
}

interface PointMarkProps {
  occurrence: CalendarOccurrence;
  color: string;
  place: MarkPlace;
  ariaLabel: string;
  hover: string;
  onOpen: (occurrence: CalendarOccurrence, el: HTMLElement, focusTitle?: boolean) => void;
  onDragStart?: (
    event: PointerEvent<HTMLElement>,
    occurrence: CalendarOccurrence,
    kind: DragKind
  ) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>, occurrence: CalendarOccurrence) => void;
  onContextMenu?: (event: ItemMenuEvent, occurrence: CalendarOccurrence) => void;
}

export function PointMark({
  occurrence: o,
  color,
  place,
  ariaLabel,
  hover,
  onOpen,
  onDragStart,
  onKeyDown,
  onContextMenu,
}: PointMarkProps) {
  return (
    <>
      <PointLine color={color} place={place} />
      <button
        type="button"
        className={styles.pointMark}
        {...calendarColorProps(color, buttonStyle(place))}
        data-key={o.key}
        data-calendar-item=""
        data-point=""
        data-status={o.status}
        aria-label={ariaLabel}
        title={hover}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.ctrlKey || !o.canMove || !onDragStart) return;
          onDragStart(e, o, 'move');
        }}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(e, o);
              }
            : undefined
        }
        onKeyDown={onKeyDown ? (e) => onKeyDown(e, o) : undefined}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(o, e.currentTarget);
        }}
      >
        <span className={styles.intervalDot} aria-hidden />
        <span className={styles.pointTitle}>
          <span className={styles.pointTitleText}>{o.title}</span>
        </span>
      </button>
    </>
  );
}
