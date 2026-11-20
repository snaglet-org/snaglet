/**
 * UI zoom for the Tauri shell, whose webview has no native ⌘+/⌘−/⌘0. Applied
 * as CSS `zoom` on the document root, shared by the ZoomSlot buttons and the
 * `useZoomHotkeys` bindings. Desktop only: those mount points do nothing in a
 * browser, where native zoom would double up.
 *
 * The level lives in localStorage so it survives reloads, and changes are
 * announced with a window CustomEvent that `subscribeToZoom` adapts for
 * `useSyncExternalStore`.
 */

/** Browser-like zoom ladder. Stepping walks this list; the ends clamp. */
const ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** localStorage key — `snaglet.` namespaced like the app's other persisted UI state. */
export const ZOOM_STORAGE_KEY = 'snaglet.ui.zoom';

/** Window CustomEvent fired after every zoom change (same pattern as `snaglet:active-user-changed`). */
export const ZOOM_CHANGED_EVENT = 'snaglet:zoom-changed';

/** Float-comparison slack for walking the step ladder. */
const EPSILON = 1e-9;

/** Root custom property: how much the engine zooms `vw` / `vh` (see applyZoom). */
const VIEWPORT_ZOOM_VAR = '--snaglet-viewport-zoom';

/**
 * Relative slack when matching a measured ratio to a known behavior: covers
 * layout rounding and a classic scrollbar, and stays well below the 10% gap
 * between 1 and its nearest ladder levels.
 */
const VIEWPORT_ZOOM_SLACK = 0.02;

/**
 * True inside the packaged Tauri shell. The shell injects
 * `window.__SNAGLET_DESKTOP__` via an initialization script before any app code
 * runs (see config.ts), so presence of the object is a reliable synchronous
 * signal. Read at call time (not module load) so tests can toggle it.
 */
export function isDesktopShell(): boolean {
  return (globalThis as { __SNAGLET_DESKTOP__?: unknown }).__SNAGLET_DESKTOP__ != null;
}

function clamp(level: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
}

/**
 * The persisted zoom level, clamped; 1 when unset, unreadable, or invalid.
 * localStorage is the source of truth (not module state) so tests and
 * multiple entry points never disagree.
 */
export function getZoom(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = window.localStorage.getItem(ZOOM_STORAGE_KEY);
    if (raw === null) return 1;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return clamp(parsed);
  } catch {
    return 1;
  }
}

/**
 * Set, apply, persist, and announce a zoom level (clamped to the ladder's
 * ends). At exactly 1 the inline `zoom` property and its custom properties
 * are cleared instead of set, leaving the root untouched at the default level.
 */
export function setZoom(level: number): void {
  const next = clamp(level);
  applyZoom(next);
  try {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
  } catch {
    // Storage unavailable (private mode etc.) — zoom still applies, it just
    // won't survive a reload.
  }
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT, { detail: { zoom: next } }));
}

/**
 * Apply the level as CSS `zoom`, which reflows the layout (unlike `transform:
 * scale` or WKWebView's native zoom, which magnifies). The app shell fills the
 * window with `inset: 0`, which no zoom affects. Two custom properties serve
 * the styles/abstracts/_zoom.scss helpers: `--snaglet-zoom` is the level (every
 * engine zooms px lengths by it) and `--snaglet-viewport-zoom` is how much this
 * engine zooms `vw` / `vh`.
 */
function applyZoom(next: number): void {
  const rootStyle = document.documentElement.style;
  if (next === 1) {
    rootStyle.removeProperty('zoom');
    rootStyle.removeProperty('--snaglet-zoom');
    rootStyle.removeProperty(VIEWPORT_ZOOM_VAR);
    return;
  }
  rootStyle.setProperty('zoom', String(next));
  rootStyle.setProperty('--snaglet-zoom', String(next));
  rootStyle.setProperty(VIEWPORT_ZOOM_VAR, String(measureViewportZoom(next)));
}

/**
 * How much the engine zooms `vw` / `vh` under the root zoom. Standardized CSS
 * zoom (Chromium, current WebKit) multiplies them by the level; older WebKit
 * (Safari 17) leaves them at the window's size, so dividing them by the level
 * there shrinks or overflows whatever uses them. Measured, never assumed: a
 * hidden `100vw` box is compared with an `inset: 0` one, which fills the
 * window in every engine, through the same API so the engine's rect units
 * cancel out. Falls back to the level where layout reports nothing.
 */
function measureViewportZoom(level: number): number {
  const body = document.body;
  if (!body) return level;
  const units = viewportProbe('left:0;top:0;width:100vw;height:100vh');
  const frame = viewportProbe('inset:0');
  body.append(units, frame);
  try {
    return viewportZoomFrom(
      units.getBoundingClientRect().width,
      frame.getBoundingClientRect().width,
      level
    );
  } finally {
    units.remove();
    frame.remove();
  }
}

function viewportProbe(css: string): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('data-viewport-zoom-probe', '');
  el.style.cssText = `position:fixed;margin:0;padding:0;border:0;visibility:hidden;pointer-events:none;${css}`;
  return el;
}

/**
 * The measured ratio, snapped to the level or to 1 when within
 * {@link VIEWPORT_ZOOM_SLACK} of either; an engine that does something else
 * gets its own ratio.
 */
function viewportZoomFrom(unitsWidth: number, frameWidth: number, level: number): number {
  const measurable = (n: number) => Number.isFinite(n) && n > 0;
  if (!measurable(unitsWidth) || !measurable(frameWidth)) return level;
  const ratio = unitsWidth / frameWidth;
  const known = [level, 1].find((k) => Math.abs(ratio - k) <= VIEWPORT_ZOOM_SLACK * k);
  return known ?? Math.round(ratio * 1000) / 1000;
}

/** Step to the next ladder entry above the current level (no-op at max). */
export function zoomIn(): void {
  const current = getZoom();
  const next = ZOOM_STEPS.find((step) => step > current + EPSILON);
  setZoom(next ?? MAX_ZOOM);
}

/** Step to the next ladder entry below the current level (no-op at min). */
export function zoomOut(): void {
  const current = getZoom();
  const next = [...ZOOM_STEPS].reverse().find((step) => step < current - EPSILON);
  setZoom(next ?? MIN_ZOOM);
}

/** Restore 100% (and persist it) — ⌘0 and the percentage button share this. */
export function resetZoom(): void {
  setZoom(1);
}

/**
 * Re-apply the persisted level on boot (called from useZoomHotkeys when the
 * app mounts inside the desktop shell). Routing through setZoom also
 * normalizes any out-of-range stored value back into the clamp range.
 */
export function applyPersistedZoom(): void {
  setZoom(getZoom());
}

/**
 * Subscribe to zoom changes — `useSyncExternalStore`-shaped so ZoomSlot can
 * pair it with `getZoom` as the snapshot.
 */
export function subscribeToZoom(onChange: () => void): () => void {
  const handler = () => onChange();
  window.addEventListener(ZOOM_CHANGED_EVENT, handler);
  return () => window.removeEventListener(ZOOM_CHANGED_EVENT, handler);
}
