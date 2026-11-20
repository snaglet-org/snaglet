import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { getEffectiveZoom } from '@desktop/utils/cssZoom';

/**
 * Keeps the open panel fully inside its pane (or the window): right-aligned
 * under the trigger, shifted left or right as needed, narrowed when the pane
 * is narrower than the panel, and flipped above when there is no room below.
 */
export function usePanePosition(
  open: boolean,
  triggerRef: { current: HTMLElement | null },
  surfaceRef: { current: HTMLElement | null }
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const surface = surfaceRef.current;
    if (!open || !trigger || !surface) {
      setStyle(undefined);
      return;
    }
    const pane = trigger.closest('.pane-body') ?? trigger.closest('[data-pane]');
    const update = () => {
      surface.style.width = '';
      // Rects are viewport px; the surface's own style is in its zoomed px.
      const zoom = getEffectiveZoom(surface) || 1;
      const bounds = pane?.getBoundingClientRect();
      const padding = 8;
      const gap = 4;
      const left = Math.max(0, bounds?.left ?? 0) + padding;
      const right = Math.min(window.innerWidth, bounds?.right ?? window.innerWidth) - padding;
      const top = Math.max(0, bounds?.top ?? 0) + padding;
      const bottom = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight) - padding;
      const anchor = trigger.getBoundingClientRect();
      const width = Math.min(surface.scrollWidth * zoom, Math.max(0, right - left));
      const below = bottom - anchor.bottom - gap;
      const above = anchor.top - gap - top;
      const height = surface.scrollHeight * zoom;
      const openBelow = below >= height || below >= above;
      const maxHeight = Math.max(0, openBelow ? below : above);
      const shownHeight = Math.min(height, maxHeight);
      const next = {
        left: `${Math.max(left, Math.min(anchor.right - width, right - width)) / zoom}px`,
        top: `${(openBelow ? anchor.bottom + gap : anchor.top - gap - shownHeight) / zoom}px`,
        width: `${width / zoom}px`,
        maxHeight: `${maxHeight / zoom}px`,
      };
      Object.assign(surface.style, next);
      setStyle(next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(surface);
    if (pane) observer?.observe(pane);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, triggerRef, surfaceRef]);
  return style;
}
