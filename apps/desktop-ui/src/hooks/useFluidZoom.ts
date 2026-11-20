import { useLayoutEffect, type RefObject } from 'react';
import { fluidZoom, type FluidZoomSpec } from '@desktop/styles/typeScale';

/**
 * Fallback driver for the fluid per-surface zoom.
 *
 * The zoom is pure CSS (`zoom: var(--<name>, clamp(min, calc(100cqi / full), 1))`)
 * on engines that can divide two lengths in `calc()` (Chrome 140+). Elsewhere
 * that declaration is dropped, so this hook writes the same `clamp()` result to
 * the custom property from a ResizeObserver (no React state, so a divider drag
 * never re-renders per frame). It is a no-op wherever the CSS path works.
 *
 * @param ref     The CSS container the zoom is measured against, not the
 *                zoomed content, whose width would feed back into itself.
 * @param cssVar  The custom property the surface's `zoom: var(…)` reads.
 * @param spec    Full width + floor (PANE_ZOOM / SIDEBAR_ZOOM).
 */
export function useFluidZoom(
  ref: RefObject<HTMLElement | null>,
  cssVar: `--${string}`,
  spec: FluidZoomSpec
): void {
  const { fullWidth, min, strength } = spec;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined' || engineEvaluatesFluidZoom()) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        el.style.setProperty(cssVar, String(fluidZoom(width, { fullWidth, min, strength })));
      }
    });
    // ResizeObserver delivers an initial notification on observe, so the
    // first value lands before paint without a separate measurement.
    observer.observe(el);
    return () => {
      observer.disconnect();
      el.style.removeProperty(cssVar);
    };
  }, [ref, cssVar, fullWidth, min, strength]);
}

/**
 * True when the engine parses a length-by-length `calc()` division into a
 * number for `zoom` — the exact shape of the CSS expression the hook backs
 * up. Checked per mount (cheap) rather than cached so tests can toggle it.
 */
function engineEvaluatesFluidZoom(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
  return CSS.supports('zoom', 'clamp(0.7, calc(1 - 0.5 * (1 - 100cqi / 840px)), 1)');
}
