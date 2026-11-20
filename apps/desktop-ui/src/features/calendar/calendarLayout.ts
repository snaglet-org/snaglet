/**
 * Pure layout for the grids: where each occurrence lands in the visible days
 * (viewer zone), Google-style packing of overlapping timed blocks, lane
 * assignment for all-day bars / Month spans, and a repeating row's set-day dashed
 * Due tail (docs/architecture.md). Every automations' lines and run dots sit in a
 * lane of their own at a day column's left edge ({@link intervalLane}).
 */
import type { CalendarIntervalSpan, CalendarOccurrence } from '@snaglet/shared/types';
import { nextWindowedIntervalRun } from '@snaglet/shared/utils';
import { addDays, instantToZoned, lastDate, zonedToInstant } from './calendarDates';
import { runTimes } from './timeScale';

export interface TimedSegment {
  key: string;
  day: string;
  /** Minutes after the day's midnight. */
  start: number;
  end: number;
  occurrence: CalendarOccurrence;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

interface AllDaySpan {
  key: string;
  occurrence: CalendarOccurrence;
  /** Index into the visible days, inclusive. */
  startIndex: number;
  endIndex: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface Placed {
  timed: TimedSegment[];
  allDay: AllDaySpan[];
}

export function placeOccurrences(
  occurrences: readonly CalendarOccurrence[],
  days: readonly string[],
  timeZone: string
): Placed {
  const timed: TimedSegment[] = [];
  const allDay: AllDaySpan[] = [];
  if (days.length === 0) return { timed, allDay };
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const bounds = days.map((day) => ({
    day,
    start: Date.parse(zonedToInstant(day, 0, timeZone)),
    end: Date.parse(zonedToInstant(addDays(day, 1), 0, timeZone)),
  }));

  for (const occurrence of occurrences) {
    const time = occurrence.time;
    if (time.kind === 'all_day') {
      const lastDay = lastDate(time.startDate, time.endDate);
      if (lastDay < first || time.startDate > last) continue;
      const from = time.startDate < first ? first : time.startDate;
      const to = lastDay > last ? last : lastDay;
      allDay.push({
        key: occurrence.key,
        occurrence,
        startIndex: days.indexOf(from),
        endIndex: days.indexOf(to),
        continuesBefore: time.startDate < first,
        continuesAfter: lastDay > last,
      });
      continue;
    }
    const s = Date.parse(time.start);
    let e = Date.parse(time.end);
    if (!Number.isFinite(s)) continue;
    if (!Number.isFinite(e) || e <= s) e = s + 15 * 60_000;
    for (const b of bounds) {
      if (e <= b.start || s >= b.end) continue;
      const start = s <= b.start ? 0 : instantToZoned(time.start, timeZone).minutes;
      const end = e >= b.end ? 1440 : instantToZoned(new Date(e).toISOString(), timeZone).minutes;
      timed.push({
        key: occurrence.key,
        day: b.day,
        start,
        end: Math.max(end, start + 1),
        occurrence,
        continuesBefore: s < b.start,
        continuesAfter: e > b.end,
      });
    }
  }
  return { timed, allDay };
}

export interface PackedSegment {
  key: string;
  segment: TimedSegment;
  /** Fractions of the day column. */
  left: number;
  width: number;
  /** Hidden behind a "+N" marker (would be narrower than 40 %). */
  hidden: boolean;
  /** "+N" count drawn on this block (items hidden in its group). */
  moreCount: number;
  /** The segments behind this block's "+N", in start order (`moreCount` of them). */
  more: TimedSegment[];
}

const OFFSET_STEP = 0.12;
const MIN_WIDTH = 0.4;
const NEST_GAP_MIN = 30;

/** Pack one day's timed segments. */
export function packTimed(segments: readonly TimedSegment[]): PackedSegment[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || b.end - a.end);
  const placed: PackedSegment[] = [];
  for (const segment of sorted) {
    const item: PackedSegment = {
      key: segment.key,
      segment,
      left: 0,
      width: 1,
      hidden: false,
      moreCount: 0,
      more: [],
    };
    const active = placed.filter((p) => !p.hidden && p.segment.end > segment.start);
    if (active.length === 0) {
      placed.push(item);
      continue;
    }
    if (active.every((p) => p.segment.start <= segment.start - NEST_GAP_MIN)) {
      // Starts well after everything it overlaps: offset, don't split.
      const parent = active.reduce((a, b) => (b.left > a.left ? b : a));
      item.left = Math.min(parent.left + OFFSET_STEP, 1 - MIN_WIDTH);
      item.width = Math.max(parent.left + parent.width - item.left, MIN_WIDTH);
      placed.push(item);
      continue;
    }
    // Starts close to something it overlaps: share that group's width.
    const siblings = active.filter((p) => p.segment.start > segment.start - NEST_GAP_MIN);
    const left0 = Math.min(...siblings.map((p) => p.left));
    const right0 = Math.max(...siblings.map((p) => p.left + p.width));
    const n = siblings.length + 1;
    const w = (right0 - left0) / n;
    if (w < MIN_WIDTH) {
      item.hidden = true;
      const lastShown = siblings.reduce((a, b) => (b.left > a.left ? b : a));
      lastShown.moreCount += 1;
      lastShown.more.push(segment);
      placed.push(item);
      continue;
    }
    siblings
      .sort((a, b) => a.left - b.left)
      .forEach((p, i) => {
        p.left = left0 + w * i;
        p.width = w;
      });
    item.left = left0 + w * siblings.length;
    item.width = w;
    placed.push(item);
  }
  return placed;
}

/** Greedy lanes for spans over day indexes (all-day band, Month weeks). */
export function allDayLanes(
  spans: ReadonlyArray<{ key: string; startIndex: number; endIndex: number }>
): Map<string, number> {
  const sorted = [...spans].sort(
    (a, b) => a.startIndex - b.startIndex || b.endIndex - b.startIndex - (a.endIndex - a.startIndex)
  );
  const laneEnds: number[] = [];
  const lanes = new Map<string, number>();
  for (const span of sorted) {
    let lane = laneEnds.findIndex((end) => end < span.startIndex);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.endIndex);
    } else {
      laneEnds[lane] = span.endIndex;
    }
    lanes.set(span.key, lane);
  }
  return lanes;
}

/**
 * Week / Day opening scroll, in minutes from midnight:
 * 1 hour before the earlier of the first timed item in the visible days and
 * now (when today is visible), clamped at 0; 8 AM when there is neither.
 */
export function openingScrollMinutes(
  timed: readonly Pick<TimedSegment, 'start'>[],
  nowMinutes: number | null
): number {
  let earliest = nowMinutes ?? Infinity;
  for (const s of timed) if (s.start < earliest) earliest = s.start;
  return earliest === Infinity ? 8 * 60 : Math.max(0, earliest - 60);
}

/** A run of visible day indexes (inclusive), and whether it runs on past either end. */
export interface DayIndexSpan {
  startIndex: number;
  endIndex: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** Every automations' spans by day, each day's in lane order: oldest start first, then id. */
export function intervalsByDay(
  spans: readonly CalendarIntervalSpan[]
): Map<string, CalendarIntervalSpan[]> {
  const map = new Map<string, CalendarIntervalSpan[]>();
  for (const span of spans) {
    const list = map.get(span.day) ?? [];
    list.push(span);
    map.set(span.day, list);
  }
  for (const list of map.values()) {
    list.sort(
      (a, b) =>
        Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
        (a.automationId < b.automationId ? -1 : a.automationId > b.automationId ? 1 : 0)
    );
  }
  return map;
}

/** One Every line's share of the lane, in layout px (it narrows when there are many). */
const INTERVAL_LANE_STEP_PX = 8;
/** The widest the lane gets: past this the lines move closer together. */
const INTERVAL_LANE_MAX_PX = 34;
/** Space before the first line, off the column's border. */
export const INTERVAL_LANE_PAD_PX = 2;

/**
 * The lane `count` Every lines take at a day column's left edge: each line's
 * step and the lane's total width (0 with none, so the day's blocks keep the
 * whole column).
 */
export function intervalLane(count: number): { step: number; width: number } {
  if (count <= 0) return { step: 0, width: 0 };
  const room = INTERVAL_LANE_MAX_PX - INTERVAL_LANE_PAD_PX;
  const step = Math.max(4, Math.min(INTERVAL_LANE_STEP_PX, room / count));
  return { step, width: INTERVAL_LANE_PAD_PX + step * count };
}

/**
 * Where a span's line begins on its day: at its start time on the day it
 * started (`startsHere`), else at midnight.
 */
export function intervalStart(
  span: CalendarIntervalSpan,
  timeZone: string
): { minutes: number; startsHere: boolean } {
  const start = instantToZoned(span.startsAt, timeZone);
  return start.date === span.day
    ? { minutes: start.minutes, startsHere: true }
    : { minutes: 0, startsHere: false };
}

/** One run of an Every automation on its day: the instant and its wall minutes. */
export interface IntervalRun {
  iso: string;
  minutes: number;
}

/** A windowed Every automation's run instants (ms) in [fromMs, toMs), at most `limit`. */
function windowedRunTimes(
  span: Pick<CalendarIntervalSpan, 'startsAt' | 'everyMs'>,
  window: NonNullable<CalendarIntervalSpan['window']>,
  fromMs: number,
  toMs: number,
  limit: number
): number[] {
  const out: number[] = [];
  const start = Math.max(fromMs, Date.parse(span.startsAt));
  if (!Number.isFinite(start) || !(span.everyMs > 0)) return out;
  let cursor = new Date(start - 1);
  while (out.length < limit) {
    const next = nextWindowedIntervalRun(span.everyMs, window, window.tz, cursor);
    if (next.getTime() >= toMs) break;
    out.push(next.getTime());
    cursor = next;
  }
  return out;
}

/**
 * An Every automation's runs on `span.day` between `from` and `to` minutes
 * (wall time, viewer zone): its start plus whole steps of `everyMs`, or,
 * with a daily window, the runs inside it. Only that range is worked out,
 * so a day of every-minute runs costs only what is drawn. Wall minutes are
 * linear unless the range crosses a DST change.
 */
export function intervalRunsOnDay(
  span: Pick<CalendarIntervalSpan, 'day' | 'startsAt' | 'everyMs' | 'window'>,
  timeZone: string,
  from: number,
  to: number,
  limit = 600
): IntervalRun[] {
  if (!(to > from)) return [];
  const fromMs = Date.parse(zonedToInstant(span.day, from, timeZone));
  const toMs = Date.parse(zonedToInstant(span.day, to, timeZone));
  const times = span.window
    ? windowedRunTimes(span, span.window, fromMs, toMs, limit)
    : runTimes(Date.parse(span.startsAt), span.everyMs, fromMs, toMs, limit);
  const linear = Math.abs((toMs - fromMs) / 60_000 - (to - from)) < 0.5;
  const out: IntervalRun[] = [];
  for (const t of times) {
    const iso = new Date(t).toISOString();
    if (linear) {
      out.push({ iso, minutes: from + (t - fromMs) / 60_000 });
      continue;
    }
    const wall = instantToZoned(iso, timeZone);
    if (wall.date === span.day) out.push({ iso, minutes: wall.minutes });
  }
  return out;
}
