import { useEffect, useState, type RefObject } from 'react';

/** Data attributes for a sideways scroller's ends that have content past them. */
export interface ScrollEdgeAttributes {
  'data-overflow-start'?: '';
  'data-overflow-end'?: '';
}

/**
 * Tracks which ends of a sideways scroller have content scrolled past them,
 * as data attributes for the `layout-scroll-edge-fade` mixin, which fades
 * those edges as the hint that the box scrolls. Re-measures on scroll, when
 * the box or its first child (a table) resizes, and when children come or go
 * (a board column added). Pass `mounted` when the scroller renders
 * conditionally, so tracking starts once it is in the DOM.
 */
export function useScrollEdges(
  ref: RefObject<HTMLElement | null>,
  mounted = true
): ScrollEdgeAttributes {
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const observeContent = () => {
      if (!resize) return;
      resize.disconnect();
      resize.observe(el);
      if (el.firstElementChild) resize.observe(el.firstElementChild);
    };
    observeContent();
    const children =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observeContent();
            measure();
          });
    children?.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', measure);
      resize?.disconnect();
      children?.disconnect();
    };
  }, [ref, mounted]);

  return {
    'data-overflow-start': edges.start ? '' : undefined,
    'data-overflow-end': edges.end ? '' : undefined,
  };
}
