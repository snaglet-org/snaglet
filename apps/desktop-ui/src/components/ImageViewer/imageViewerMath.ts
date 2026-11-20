/**
 * Pure geometry for the pan/zoom image viewer. Every length is in the viewer
 * box's own CSS px (see `toElementPx` in utils/cssZoom); `scale` is image px
 * per box px, so 1 is the image's actual size.
 */

import { clamp } from '@snaglet/shared/utils';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Where the image sits in the box: its scale and its top-left corner. */
export interface ImageView {
  scale: number;
  x: number;
  y: number;
}

/** Largest zoom, as a multiple of the image's actual size. */
export const MAX_SCALE = 8;

/** One button / key press. Pinch and wheel zoom are continuous instead. */
export const ZOOM_STEP = 1.25;

/**
 * The largest wheel delta (px) one event may zoom by. A detented mouse wheel
 * reports ~100px a notch, which would otherwise jump far past a key step; a
 * trackpad pinch reports a few px a frame and is never capped.
 */
const MAX_WHEEL_ZOOM_DELTA = 25;

/** Zoom per wheel px: e^(−rate·deltaY), so one capped notch ≈ one key step. */
const WHEEL_ZOOM_RATE = 0.01;

/** Lines and pages → px, the way browsers scroll by them. */
const LINE_PX = 16;

function isPositive(size: Size | null | undefined): size is Size {
  return !!size && size.width > 0 && size.height > 0;
}

/**
 * The scale that shows the whole image inside the box, inset by `padding` on
 * every side — never above `maxFit` (actual size by default), so a small
 * raster image is not blown up past its pixels. A vector image may raise the
 * cap. The inset shrinks on a cramped box rather than eating it.
 */
export function fitScale(natural: Size, box: Size, padding = 0, maxFit = 1): number {
  if (!isPositive(natural) || !isPositive(box)) return 1;
  const inset = clamp(padding, 0, Math.min(box.width, box.height) / 4);
  return Math.min(
    maxFit,
    (box.width - 2 * inset) / natural.width,
    (box.height - 2 * inset) / natural.height
  );
}

/** Zoom limits: fit at the bottom (nothing smaller is useful), 8× at the top. */
export function clampScale(scale: number, fit: number): number {
  if (!Number.isFinite(scale)) return fit;
  return clamp(scale, fit, Math.max(fit, MAX_SCALE));
}

/** Within rounding of `fit`. */
export function isAtFit(scale: number, fit: number): boolean {
  return Math.abs(scale - fit) <= fit * 1e-3;
}

function clampAxis(offset: number, length: number, extent: number): number {
  // Smaller than the box on this axis: center it. Larger: keep both edges at
  // or past the box edges, so the image always covers the box on that axis
  // and can never be dragged out of view.
  if (length <= extent) return (extent - length) / 2;
  return clamp(offset, extent - length, 0);
}

/** Keep the image in view at its current scale. */
export function clampView(view: ImageView, natural: Size, box: Size): ImageView {
  return {
    scale: view.scale,
    x: clampAxis(view.x, natural.width * view.scale, box.width),
    y: clampAxis(view.y, natural.height * view.scale, box.height),
  };
}

/** The whole image, centered. */
export function fittedView(natural: Size, box: Size, padding = 0, maxFit = 1): ImageView {
  return clampView({ scale: fitScale(natural, box, padding, maxFit), x: 0, y: 0 }, natural, box);
}

/** True when the image overflows the box on either axis — the only time panning moves it. */
export function canPan(view: ImageView, natural: Size, box: Size): boolean {
  return (
    natural.width * view.scale > box.width + 0.5 || natural.height * view.scale > box.height + 0.5
  );
}

/**
 * Zoom to `scale` (clamped to fit…8×) keeping the image point under `anchor`
 * fixed on screen, then clamp the offset.
 */
export function zoomAround(
  view: ImageView,
  scale: number,
  anchor: Point,
  natural: Size,
  box: Size,
  fit: number
): ImageView {
  const next = clampScale(scale, fit);
  const ratio = next / view.scale;
  return clampView(
    {
      scale: next,
      x: anchor.x - (anchor.x - view.x) * ratio,
      y: anchor.y - (anchor.y - view.y) * ratio,
    },
    natural,
    box
  );
}

/** Move the image by (dx, dy) box px, clamped. */
export function panView(
  view: ImageView,
  dx: number,
  dy: number,
  natural: Size,
  box: Size
): ImageView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, natural, box);
}

/**
 * One zoom step in or out. A step that would cross actual size (100%) stops
 * on it, so stepping always offers 1:1 on the way past.
 */
export function stepScale(scale: number, direction: 1 | -1, fit: number): number {
  const next = direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
  const crossesActual = direction > 0 ? scale < 1 - 1e-6 && next > 1 : scale > 1 + 1e-6 && next < 1;
  return clampScale(crossesActual ? 1 : next, fit);
}

/** Where a double-click at fit zooms to: 2× fit, or actual size if that is larger. */
export function detailScale(fit: number): number {
  return clampScale(Math.max(2 * fit, 1), fit);
}

/** A wheel delta in px, from whichever unit the event reports. */
export function wheelDeltaPx(delta: number, deltaMode: number, pageExtent: number): number {
  if (deltaMode === 1) return delta * LINE_PX;
  if (deltaMode === 2) return delta * pageExtent;
  return delta;
}

/** The zoom factor for one Ctrl/⌘-wheel or trackpad-pinch event (`deltaY` in px). */
export function wheelZoomFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-clamp(deltaY, -MAX_WHEEL_ZOOM_DELTA, MAX_WHEEL_ZOOM_DELTA) * WHEEL_ZOOM_RATE);
}

/**
 * Keep the image point at the box's center there across a box resize, at the
 * same scale, clamped to the new box.
 */
export function recenterView(
  view: ImageView,
  natural: Size,
  previousBox: Size,
  box: Size
): ImageView {
  const centerX = (previousBox.width / 2 - view.x) / view.scale;
  const centerY = (previousBox.height / 2 - view.y) / view.scale;
  return clampView(
    {
      scale: view.scale,
      x: box.width / 2 - centerX * view.scale,
      y: box.height / 2 - centerY * view.scale,
    },
    natural,
    box
  );
}
