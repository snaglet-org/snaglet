/**
 * The Week / Day overview: a narrow panel at the pane's right that shows each
 * visible day whole, midnight to midnight, with a window over the times the
 * grid shows. Drag the window to pan, drag an edge to zoom; it is also a
 * focusable scrollbar for the grid.
 *
 * It only ever writes the grid's scroll and scale (`TimeScale`); its window
 * follows them from the viewport store, so the two can't feed back.
 */
import { memo, useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { CalendarIntervalSpan, CalendarOccurrence } from '@snaglet/shared/types';
import { cn } from '@desktop/utils/classNames';
import { calendarColorProps } from '@desktop/features/calendar/calendarColors';
import { formatMinutes, weekdayShort } from '@desktop/features/calendar/calendarDates';
import {
  intervalStart,
  intervalsByDay,
  placeOccurrences,
} from '@desktop/features/calendar/calendarLayout';
import {
  centerOn,
  DAY_MIN,
  FALLBACK_SPAN_MIN,
  panBy,
  resizeWindow,
  zoomAboutCenter,
  type ScaleView,
} from '@desktop/features/calendar/timeScale';
import { wheelDeltaPx, wheelZoomFactor } from '@desktop/components/ImageViewer/imageViewerMath';
import { useNowMinutes } from './TimeGrid';
import { useTimeScaleContext, useViewport, type TimeScale } from './timeScaleContext';
import styles from './CalendarView.module.scss';

/** Shift + ↑ / ↓ zoom by this much. */
const KEY_ZOOM = 1.25;

export interface TimeOverviewProps {
  /** The strip's id, for the toolbar's Overview button (`aria-controls`). */
  id?: string;
  days: string[];
  zone: string;
  occurrences: CalendarOccurrence[];
  intervals: CalendarIntervalSpan[];
  colorOf: (calendarId: string) => string;
  /** The id of the grid's scroller (the window is its scrollbar). */
  controls: string;
}

const pct = (minutes: number) => `${(minutes / DAY_MIN) * 100}%`;

function clampMinute(minute: number): number {
  return Math.min(Math.max(minute, 0), DAY_MIN);
}

/** The days' contents: memoized, so a scroll redraws only the window. */
const OverviewDays = memo(function OverviewDays({
  days,
  zone,
  occurrences,
  intervals,
  colorOf,
}: Omit<TimeOverviewProps, 'controls' | 'id'>) {
  const placed = useMemo(
    () => placeOccurrences(occurrences, days, zone),
    [occurrences, days, zone]
  );
  const lines = useMemo(() => intervalsByDay(intervals), [intervals]);
  const now = useNowMinutes(zone);
  return (
    <>
      {days.map((day) => (
        <div key={day} className={styles.overviewDay} data-overview-day={day}>
          {placed.timed
            .filter((s) => s.day === day)
            .map((s) => (
              <span
                key={s.key}
                className={styles.overviewBlock}
                data-overview-block=""
                {...calendarColorProps(colorOf(s.occurrence.calendarId), {
                  top: pct(s.start),
                  height: pct(s.end - s.start),
                })}
              />
            ))}
          {(lines.get(day) ?? []).map((span, i) => (
            <span
              key={span.key}
              className={styles.overviewLine}
              data-overview-line=""
              {...calendarColorProps(colorOf(span.calendarId), {
                top: pct(intervalStart(span, zone).minutes),
                left: i * 2,
              })}
            />
          ))}
          {day === now.date && (
            <span className={styles.overviewNow} style={{ top: pct(now.minutes) }} />
          )}
        </div>
      ))}
    </>
  );
});

/** The window over the visible times; re-renders on every scroll. */
function OverviewWindow({ scale, controls }: { scale: TimeScale; controls: string }) {
  const viewport = useViewport(scale.viewport);
  const from = clampMinute(viewport.top);
  const to = clampMinute(viewport.top + viewport.span);
  const room = DAY_MIN - (to - from);
  const label = `${formatMinutes(Math.round(from))} – ${formatMinutes(Math.round(to))}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const view = scale.view();
    const visible = scale.visiblePx;
    const span = to - from || FALLBACK_SPAN_MIN;
    let next: ScaleView | null = null;
    const step = Math.min(Math.max(span / 4, 5), 60);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const up = e.key === 'ArrowUp';
      next = e.shiftKey
        ? zoomAboutCenter(view, up ? KEY_ZOOM : 1 / KEY_ZOOM, scale.fitPx, visible)
        : panBy(view, up ? -step : step, visible);
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      next = panBy(view, e.key === 'PageUp' ? -span : span, visible);
    } else if (e.key === 'Home' || e.key === 'End') {
      next = { px: view.px, top: e.key === 'Home' ? 0 : DAY_MIN };
    }
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    scale.apply(next);
  };

  return (
    <div
      role="scrollbar"
      tabIndex={0}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-label="Visible hours"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={room > 0 ? Math.round((from / room) * 100) : 0}
      aria-valuetext={label}
      title={label}
      className={cn(styles.overviewWindow, scale.fitted && styles.overviewWindowFit)}
      data-overview-window=""
      style={{ top: pct(from), height: pct(to - from) }}
      onKeyDown={onKeyDown}
    >
      <span
        className={cn(styles.overviewEdge, styles.overviewEdgeTop)}
        data-overview-edge="top"
        aria-hidden
      />
      <span
        className={cn(styles.overviewEdge, styles.overviewEdgeBottom)}
        data-overview-edge="bottom"
        aria-hidden
      />
    </div>
  );
}

export function TimeOverview({
  id,
  days,
  zone,
  occurrences,
  intervals,
  colorOf,
  controls,
}: TimeOverviewProps) {
  const scale = useTimeScaleContext();
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const asideRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  // A wheel over the overview scrolls the grid; Ctrl/⌘ + wheel zooms it.
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const s = scaleRef.current;
      const view = s.view();
      const extent = s.visiblePx ?? FALLBACK_SPAN_MIN * view.px;
      const deltaY = wheelDeltaPx(event.deltaY, event.deltaMode, extent);
      if (event.ctrlKey || event.metaKey) {
        s.apply(zoomAboutCenter(view, wheelZoomFactor(deltaY), s.fitPx, s.visiblePx));
      } else {
        s.apply(panBy(view, deltaY / view.px, s.visiblePx));
      }
    };
    aside.addEventListener('wheel', onWheel, { passive: false });
    return () => aside.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (e.button !== 0 || !track) return;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return;
    e.preventDefault();
    const s = scaleRef.current;
    const minuteAt = (clientY: number) =>
      clampMinute(((clientY - rect.top) / rect.height) * DAY_MIN);
    const target = e.target as HTMLElement;
    const edgeAttr = target.closest('[data-overview-edge]')?.getAttribute('data-overview-edge');
    const edge = edgeAttr === 'top' || edgeAttr === 'bottom' ? edgeAttr : null;
    const windowEl = track.querySelector<HTMLElement>('[data-overview-window]');
    windowEl?.focus({ preventScroll: true });
    if (!edge && !target.closest('[data-overview-window]')) {
      s.apply(centerOn(minuteAt(e.clientY), s.view(), s.visiblePx));
    }
    const start = s.view();
    const startY = e.clientY;
    let frame: number | null = null;
    let lastY = startY;

    const resizeNow = () => {
      frame = null;
      if (!edge) return;
      const now = scaleRef.current;
      now.apply(resizeWindow(edge, minuteAt(lastY), start, now.fitPx, now.visiblePx));
    };
    const onMove = (ev: globalThis.PointerEvent) => {
      lastY = ev.clientY;
      if (edge) {
        if (frame === null) frame = window.requestAnimationFrame(resizeNow);
        return;
      }
      scaleRef.current.scrollToMinute(start.top + ((ev.clientY - startY) / rect.height) * DAY_MIN);
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', finish);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      endDrag.current = null;
    };
    const onUp = (ev: globalThis.PointerEvent) => {
      lastY = ev.clientY;
      if (edge && lastY !== startY) resizeNow();
      finish();
    };
    endDrag.current?.();
    endDrag.current = finish;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <aside
      ref={asideRef}
      id={id}
      className={styles.overview}
      aria-label="Day overview"
      data-time-overview=""
    >
      <div className={styles.overviewHead} style={{ height: scale.bodyTop }} aria-hidden>
        {days.length > 1 && (
          <div className={styles.overviewDayNames}>
            {days.map((day) => (
              <span key={day}>{weekdayShort(day).slice(0, 1)}</span>
            ))}
          </div>
        )}
      </div>
      <div
        ref={trackRef}
        className={styles.overviewTrack}
        data-overview-track=""
        onPointerDown={onPointerDown}
      >
        <OverviewDays
          days={days}
          zone={zone}
          occurrences={occurrences}
          intervals={intervals}
          colorOf={colorOf}
        />
        <OverviewWindow scale={scale} controls={controls} />
      </div>
    </aside>
  );
}
