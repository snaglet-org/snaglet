import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '@snaglet/shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';

// useSidebarWidth — manages the resizable dashboard sidebar width.
//
// Persists to localStorage under `storageKey`, clamps to [min, max],
// and exposes pointer handlers for a drag-resize affordance.
//
// The hook does not own the DOM — callers wire onPointerDown onto a
// resizer element and use `width` to drive a CSS variable on the
// shell. While dragging, body cursor + user-select are locked so the
// drag feels native and doesn't accidentally select text.

/** What makes one resizable column differ from another (defaults: the dashboard sidebar). */
export interface SidebarWidthOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}

// The width a new install opens with (activity bar included): wide enough
// that most seeded tree names fit without an ellipsis. A width the person
// has saved (dragged, or the default persisted on an earlier launch) is read
// back from storage and wins, so raising this never resizes an existing
// install.
const DASHBOARD_SIDEBAR: SidebarWidthOptions = {
  storageKey: 'snaglet.dashboard.sidebarWidth',
  defaultWidth: 320,
  min: SIDEBAR_MIN_WIDTH,
  max: SIDEBAR_MAX_WIDTH,
};

/** Arrow-key resize step (px). */
const KEY_STEP = 16;

function clampTo({ min, max, defaultWidth }: SidebarWidthOptions, value: number): number {
  if (Number.isNaN(value)) return defaultWidth;
  return Math.min(max, Math.max(min, value));
}

function readInitialWidth(options: SidebarWidthOptions): number {
  if (typeof window === 'undefined') return options.defaultWidth;
  try {
    const raw = window.localStorage.getItem(options.storageKey);
    if (!raw) return options.defaultWidth;
    return clampTo(options, Number.parseInt(raw, 10));
  } catch {
    return options.defaultWidth;
  }
}

export interface UseSidebarWidthResult {
  width: number;
  setWidth: (width: number) => void;
  isResizing: boolean;
  onResizerPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
  /** ← / → move by a step, Home / End jump to the ends. */
  onResizerKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  minWidth: number;
  maxWidth: number;
}

export function useSidebarWidth(
  options: SidebarWidthOptions = DASHBOARD_SIDEBAR
): UseSidebarWidthResult {
  const { storageKey, defaultWidth, min, max } = options;
  const clamp = useCallback(
    (value: number) => clampTo({ storageKey, defaultWidth, min, max }, value),
    [storageKey, defaultWidth, min, max]
  );
  const [width, setWidth] = useState<number>(() => readInitialWidth(options));
  const [isResizing, setIsResizing] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Persist to localStorage whenever width settles.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // localStorage may be unavailable (private mode, etc.) — ignore.
    }
  }, [storageKey, width]);

  const endDrag = useCallback(() => {
    dragStateRef.current = null;
    setIsResizing(false);
    if (typeof document !== 'undefined') {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      const delta = e.clientX - state.startX;
      setWidth(clamp(state.startWidth + delta));
    };

    const handleUp = () => {
      endDrag();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [isResizing, endDrag, clamp]);

  const onResizerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Left button only.
      if (e.button !== 0) return;
      e.preventDefault();
      dragStateRef.current = { startX: e.clientX, startWidth: width };
      setIsResizing(true);
      if (typeof document !== 'undefined') {
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }
    },
    [width]
  );

  const resetWidth = useCallback(() => {
    setWidth(defaultWidth);
  }, [defaultWidth]);

  const onResizerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const next =
        e.key === 'ArrowLeft'
          ? width - KEY_STEP
          : e.key === 'ArrowRight'
            ? width + KEY_STEP
            : e.key === 'Home'
              ? min
              : e.key === 'End'
                ? max
                : null;
      if (next === null) return;
      e.preventDefault();
      setWidth(clamp(next));
    },
    [width, min, max, clamp]
  );

  return {
    width,
    setWidth: (value) => setWidth(clamp(value)),
    isResizing,
    onResizerPointerDown,
    resetWidth,
    onResizerKeyDown,
    minWidth: min,
    maxWidth: max,
  };
}
