export interface EdgeAutoScrollOptions {
  axis: 'x' | 'y';
  /** Distance from an edge, in px, where scrolling starts. */
  zone?: number;
  /** Pixels per frame at the very edge. */
  maxSpeed?: number;
  /** Called after each frame that actually scrolled. */
  onScroll?: () => void;
}

export interface EdgeAutoScroller {
  /** Report the pointer; starts or stops the loop as it enters or leaves a zone. */
  update(clientX: number, clientY: number): void;
  stop(): void;
}

/**
 * Scroll `el` while a drag hovers near one of its edges, faster the closer the
 * pointer gets. The loop keeps running while the pointer rests in the zone, so
 * a drag can reach content that is scrolled out of view without jiggling.
 */
export function createEdgeAutoScroller(
  el: HTMLElement,
  { axis, zone = 60, maxSpeed = 16, onScroll }: EdgeAutoScrollOptions
): EdgeAutoScroller {
  let rafId: number | null = null;
  let point = 0;

  const speed = () => {
    const rect = el.getBoundingClientRect();
    const start = axis === 'x' ? rect.left : rect.top;
    const end = axis === 'x' ? rect.right : rect.bottom;
    if (point - start < zone) return -maxSpeed * (1 - Math.max(0, point - start) / zone);
    if (end - point < zone) return maxSpeed * (1 - Math.max(0, end - point) / zone);
    return 0;
  };

  const tick = () => {
    const delta = speed();
    const before = axis === 'x' ? el.scrollLeft : el.scrollTop;
    if (delta !== 0) {
      // Snaglet scrolls smoothly by default, and a smooth assignment doesn't move
      // synchronously: `moved` would read false and `onScroll` would never
      // re-target the drag. Force this step to be immediate.
      const previousBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      if (axis === 'x') el.scrollLeft = before + delta;
      else el.scrollTop = before + delta;
      el.style.scrollBehavior = previousBehavior;
    }
    const moved = (axis === 'x' ? el.scrollLeft : el.scrollTop) !== before;
    if (moved) onScroll?.();
    rafId = delta !== 0 ? window.requestAnimationFrame(tick) : null;
  };

  return {
    update(clientX, clientY) {
      point = axis === 'x' ? clientX : clientY;
      if (rafId === null && speed() !== 0) rafId = window.requestAnimationFrame(tick);
    },
    stop() {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}
