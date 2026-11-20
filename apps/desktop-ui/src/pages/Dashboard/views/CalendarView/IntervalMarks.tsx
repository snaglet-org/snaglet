/**
 * Every (interval) automations on the grids. They have no end, so how they
 * draw depends on the Week / Day zoom (`timeScale.showsDots`): with room
 * between runs, a dot at each run in the day column's left lane (the day's
 * blocks narrow so the dots stay clickable); closer than that, a thin line
 * behind the blocks, from the start time on the day it started, with a dot
 * at its top. In Month it is a dot by the date. A paused one is not drawn.
 * Each mark is a button: a click, or Enter, opens the
 * automation's popover (a run's dot shows that run's time).
 */
import { useMemo, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { CalendarIntervalSpan } from '@snaglet/shared/types';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { formatMinutes } from '@desktop/features/calendar/calendarDates';
import { intervalRunsOnDay } from '@desktop/features/calendar/calendarLayout';
import { DOT_MIN_SPACING_PX } from '@desktop/features/calendar/timeScale';
import { intervalAriaLabel, intervalHover } from './occurrenceText';
import { useRenderWindow, type ViewportStore } from './timeScaleContext';
import styles from './CalendarView.module.scss';

/**
 * Opens the popover at `anchor`; focus goes back to `opener` (the mark) on
 * close. `runAt` is the run a dot stands for.
 */
export type OpenInterval = (
  span: CalendarIntervalSpan,
  anchor: HTMLElement,
  opener: HTMLElement,
  runAt?: string
) => void;

interface IntervalMarkProps {
  span: CalendarIntervalSpan;
  color: string;
  onOpen: OpenInterval;
}

const SLOT_MINUTES = 30;
const DAY_MINUTES = 24 * 60;

/**
 * Where a line's popover anchors. A line can be a whole day tall, so a
 * pointer click anchors at the half-hour slot under the pointer (found from
 * a ratio of two rect measures, so the pane's zoom cancels out); Enter, or
 * a click with no pointer place, anchors at the dot on its top.
 */
function lineAnchor(
  line: HTMLButtonElement,
  e: MouseEvent<HTMLButtonElement>,
  startMinutes: number
): HTMLElement {
  const dot = line.querySelector<HTMLElement>('[data-interval-dot]') ?? line;
  const rect = line.getBoundingClientRect();
  if (e.detail === 0 || rect.height <= 0) return dot;
  const ratio = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
  const minutes = startMinutes + ratio * (DAY_MINUTES - startMinutes);
  const slots = line.parentElement?.querySelectorAll<HTMLElement>(':scope > [role="gridcell"]');
  const slot = slots?.[Math.min(Math.floor(minutes / SLOT_MINUTES), slots.length - 1)];
  return slot ?? dot;
}

/**
 * Week / Day, runs too close for dots: the line and its dot, placed by the
 * grid (lane offset, top, height), drawn behind the day's blocks.
 */
export function IntervalLine({
  span,
  color,
  onOpen,
  style,
  startMinutes,
  startsHere,
}: IntervalMarkProps & {
  style: CSSProperties;
  /** Where the line begins on its day, in minutes after midnight. */
  startMinutes: number;
  /** It started on this day: the dot marks its start time. */
  startsHere: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.intervalLine}
      {...calendarColorProps(color, style)}
      data-interval=""
      data-key={span.key}
      data-starts={startsHere ? '' : undefined}
      aria-label={intervalAriaLabel(span)}
      title={intervalHover(span)}
      onClick={(e) => {
        // Never the column under it (the slots beside it start a quick add).
        e.stopPropagation();
        onOpen(span, lineAnchor(e.currentTarget, e, startMinutes), e.currentTarget);
      }}
    >
      <span className={styles.intervalDot} data-interval-dot="" aria-hidden />
    </button>
  );
}

/**
 * Week / Day, room between runs: a dot at each run, only around the visible
 * range (`useRenderWindow`), over a faint guide down the lane. One dot per
 * automation and day is in the tab order; ↑ / ↓ move between its dots.
 */
export function IntervalRunDots({
  span,
  color,
  zone,
  px,
  startMinutes,
  left,
  width,
  viewport,
  onOpen,
}: IntervalMarkProps & {
  zone: string;
  /** Layout px per minute. */
  px: number;
  /** Where its runs begin on this day (the start time, or midnight). */
  startMinutes: number;
  /** The dots' place in the lane (layout px). */
  left: number;
  width: number;
  viewport: ViewportStore;
}) {
  const range = useRenderWindow(viewport);
  const from = Math.max(range.from, startMinutes);
  const runs = useMemo(
    () => intervalRunsOnDay(span, zone, from, range.to),
    [span, zone, from, range.to]
  );
  const lastFocused = useRef<string | null>(null);
  const label = intervalAriaLabel(span);
  const hover = intervalHover(span);
  // The tab stop: the dot last focused, else the first at or after the view's top.
  const viewTop = viewport.get().top;
  const stop =
    runs.find((r) => r.iso === lastFocused.current)?.iso ??
    runs.find((r) => r.minutes >= viewTop)?.iso ??
    runs[0]?.iso;
  const height = DOT_MIN_SPACING_PX;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const dots = Array.from(
      e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
        `[data-interval-run][data-key="${CSS.escape(span.key)}"]`
      ) ?? []
    );
    const next = dots[dots.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
    next?.focus();
  };

  return (
    <>
      <span
        className={styles.intervalGuide}
        aria-hidden
        {...calendarColorProps(color, {
          top: startMinutes * px,
          height: (24 * 60 - startMinutes) * px,
          left,
          width,
        })}
      />
      {runs.map((run) => {
        const time = formatMinutes(Math.round(run.minutes));
        return (
          <button
            key={run.iso}
            type="button"
            className={styles.intervalRun}
            {...calendarColorProps(color, {
              top: run.minutes * px - height / 2,
              height,
              left,
              width,
            })}
            data-interval-run=""
            data-key={span.key}
            data-run={run.iso}
            tabIndex={run.iso === stop ? 0 : -1}
            aria-label={`${label}, ${time}`}
            title={`${hover}\n${time}`}
            onFocus={() => (lastFocused.current = run.iso)}
            onKeyDown={onKeyDown}
            onClick={(e) => {
              // Never the column under it (the slots beside it start a quick add).
              e.stopPropagation();
              onOpen(span, e.currentTarget, e.currentTarget, run.iso);
            }}
          >
            <span className={styles.intervalDot} aria-hidden />
          </button>
        );
      })}
    </>
  );
}

/** Month: one dot per Every automation active that day, side by side by the date. */
export function IntervalDots({
  spans,
  colorOf,
  onOpen,
}: {
  spans: readonly CalendarIntervalSpan[] | undefined;
  colorOf: (calendarId: string) => string;
  onOpen: OpenInterval;
}) {
  if (!spans?.length) return null;
  return (
    <span className={styles.intervalDots} data-interval-dots="">
      {spans.map((span) => (
        <button
          key={span.key}
          type="button"
          className={styles.intervalDotButton}
          {...calendarColorProps(colorOf(span.calendarId))}
          data-interval=""
          data-key={span.key}
          aria-label={intervalAriaLabel(span)}
          title={intervalHover(span)}
          onClick={(e) => {
            // Never the cell under it (that would start a quick add).
            e.stopPropagation();
            onOpen(span, e.currentTarget, e.currentTarget);
          }}
        >
          <span className={styles.intervalDot} aria-hidden />
        </button>
      ))}
    </span>
  );
}
