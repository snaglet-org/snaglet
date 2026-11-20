/**
 * The Week / Day zoom, owned by the calendar pane (docs/architecture.md). It keeps the scale (px per minute, or "fit"), applies
 * zooms about a point (Ctrl/⌘+wheel, trackpad pinch, the overview's edges,
 * + / −) and publishes the visible range to the overview and the dots.
 *
 * The scroller's `scrollTop` is the one source of the position; the
 * overview only ever writes it. A zoom sets the scale, and once the grid
 * has re-rendered at it, the scroll that keeps the anchored minute in place.
 * The scale (or "fit") persists per viewer in localStorage.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { toElementPx } from '@desktop/utils/cssZoom';
import { wheelDeltaPx, wheelZoomFactor } from '@desktop/components/ImageViewer/imageViewerMath';
import {
  clampMinutePx,
  clampTop,
  DAY_MIN,
  FALLBACK_SPAN_MIN,
  fitMinutePx,
  isFit,
  labelStepFor,
  parseStoredZoom,
  snapStepFor,
  spanMinutes,
  tickStepFor,
  zoomAbout,
  type ScaleView,
} from '@desktop/features/calendar/timeScale';
import { createViewportStore, type TimeScale } from './timeScaleContext';

const TIME_ZOOM_KEY = 'snaglet.calendar.timeZoom';
const PERSIST_DELAY_MS = 300;

/** WebKit's trackpad pinch (Safari / WKWebView); Chromium sends Ctrl+wheel instead. */
interface WebKitGestureEvent extends Event {
  scale: number;
  clientY?: number;
}

interface Metrics {
  bodyTop: number;
  visiblePx: number | null;
}

function readStoredZoom(): number | 'fit' {
  try {
    return parseStoredZoom(window.localStorage.getItem(TIME_ZOOM_KEY));
  } catch {
    return parseStoredZoom(null);
  }
}

function writeStoredZoom(value: number | 'fit'): void {
  try {
    window.localStorage.setItem(
      TIME_ZOOM_KEY,
      value === 'fit' ? 'fit' : String(Math.round(value * 10_000) / 10_000)
    );
  } catch {
    // ignore storage failures
  }
}

export function useTimeScale(scrollRef: RefObject<HTMLElement | null>, active: boolean): TimeScale {
  const [stored, setStored] = useState<number | 'fit'>(readStoredZoom);
  // Bumped by every zoom, so its scroll is applied even when the scale
  // comes back to the one already drawn.
  const [zoomCount, setZoomCount] = useState(0);
  const [metrics, setMetrics] = useState<Metrics>({ bodyTop: 0, visiblePx: null });
  const fitPx = fitMinutePx(metrics.visiblePx);
  const px = stored === 'fit' ? fitPx : clampMinutePx(stored, fitPx);
  const fitted = stored === 'fit' || isFit(px, fitPx);

  const bodyRef = useRef<HTMLElement | null>(null);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const fitRef = useRef(fitPx);
  fitRef.current = fitPx;
  /** The scale the DOM is drawn at (updated once a render at it commits). */
  const drawnPxRef = useRef(px);
  /** The top minute as last scrolled; kept across a resize that moves the scale. */
  const topRef = useRef(0);
  /** A zoom on its way: the view to scroll to once the grid draws at its scale. */
  const pendingRef = useRef<ScaleView | null>(null);
  const changedRef = useRef(false);
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const resizeRef = useRef<ResizeObserver | null>(null);
  const [viewport] = useState(createViewportStore);

  const publish = useCallback(() => {
    const { visiblePx } = metricsRef.current;
    viewport.set({
      top: topRef.current,
      span: spanMinutes(drawnPxRef.current, visiblePx) ?? FALLBACK_SPAN_MIN,
      known: visiblePx !== null,
    });
  }, [viewport]);

  /** Read the header height and the visible times' height off the DOM. */
  const measure = useCallback((): Metrics => {
    const scroller = scrollRef.current;
    const body = bodyRef.current;
    const bodyTop = body?.offsetTop ?? 0;
    const height = scroller?.clientHeight ?? 0;
    const visiblePx = height - bodyTop > 0 ? height - bodyTop : null;
    const prev = metricsRef.current;
    if (prev.bodyTop === bodyTop && prev.visiblePx === visiblePx) return prev;
    const next = { bodyTop, visiblePx };
    metricsRef.current = next;
    fitRef.current = fitMinutePx(visiblePx);
    setMetrics(next);
    return next;
  }, [scrollRef]);

  const view = useCallback((): ScaleView => {
    if (pendingRef.current) return pendingRef.current;
    const scroller = scrollRef.current;
    const scale = drawnPxRef.current;
    return { px: scale, top: scroller ? scroller.scrollTop / scale : topRef.current };
  }, [scrollRef]);

  const topMinute = useCallback(() => view().top, [view]);

  const scrollToMinute = useCallback(
    (minute: number) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const pending = pendingRef.current;
      const scale = pending?.px ?? drawnPxRef.current;
      const top = clampTop(minute, scale, metricsRef.current.visiblePx);
      if (pending) {
        pendingRef.current = { px: scale, top };
        return;
      }
      topRef.current = top;
      scroller.scrollTop = top * scale;
      publish();
    },
    [scrollRef, publish]
  );

  const apply = useCallback(
    (next: ScaleView) => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const fit = fitRef.current;
      const scale = clampMinutePx(next.px, fit);
      const target = { px: scale, top: clampTop(next.top, scale, metricsRef.current.visiblePx) };
      if (!pendingRef.current && Math.abs(scale - drawnPxRef.current) < 1e-9) {
        topRef.current = target.top;
        scroller.scrollTop = target.top * scale;
        publish();
        return;
      }
      pendingRef.current = target;
      changedRef.current = true;
      setStored(isFit(scale, fit) ? 'fit' : scale);
      setZoomCount((n) => n + 1);
    },
    [scrollRef, publish]
  );

  const zoomBy = useCallback(
    (factor: number, clientY: number | null) => {
      const scroller = scrollRef.current;
      if (!scroller || !Number.isFinite(factor) || factor <= 0) return;
      const { bodyTop, visiblePx } = measure();
      const current = view();
      const anchor =
        clientY === null
          ? (visiblePx ?? FALLBACK_SPAN_MIN * current.px) / 2
          : toElementPx(scroller, 0, clientY).y - bodyTop;
      apply(zoomAbout(current, current.px * factor, anchor, fitRef.current, visiblePx));
    },
    [scrollRef, measure, view, apply]
  );

  const registerGrid = useCallback(
    (body: HTMLElement | null) => {
      const ro = resizeRef.current;
      const before = bodyRef.current?.parentElement;
      if (ro && before) ro.unobserve(before);
      bodyRef.current = body;
      if (!body) return;
      if (ro && body.parentElement) ro.observe(body.parentElement);
      measure();
    },
    [measure]
  );

  // Once the grid is drawn at a new scale: scroll to the zoom's view, or keep
  // the top minute (a resize moved fit, or the scale was clamped).
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const before = drawnPxRef.current;
    drawnPxRef.current = px;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (scroller && active && (pending || before !== px)) {
      const top = clampTop(pending ? pending.top : topRef.current, px, metrics.visiblePx);
      topRef.current = top;
      scroller.scrollTop = top * px;
    }
    publish();
  }, [px, zoomCount, active, metrics.visiblePx, scrollRef, publish]);

  // Follow the scroller; re-measure when it or the grid (its headers) resize.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !active) return;
    const onScroll = () => {
      if (pendingRef.current) return;
      topRef.current = Math.min(scroller.scrollTop / drawnPxRef.current, DAY_MIN);
      publish();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => measure());
      resizeRef.current = ro;
      ro.observe(scroller);
      const grid = bodyRef.current?.parentElement;
      if (grid) ro.observe(grid);
    }
    measure();
    onScroll();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      resizeRef.current?.disconnect();
      resizeRef.current = null;
    };
  }, [scrollRef, active, measure, publish]);

  // Ctrl/⌘+wheel and trackpad pinch zoom about the pointer; a plain wheel
  // scrolls. Non-passive so the page itself never zooms.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !active) return;
    let pinch: { px: number; clientY: number | null } | null = null;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (pinch) return;
      const deltaY = wheelDeltaPx(event.deltaY, event.deltaMode, scroller.clientHeight || 600);
      zoomBy(wheelZoomFactor(deltaY), event.clientY);
    };
    const onGestureStart = (raw: Event) => {
      const event = raw as WebKitGestureEvent;
      event.preventDefault();
      pinch = {
        px: view().px,
        clientY: typeof event.clientY === 'number' ? event.clientY : null,
      };
    };
    const onGestureChange = (raw: Event) => {
      const event = raw as WebKitGestureEvent;
      event.preventDefault();
      if (!pinch || !Number.isFinite(event.scale) || event.scale <= 0) return;
      zoomBy((pinch.px * event.scale) / view().px, pinch.clientY);
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      pinch = null;
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('gesturestart', onGestureStart, { passive: false });
    scroller.addEventListener('gesturechange', onGestureChange, { passive: false });
    scroller.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('gesturestart', onGestureStart);
      scroller.removeEventListener('gesturechange', onGestureChange);
      scroller.removeEventListener('gestureend', onGestureEnd);
    };
  }, [scrollRef, active, zoomBy, view]);

  // Remember the zoom once it settles (and on the way out).
  useEffect(() => {
    if (!changedRef.current) return;
    const id = window.setTimeout(() => writeStoredZoom(stored), PERSIST_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [stored]);
  useEffect(
    () => () => {
      if (changedRef.current) writeStoredZoom(storedRef.current);
    },
    []
  );

  return useMemo(
    () => ({
      px,
      fitPx,
      fitted,
      snapStep: snapStepFor(px),
      tickStep: tickStepFor(px),
      labelStep: labelStepFor(px),
      bodyTop: metrics.bodyTop,
      visiblePx: metrics.visiblePx,
      viewport,
      view,
      apply,
      scrollToMinute,
      topMinute,
      zoomBy,
      registerGrid,
    }),
    [
      px,
      fitPx,
      fitted,
      metrics,
      viewport,
      view,
      apply,
      scrollToMinute,
      topMinute,
      zoomBy,
      registerGrid,
    ]
  );
}
