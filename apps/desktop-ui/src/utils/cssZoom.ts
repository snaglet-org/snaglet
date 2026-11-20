import { ZOOM_CHANGED_EVENT } from '@desktop/components/StatusBar/consumers/zoomWindow';

/**
 * The effective CSS `zoom` an element renders under. Snaglet zooms the document
 * root (⌘+/⌘−, see zoomWindow.ts) and each pane body and the sidebar (see
 * useFluidZoom). Under `zoom`, rects, pointer coordinates and `innerWidth`
 * are in viewport px (post-zoom), while `offsetWidth`, `scrollTop` and any
 * `style.left` / `height` you write are in the element's own px (pre-zoom).
 * Divide viewport px by this factor to get the element's own px.
 */
export function getEffectiveZoom(el: Element | null | undefined): number {
  if (!el) return 1;
  // Chrome 128+ / WebKit expose the product directly.
  const native = (el as Element & { currentCSSZoom?: unknown }).currentCSSZoom;
  if (typeof native === 'number' && Number.isFinite(native) && native > 0) return native;
  if (typeof getComputedStyle !== 'function') return 1;
  let zoom = 1;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const own = Number.parseFloat(getComputedStyle(node).zoom);
    if (Number.isFinite(own) && own > 0) zoom *= own;
  }
  return zoom;
}

/**
 * How many rect px (`getBoundingClientRect`, pointer `clientX`) one of `el`'s
 * own CSS px covers. Like {@link fixedLayerScale} it is measured (the
 * element's rect width over its `offsetWidth`), never inferred, so the same
 * call is right inside a pane (root × pane zoom), in a portaled overlay (root
 * zoom only), and on an engine whose rects already come in zoomed px (1).
 * Identity where layout reports nothing (jsdom).
 */
export function elementPxScale(el: HTMLElement): number {
  const width = el.getBoundingClientRect().width;
  const own = el.offsetWidth;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(own) || own <= 0) return 1;
  return ratio(width, own);
}

/**
 * A pointer position (rect px) → `el`'s own CSS px, relative to its top-left
 * corner: the space its `clientWidth`, children's `style.left` / `width` and
 * `transform` lengths are in.
 */
export function toElementPx(
  el: HTMLElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  const scale = elementPxScale(el);
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}

/**
 * The fixed layer (popovers, menus, tooltips portaled to `<body>` with
 * `position: fixed`) sits inside the root zoom but outside every pane's.
 * Standardized CSS zoom (Chrome 128+) multiplies its `style.left` / `width`
 * by the root zoom; pre-standard WebKit may report rects already zoomed. So
 * the factor is measured, never inferred: hidden probes report how many rect
 * px one fixed-layer CSS px covers, and the viewport in those rect px. Cached
 * and re-taken after `snaglet:zoom-changed`; identity where layout reports nothing.
 *
 * For a fixed surface, do placement math in rect px (CSS sizes multiplied by
 * `fixedLayerScale()`), then convert once at the end with `toFixedLayer`.
 */
interface FixedLayerMetrics {
  /** The root's inline `zoom` the metrics were measured under. */
  key: string;
  scale: number;
  /** Viewport extent in rect px, as a share of `innerWidth` / `innerHeight`. */
  widthRatio: number;
  heightRatio: number;
}

/** The probe's CSS offset; large enough that rounding never shows. */
const PROBE_PX = 100;

let metrics: FixedLayerMetrics | null = null;
let listening = false;

function rootZoomKey(): string {
  return document.documentElement.style.getPropertyValue('zoom');
}

function probe(name: 'unit' | 'viewport', css: string): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('data-fixed-layer-probe', name);
  el.style.cssText = `position:fixed;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none;${css}`;
  return el;
}

function ratio(measured: number, nominal: number): number {
  if (!Number.isFinite(measured) || measured <= 0 || nominal <= 0) return 1;
  // Within a pixel is layout rounding, not a different coordinate space.
  return Math.abs(measured - nominal) <= 1 ? 1 : measured / nominal;
}

function measureFixedLayer(key: string): FixedLayerMetrics {
  const size = `${PROBE_PX}px`;
  const unit = probe('unit', `left:${size};top:${size};width:${size};height:${size}`);
  const frame = probe('viewport', 'left:0;top:0;right:0;bottom:0');
  document.body.append(unit, frame);
  try {
    const offset = unit.getBoundingClientRect().left / PROBE_PX;
    const viewport = frame.getBoundingClientRect();
    return {
      key,
      scale: Number.isFinite(offset) && offset > 0 ? offset : 1,
      widthRatio: ratio(viewport.width, window.innerWidth),
      heightRatio: ratio(viewport.height, window.innerHeight),
    };
  } finally {
    unit.remove();
    frame.remove();
  }
}

function fixedLayerMetrics(): FixedLayerMetrics | null {
  if (typeof document === 'undefined' || !document.body) return null;
  if (!listening) {
    listening = true;
    window.addEventListener(ZOOM_CHANGED_EVENT, () => {
      metrics = null;
    });
  }
  const key = rootZoomKey();
  if (!metrics || metrics.key !== key) metrics = measureFixedLayer(key);
  return metrics;
}

/**
 * How many rect px (`getBoundingClientRect`, `clientX`) one CSS px of a
 * `position: fixed` child of `<body>` covers: the root zoom under
 * standardized CSS zoom, 1 where the engine already reports rects in the
 * element's own zoomed px. Divide rect px by it to get the CSS px to write.
 */
export function fixedLayerScale(): number {
  return fixedLayerMetrics()?.scale ?? 1;
}

/** The viewport's size in rect px — the edges a fixed surface clamps to. */
export function fixedLayerViewport(): { width: number; height: number } {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth;
  const height = typeof window === 'undefined' ? 0 : window.innerHeight;
  const measured = fixedLayerMetrics();
  if (!measured) return { width, height };
  return { width: width * measured.widthRatio, height: height * measured.heightRatio };
}

/**
 * Rect-px geometry → the CSS px a fixed child of `<body>` must be given.
 * Every numeric entry (left, top, right, bottom, width, maxHeight…) is
 * divided by `fixedLayerScale()`; `undefined` entries pass through.
 */
export function toFixedLayer<T extends Record<string, number | undefined>>(box: T): T {
  const scale = fixedLayerScale();
  if (scale === 1) return { ...box };
  const out: Record<string, number | undefined> = {};
  for (const [key, value] of Object.entries(box)) {
    out[key] = value === undefined ? undefined : value / scale;
  }
  return out as T;
}
