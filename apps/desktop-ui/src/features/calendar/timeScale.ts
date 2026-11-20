/**
 * Week / Day zoom (docs/architecture.md): pure math
 * for the time scale, in layout px per minute of the day.
 *
 * - The scale runs from "fit" (the whole day fits the visible grid) to
 *   {@link MAX_MINUTE_PX}; the default is 48 px an hour.
 * - A view is the scale plus the minute at the top of the visible grid.
 *   Zooming about a point keeps the minute under it where it was.
 * - Detail follows the scale: the snap step for drags, ruler ticks and
 *   gutter labels appear once there is room for them on screen.
 * - An Every automation draws a dot per run once its runs are far enough
 *   apart, else a thin line.
 * - The overview's window is the visible range; dragging an edge sets the
 *   scale so that range fills the grid.
 */

import { clamp } from '@snaglet/shared/utils';

export const DAY_MIN = 24 * 60;
/** The default scale: 48 px an hour. */
export const DEFAULT_MINUTE_PX = 48 / 60;
/** The furthest in: 12 px a minute. */
export const MAX_MINUTE_PX = 12;
/** Fit, when the grid isn't measured yet (no layout). */
export const FALLBACK_FIT_PX = 0.25;
/** Minutes treated as visible when the grid isn't measured yet. */
export const FALLBACK_SPAN_MIN = 12 * 60;

/** A snap step needs this much room on screen. */
const SNAP_MIN_PX = 10;
/** A ruler tick needs this much room. */
const TICK_MIN_PX = 8;
/** A gutter label needs this much room (more than 30 min at the default, so it stays hourly). */
const LABEL_MIN_PX = 28;
/** An Every automation's runs need this much room to be dots: the dot and a gap. */
const DOT_PX = 7;
const DOT_GAP_PX = 5;
export const DOT_MIN_SPACING_PX = DOT_PX + DOT_GAP_PX;

const SNAP_STEPS = [1, 5] as const;
const TICK_STEPS = [1, 5, 15, 30, 60] as const;
const LABEL_STEPS = [5, 15, 30, 60] as const;
const EPSILON = 1e-6;
const MINUTE_MS = 60_000;

export interface ScaleView {
  /** Layout px per minute. */
  px: number;
  /** The minute at the top of the visible grid. */
  top: number;
}

/** The scale at which the day fills `visiblePx` (the grid's height under its headers). */
export function fitMinutePx(visiblePx: number | null): number {
  if (visiblePx === null || !Number.isFinite(visiblePx) || visiblePx <= 0) return FALLBACK_FIT_PX;
  return Math.min(visiblePx / DAY_MIN, MAX_MINUTE_PX);
}

/** A scale inside fit … max. */
export function clampMinutePx(px: number, fitPx: number): number {
  const min = Math.min(fitPx, MAX_MINUTE_PX);
  if (!Number.isFinite(px)) return min;
  return clamp(px, min, MAX_MINUTE_PX);
}

export function isFit(px: number, fitPx: number): boolean {
  return Math.abs(px - Math.min(fitPx, MAX_MINUTE_PX)) < EPSILON;
}

/** Drags snap to 15 minutes, 5 when zoomed in, 1 when far in. */
export function snapStepFor(px: number): 1 | 5 | 15 {
  for (const step of SNAP_STEPS) if (step * px >= SNAP_MIN_PX - EPSILON) return step;
  return 15;
}

export function snapMinutes(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}

/** The shortest a resize leaves an item: 15 minutes, 5 when snapping finer. */
export function minDurationFor(step: number): number {
  return step < 15 ? 5 : 15;
}

/** Ruler ticks: the finest of 1 / 5 / 15 / 30 / 60 minutes that has room. */
export function tickStepFor(px: number): number {
  for (const step of TICK_STEPS) if (step * px >= TICK_MIN_PX - EPSILON) return step;
  return 60;
}

/** Gutter labels: hourly always; 30 / 15 / 5 minutes as room allows. */
export function labelStepFor(px: number): number {
  for (const step of LABEL_STEPS) if (step * px >= LABEL_MIN_PX - EPSILON) return step;
  return 60;
}

/** Whether an Every automation's runs are far enough apart to draw a dot each. */
export function showsDots(everyMs: number, px: number): boolean {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return false;
  return (everyMs / MINUTE_MS) * px >= DOT_MIN_SPACING_PX - EPSILON;
}

/** Minutes the grid shows at `px`, or null when it isn't measured. */
export function spanMinutes(px: number, visiblePx: number | null): number | null {
  if (visiblePx === null || visiblePx <= 0 || px <= 0) return null;
  return Math.min(visiblePx / px, DAY_MIN);
}

/** The top minute kept inside the day (only bounded below when unmeasured). */
export function clampTop(top: number, px: number, visiblePx: number | null): number {
  const span = spanMinutes(px, visiblePx);
  const max = span === null ? DAY_MIN : Math.max(0, DAY_MIN - span);
  return clamp(Number.isFinite(top) ? top : 0, 0, max);
}

/**
 * Zoom to `nextPx` about a point `anchorPx` below the top of the visible
 * grid (layout px): the minute under it stays under it, unless the day's
 * edges stop it.
 */
export function zoomAbout(
  view: ScaleView,
  nextPx: number,
  anchorPx: number,
  fitPx: number,
  visiblePx: number | null
): ScaleView {
  const px = clampMinutePx(nextPx, fitPx);
  const offset = Math.max(0, anchorPx);
  const minute = view.top + offset / view.px;
  return { px, top: clampTop(minute - offset / px, px, visiblePx) };
}

/** The visible range in minutes (`FALLBACK_SPAN_MIN` long when unmeasured). */
export function windowOf(view: ScaleView, visiblePx: number | null): { from: number; to: number } {
  const span = spanMinutes(view.px, visiblePx) ?? FALLBACK_SPAN_MIN;
  const from = clamp(view.top, 0, DAY_MIN);
  return { from, to: Math.min(from + span, DAY_MIN) };
}

/** Center the visible range on `minute`. */
export function centerOn(minute: number, view: ScaleView, visiblePx: number | null): ScaleView {
  const span = spanMinutes(view.px, visiblePx) ?? FALLBACK_SPAN_MIN;
  return { px: view.px, top: clampTop(minute - span / 2, view.px, visiblePx) };
}

/** Move the visible range by `minutes`. */
export function panBy(view: ScaleView, minutes: number, visiblePx: number | null): ScaleView {
  return { px: view.px, top: clampTop(view.top + minutes, view.px, visiblePx) };
}

/**
 * The overview window's top or bottom edge dragged to `minute`: the other
 * edge stays, and the scale becomes the one that shows the range between
 * them (a full-height window is fit, the smallest is the max scale).
 */
export function resizeWindow(
  edge: 'top' | 'bottom',
  minute: number,
  view: ScaleView,
  fitPx: number,
  visiblePx: number | null
): ScaleView {
  const visible = visiblePx !== null && visiblePx > 0 ? visiblePx : FALLBACK_SPAN_MIN * view.px;
  const { from, to } = windowOf(view, visible);
  const minSpan = visible / MAX_MINUTE_PX;
  const at = clamp(minute, 0, DAY_MIN);
  const span = Math.max(edge === 'bottom' ? at - from : to - at, minSpan);
  const px = clampMinutePx(visible / span, fitPx);
  const shown = visible / px;
  const top = edge === 'bottom' ? from : to - shown;
  return { px, top: clampTop(top, px, visible) };
}

/** Zoom by `factor` about the middle of the visible range. */
export function zoomAboutCenter(
  view: ScaleView,
  factor: number,
  fitPx: number,
  visiblePx: number | null
): ScaleView {
  const visible = visiblePx !== null && visiblePx > 0 ? visiblePx : FALLBACK_SPAN_MIN * view.px;
  return zoomAbout(view, view.px * factor, visible / 2, fitPx, visiblePx);
}

/**
 * An Every automation's run instants (ms) in [fromMs, toMs): its anchor
 * plus whole steps of `everyMs`, none before the anchor. At most `limit`.
 */
export function runTimes(
  anchorMs: number,
  everyMs: number,
  fromMs: number,
  toMs: number,
  limit = 2000
): number[] {
  if (!Number.isFinite(anchorMs) || !Number.isFinite(everyMs) || everyMs <= 0) return [];
  const start = Math.max(fromMs, anchorMs);
  if (!(toMs > start)) return [];
  const out: number[] = [];
  for (
    let k = Math.ceil((start - anchorMs) / everyMs), t = anchorMs + k * everyMs;
    t < toMs && out.length < limit;
    k++, t = anchorMs + k * everyMs
  ) {
    out.push(t);
  }
  return out;
}

/**
 * The minutes worth drawing for the visible range: half a screen either
 * side, rounded out to steps so a small scroll doesn't redraw.
 */
export function renderWindow(window: { from: number; to: number }): { from: number; to: number } {
  const span = Math.max(window.to - window.from, 1);
  const quantum = span <= 60 ? 15 : span <= 240 ? 30 : 60;
  const from = Math.floor((window.from - span / 2) / quantum) * quantum;
  const to = Math.ceil((window.to + span / 2) / quantum) * quantum;
  return { from: clamp(from, 0, DAY_MIN), to: clamp(to, 0, DAY_MIN) };
}

/** The stored zoom: a scale, or "fit". Anything else is the default. */
export function parseStoredZoom(raw: string | null): number | 'fit' {
  if (raw === 'fit') return 'fit';
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_MINUTE_PX) : DEFAULT_MINUTE_PX;
}
