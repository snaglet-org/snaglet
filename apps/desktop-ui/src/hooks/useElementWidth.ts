import { useEffect, useState, type RefObject } from 'react';
import { getEffectiveZoom } from '@desktop/utils/cssZoom';

/**
 * Tracks an element's rendered width with ResizeObserver.
 *
 * Use this when component state needs the measured width, such as switching
 * a pane layout at a breakpoint that CSS alone cannot drive. The width is in
 * the element's own px (what its CSS and container queries see), not
 * viewport px — under the pane's fluid zoom those differ.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    // ResizeObserver reports the element's own px; match it here so the
    // first value doesn't flip a breakpoint that the observer then unflips.
    setWidth(el.getBoundingClientRect().width / getEffectiveZoom(el));

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        setWidth(next);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
