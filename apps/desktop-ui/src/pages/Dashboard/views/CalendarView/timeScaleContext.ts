/**
 * The Week / Day time scale as the grid, its Every dots and the overview
 * read it (docs/architecture.md). The pane owns it
 * (`useTimeScale`); without a provider everything draws at the default.
 *
 * The visible range lives in a small store, not React state, so a scroll
 * only redraws what follows it (the overview's window, the dots near the
 * view), never the whole grid.
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import {
  DEFAULT_MINUTE_PX,
  FALLBACK_SPAN_MIN,
  labelStepFor,
  renderWindow,
  snapStepFor,
  tickStepFor,
  type ScaleView,
} from '@desktop/features/calendar/timeScale';

/** The visible range, in minutes of the day. `known` is false before the grid is measured. */
export interface ViewportSnapshot {
  top: number;
  span: number;
  known: boolean;
}

export interface ViewportStore {
  get: () => ViewportSnapshot;
  subscribe: (listener: () => void) => () => void;
  set: (next: ViewportSnapshot) => void;
}

export function createViewportStore(
  initial: ViewportSnapshot = { top: 0, span: FALLBACK_SPAN_MIN, known: false }
): ViewportStore {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      if (
        next.known === snapshot.known &&
        Math.abs(next.top - snapshot.top) < 0.01 &&
        Math.abs(next.span - snapshot.span) < 0.01
      )
        return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

export interface TimeScale {
  /** Layout px per minute. */
  px: number;
  /** The scale that fits the whole day. */
  fitPx: number;
  /** At fit (and staying there as the pane resizes). */
  fitted: boolean;
  /** Minutes drags snap to. */
  snapStep: number;
  /** Minutes between ruler ticks. */
  tickStep: number;
  /** Minutes between gutter labels (60 = hours only). */
  labelStep: number;
  /** Height of the day headers and all-day band above the times (layout px). */
  bodyTop: number;
  /** Height of the visible times (layout px); null before it is measured. */
  visiblePx: number | null;
  viewport: ViewportStore;
  /** The view now, a zoom on its way included. */
  view: () => ScaleView;
  /** Go to `next` (scale and scroll). */
  apply: (next: ScaleView) => void;
  /** Scroll so `minute` is at the top of the visible times. */
  scrollToMinute: (minute: number) => void;
  /** The minute at the top of the visible times now. */
  topMinute: () => number;
  /** Zoom by `factor` about a pointer's `clientY` (null = the middle of the view). */
  zoomBy: (factor: number, clientY: number | null) => void;
  /** The grid tells the scale where its times start, so it can measure. */
  registerGrid: (body: HTMLElement | null) => void;
}

const fallbackStore = createViewportStore();

function noop(): void {}

const DEFAULT_TIME_SCALE: TimeScale = {
  px: DEFAULT_MINUTE_PX,
  fitPx: DEFAULT_MINUTE_PX,
  fitted: false,
  snapStep: snapStepFor(DEFAULT_MINUTE_PX),
  tickStep: tickStepFor(DEFAULT_MINUTE_PX),
  labelStep: labelStepFor(DEFAULT_MINUTE_PX),
  bodyTop: 0,
  visiblePx: null,
  viewport: fallbackStore,
  view: () => ({ px: DEFAULT_MINUTE_PX, top: 0 }),
  apply: noop,
  scrollToMinute: noop,
  topMinute: () => 0,
  zoomBy: noop,
  registerGrid: noop,
};

export const TimeScaleContext = createContext<TimeScale>(DEFAULT_TIME_SCALE);

export function useTimeScaleContext(): TimeScale {
  return useContext(TimeScaleContext);
}

/** The visible range; re-renders on every scroll (keep it in small components). */
export function useViewport(store: ViewportStore): ViewportSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * The minutes worth drawing around the visible range (half a screen either
 * side, in steps): re-renders only when that range moves a step.
 */
export function useRenderWindow(store: ViewportStore): { from: number; to: number } {
  const key = useSyncExternalStore(
    store.subscribe,
    () => windowKey(store.get()),
    () => windowKey(store.get())
  );
  return useMemo(() => {
    const [from, to] = key.split(':').map(Number) as [number, number];
    return { from, to };
  }, [key]);
}

function windowKey(snapshot: ViewportSnapshot): string {
  const w = renderWindow({ from: snapshot.top, to: snapshot.top + snapshot.span });
  return `${w.from}:${w.to}`;
}
