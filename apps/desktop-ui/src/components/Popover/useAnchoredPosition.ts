import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ZOOM_CHANGED_EVENT } from '@desktop/components/StatusBar/consumers/zoomWindow';
import { fixedLayerScale, fixedLayerViewport } from '@desktop/utils/cssZoom';

/**
 * Fixed-position geometry shared by every surface pinned to an anchor. The
 * surface is clamped to the anchor's pane (`.pane-body`, else the window) and
 * opens on its preferred side if it fits, else the other side, else slides
 * over the anchor (`placeVertically`); `side: 'beside'` opens it left or right
 * instead (`placeBeside`). It scrolls only when taller than the pane.
 *
 * Rects are converted to the fixed layer's CSS px with `fixedLayerScale()`,
 * because the surface sits inside the root zoom but outside the pane's.
 *
 * Returns `null` until the anchor has connected geometry; callers keep the
 * surface hidden until then, so autofocus lands after placement.
 */
export interface AnchoredPositionOptions {
  /** The element the surface hangs from. */
  anchor: HTMLElement;
  /**
   * Re-resolve the anchor on every update — for anchors a re-render may
   * replace (a grid header after a schema save). While it returns null the
   * last known geometry is held.
   */
  resolveAnchor?: () => HTMLElement | null;
  /** The floating surface. Observed for size changes. */
  surfaceRef: RefObject<HTMLElement | null>;
  /** Fixed surface width, capped by the clamp box. Default 320. */
  width?: number;
  /**
   * Size to the content, up to `width`, instead of always being `width` wide:
   * the cap is written as `maxWidth` and the rendered width is what's placed.
   */
  fitContent?: boolean;
  /**
   * The side it opens on whenever it fits whole there. Default `below`.
   * `beside`: right of the anchor, else left, else below / above.
   */
  side?: VerticalSide | 'beside';
  /** The anchor edge it lines up with: left (`start`) or right (`end`). Default `start`. */
  align?: 'start' | 'end';
  /** Tallest the surface may grow (the pane caps it too). Default 560. */
  maxHeight?: number;
  /** Gap between anchor and surface. Default 4. */
  gap?: number;
  /** Inset from the clamp box edges. Default 8. */
  padding?: number;
  /**
   * Extra subtree whose child-list mutations should trigger a re-measure when
   * there is no pane (defaults to none). The pane, when found, is always used.
   */
  mutationScope?: (anchor: HTMLElement) => Element | null | undefined;
}

export interface AnchoredPosition {
  /** `null` until the anchor has had connected geometry once. */
  position: CSSProperties | null;
  /** Re-measure now (e.g. after content inside the surface changed). */
  update: () => void;
}

type VerticalSide = 'below' | 'above';

/**
 * @public The left edge of a surface `width` wide beside an anchor, in one
 * unit (rect px): right of the anchor when it fits whole there, else left of
 * it, else null (no room on either side); unit-tested.
 */
export function placeBeside({
  anchorLeft,
  anchorRight,
  leftEdge,
  rightEdge,
  gap,
  width,
}: {
  anchorLeft: number;
  anchorRight: number;
  leftEdge: number;
  rightEdge: number;
  gap: number;
  width: number;
}): number | null {
  if (anchorRight + gap + width <= rightEdge) return anchorRight + gap;
  if (anchorLeft - gap - width >= leftEdge) return anchorLeft - gap - width;
  return null;
}

/**
 * Where a surface of `natural` height goes beside an anchor, in one unit
 * (rect px): on the preferred `side` (below unless told otherwise) when it
 * fits whole there, else on the other side when it fits there, else from the
 * roomier side slid along the box until it fits, covering the anchor rather
 * than cutting the surface off. `height` is what will show: the natural
 * height, capped by `limit` and the box, so the surface scrolls only when it
 * is taller than the box.
 */
export function placeVertically({
  anchorTop,
  anchorBottom,
  topEdge,
  bottomEdge,
  gap,
  natural,
  limit,
  side = 'below',
}: {
  anchorTop: number;
  anchorBottom: number;
  topEdge: number;
  bottomEdge: number;
  gap: number;
  natural: number;
  limit: number;
  side?: VerticalSide;
}): { top: number; height: number } {
  const height = Math.max(0, Math.min(natural, limit, bottomEdge - topEdge));
  const room = { below: bottomEdge - (anchorBottom + gap), above: anchorTop - gap - topEdge };
  const other: VerticalSide = side === 'below' ? 'above' : 'below';
  const preferred = height <= room[side] || (height > room[other] && room[side] >= room[other]);
  const opensBelow = preferred === (side === 'below');
  const start = opensBelow ? anchorBottom + gap : anchorTop - gap - height;
  return { top: Math.max(topEdge, Math.min(start, bottomEdge - height)), height };
}

function sameBox(a: CSSProperties, b: CSSProperties): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight
  );
}

/**
 * The surface's whole height in rect px, borders included, even while capped,
 * so a surface opening upward keeps the full gap to its anchor.
 */
function naturalHeight(surface: HTMLElement, scale: number): number {
  // Not capped: the rendered height is exact (whole-px scroll metrics would
  // be off by up to a pixel times the zoom).
  if (surface.scrollHeight <= surface.clientHeight) return surface.getBoundingClientRect().height;
  // Capped: scrollHeight is content + padding; offsetHeight − clientHeight
  // adds the borders (and a horizontal scrollbar).
  return (surface.scrollHeight + surface.offsetHeight - surface.clientHeight) * scale;
}

export function useAnchoredPosition({
  anchor,
  resolveAnchor,
  surfaceRef,
  width: preferredWidth = 320,
  fitContent = false,
  side = 'below',
  align = 'start',
  maxHeight: heightLimit = 560,
  gap = 4,
  padding = 8,
  mutationScope,
}: AnchoredPositionOptions): AnchoredPosition {
  const resolver = useRef(resolveAnchor);
  resolver.current = resolveAnchor;
  const scopeOf = useRef(mutationScope);
  scopeOf.current = mutationScope;
  const geometry = useRef({ preferredWidth, fitContent, side, align, heightLimit, gap, padding });
  geometry.current = { preferredWidth, fitContent, side, align, heightLimit, gap, padding };
  const updatePosition = useRef<(() => void) | null>(null);
  const lastAnchorRect = useRef<DOMRect | null>(null);
  const paneRef = useRef(anchor.closest('.pane-body'));
  const [position, setPosition] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const popover = surfaceRef.current;
    if (!popover) return;
    const pane = paneRef.current;
    let observer: ResizeObserver | null = null;
    let observedAnchor: HTMLElement | null = null;
    const update = () => {
      const resolved = resolver.current?.() ?? (anchor.isConnected ? anchor : null);
      if (resolved?.isConnected) {
        lastAnchorRect.current = resolved.getBoundingClientRect();
        if (observedAnchor !== resolved) {
          if (observedAnchor) observer?.unobserve(observedAnchor);
          observedAnchor = resolved;
          observer?.observe(resolved);
        }
      }
      // A re-render can replace the anchor before its replacement exists.
      // Hold the last position until a live trigger is available again.
      const trigger = lastAnchorRect.current;
      if (!trigger) return;
      const { preferredWidth, fitContent, side, align, heightLimit, gap, padding } =
        geometry.current;
      // Edges, room and the anchor are rect px; `width`, `maxHeight` and
      // `height` are the surface's own CSS px; `scale` converts between them.
      const scale = fixedLayerScale();
      const viewport = fixedLayerViewport();
      const inset = padding * scale;
      const offset = gap * scale;
      const bounds = pane?.getBoundingClientRect();
      const leftEdge = Math.max(0, bounds?.left ?? 0) + inset;
      const rightEdge = Math.min(viewport.width, bounds?.right ?? viewport.width) - inset;
      const topEdge = Math.max(0, bounds?.top ?? 0) + inset;
      const bottomEdge = Math.min(viewport.height, bounds?.bottom ?? viewport.height) - inset;
      const width = Math.min(preferredWidth, Math.max(0, rightEdge - leftEdge) / scale);
      const maxHeight = Math.min(heightLimit, Math.max(0, bottomEdge - topEdge) / scale);
      // A content-sized surface wraps inside its cap before it is measured.
      if (fitContent) popover.style.maxWidth = `${width}px`;
      const shownWidth = fitContent ? popover.getBoundingClientRect().width : width * scale;
      const natural = naturalHeight(popover, scale);
      const besideLeft =
        side === 'beside'
          ? placeBeside({
              anchorLeft: trigger.left,
              anchorRight: trigger.right,
              leftEdge,
              rightEdge,
              gap: offset,
              width: shownWidth,
            })
          : null;
      let top: number;
      let left: number;
      if (besideLeft !== null) {
        // Beside: top-aligned with the anchor, slid up only as far as it
        // takes to show whole.
        const height = Math.max(0, Math.min(natural, maxHeight * scale, bottomEdge - topEdge));
        top = Math.max(topEdge, Math.min(trigger.top, bottomEdge - height));
        left = besideLeft;
      } else {
        // Before the content has laid out (0) it starts beside the anchor; the
        // observers re-place it once the content is there.
        top = placeVertically({
          anchorTop: trigger.top,
          anchorBottom: trigger.bottom,
          topEdge,
          bottomEdge,
          gap: offset,
          natural,
          limit: maxHeight * scale,
          side: side === 'beside' ? 'below' : side,
        }).top;
        const preferredLeft = align === 'end' ? trigger.right - shownWidth : trigger.left;
        left = Math.max(leftEdge, Math.min(preferredLeft, rightEdge - shownWidth));
      }
      const next: CSSProperties = {
        left: left / scale,
        top: top / scale,
        ...(fitContent ? { maxWidth: width } : { width }),
        maxHeight,
      };
      setPosition((previous) => (previous !== null && sameBox(previous, next) ? previous : next));
    };
    observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    updatePosition.current = update;
    update();
    observer?.observe(popover);
    if (pane) observer?.observe(pane);
    // Content that grows past a capped surface (an editor opening) doesn't
    // resize it, so re-place on changes inside it too.
    const contentObserver = new MutationObserver(update);
    contentObserver.observe(popover, { childList: true, subtree: true });
    // A re-render can replace the anchor without changing the surrounding
    // layout's dimensions, so watch the subtree's child list as well.
    const anchorScope = pane ?? scopeOf.current?.(anchor);
    const mutationObserver = anchorScope ? new MutationObserver(update) : null;
    if (anchorScope) mutationObserver?.observe(anchorScope, { childList: true, subtree: true });
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener(ZOOM_CHANGED_EVENT, update);
    return () => {
      observer?.disconnect();
      mutationObserver?.disconnect();
      contentObserver.disconnect();
      updatePosition.current = null;
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener(ZOOM_CHANGED_EVENT, update);
    };
  }, [anchor, surfaceRef]);

  // Refresh after the host's own render too, even if nothing observed changed
  // size enough to notify ResizeObserver.
  useLayoutEffect(() => updatePosition.current?.());

  return { position, update: () => updatePosition.current?.() };
}
