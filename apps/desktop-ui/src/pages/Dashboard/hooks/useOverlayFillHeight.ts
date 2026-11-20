import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import { getEffectiveZoom } from '@desktop/utils/cssZoom';

// useOverlayFillHeight — size a floating Properties overlay to its room.
//
// The Properties dropdowns (DocProperties, ContainerProperties, and the
// project DetailsPanel's collapsible mode) float as `position: absolute`
// popovers whose top edge sits at the bottom of their header. That header's
// viewport offset is NOT fixed — panes split, scroll, and stack — so a
// pure-CSS `max-height: calc(100vh - <const>)` can't know how much room is
// left below it.
//
// This measures the overlay element's own viewport-top and returns the
// max-height that lets it grow down to a small margin above the viewport
// bottom: as tall as the room allows, capped to the viewport, scrolling
// internally (via the element's own `overflow-y: auto`) when its content is
// taller — instead of an arbitrary fixed cap. Recomputes on resize and on any
// scroll (capture phase) so the cap tracks the anchor as the pane moves.
// Returns `undefined` while disabled (collapsed) so callers can drop the
// inline cap entirely and let the element fall back to its CSS default.

/** Gap left between the overlay's bottom edge and the viewport bottom. */
const VIEWPORT_MARGIN = 16;
/** Never collapse the overlay below this, even in a very short viewport. */
const MIN_OVERLAY_HEIGHT = 160;

export function useOverlayFillHeight(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean
): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    // Room is measured in viewport px; max-height is applied in the
    // overlay's own (pane-zoomed) px, so convert or the cap comes up short.
    const available = (window.innerHeight - top - VIEWPORT_MARGIN) / getEffectiveZoom(el);
    setMaxHeight(Math.max(MIN_OVERLAY_HEIGHT, Math.round(available)));
  }, [ref]);

  useLayoutEffect(() => {
    if (!enabled) {
      setMaxHeight(undefined);
      return;
    }
    measure();
    window.addEventListener('resize', measure);
    // Capture phase so a scroll inside any ancestor (not just the window) that
    // shifts the anchor still triggers a recompute.
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [enabled, measure]);

  return maxHeight;
}
