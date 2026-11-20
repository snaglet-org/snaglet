import { useCallback, useEffect, useRef } from 'react';

import { attachHorizontalWheelDelegation } from '@desktop/utils/horizontalWheelScroll';

/**
 * Wheel handling for every horizontally scrollable region inside a subtree:
 * in a page that scrolls vertically each gesture keeps to one axis (scrolling
 * down over a table moves the page, a sideways swipe or Shift+wheel moves the
 * table), and a region with no vertical scrolling around it takes a plain
 * vertical wheel sideways. Returns a ref callback for the wrapper; the hook
 * attaches one delegated wheel listener there, so content added later is
 * covered too. Rules are in `utils/horizontalWheelScroll.ts`.
 *
 * ```tsx
 * const wheelRef = useHorizontalWheelScroll<HTMLDivElement>();
 * return <div ref={wheelRef}>…</div>;
 * ```
 */
export function useHorizontalWheelScroll<T extends HTMLElement>(): (el: T | null) => void {
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      detachRef.current?.();
      detachRef.current = null;
    },
    []
  );

  return useCallback((el: T | null) => {
    detachRef.current?.();
    detachRef.current = el ? attachHorizontalWheelDelegation(el) : null;
  }, []);
}
