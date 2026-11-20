import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

/**
 * A panel height the user drags, like `useSidebarWidth` for width: saved in
 * localStorage under `storageKey`, clamped to [min, max], with pointer and
 * keyboard handlers for a separator on one of the panel's edges: its top edge
 * (`direction: 'up'`, the default: dragging up makes it taller) or its bottom
 * edge (`'down'`). Double-click (`reset`) goes back to the default. While dragging,
 * the body cursor and text selection are locked so the drag feels native.
 */
export interface ResizableHeightOptions {
  storageKey: string;
  defaultHeight: number;
  min: number;
  max: number;
  /** Which way a drag grows it: the handle's edge. Default `up` (a top-edge handle). */
  direction?: 'up' | 'down';
}

export interface ResizableHeight {
  height: number;
  isResizing: boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  /** ↑ / ↓ move by a step, Home / End jump to the ends. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  reset: () => void;
}

const KEY_STEP = 16;

export function clampHeight(value: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readStored({ storageKey, defaultHeight, min, max }: ResizableHeightOptions): number {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return defaultHeight;
    return clampHeight(Number.parseInt(raw, 10), min, max, defaultHeight);
  } catch {
    return defaultHeight;
  }
}

export function useResizableHeight(options: ResizableHeightOptions): ResizableHeight {
  const { storageKey, defaultHeight, min, max, direction = 'up' } = options;
  // Dragging down grows a bottom-edge handle's panel and shrinks a top-edge one's.
  const grow = direction === 'down' ? 1 : -1;
  const [height, setHeight] = useState(() => readStored(options));
  const [isResizing, setIsResizing] = useState(false);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(height));
    } catch {
      // Private mode / quota: the height still works for this session.
    }
  }, [storageKey, height]);

  const endDrag = useCallback(() => {
    drag.current = null;
    setIsResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const move = (e: globalThis.PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      setHeight(
        clampHeight(state.startHeight + grow * (e.clientY - state.startY), min, max, defaultHeight)
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [isResizing, endDrag, min, max, defaultHeight, grow]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { startY: event.clientY, startHeight: height };
      setIsResizing(true);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [height]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const next =
        event.key === 'ArrowUp'
          ? height - grow * KEY_STEP
          : event.key === 'ArrowDown'
            ? height + grow * KEY_STEP
            : event.key === 'Home'
              ? max
              : event.key === 'End'
                ? min
                : null;
      if (next === null) return;
      event.preventDefault();
      setHeight(clampHeight(next, min, max, defaultHeight));
    },
    [height, min, max, defaultHeight, grow]
  );

  const reset = useCallback(() => setHeight(defaultHeight), [defaultHeight]);

  return { height, isResizing, onPointerDown, onKeyDown, reset };
}
