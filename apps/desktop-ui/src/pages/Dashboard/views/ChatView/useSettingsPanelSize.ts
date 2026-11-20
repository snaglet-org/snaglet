import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { getEffectiveZoom } from '@desktop/utils/cssZoom';

const DRAWER_MIN_H = 120;
/** Fraction of the shell's height the drawer may take. */
const DRAWER_MAX_H_FRAC = 0.92;
/** The drawer's CSS height before the user drags it (78% of the shell). */
const DRAWER_DEFAULT_FRAC = 0.78;
const SIDEBAR_MIN_W = 220;
const SIDEBAR_MAX_W = 600;
/** The sidebar's CSS width before the user drags it. */
const SIDEBAR_DEFAULT_W = 300;

interface HandleProps {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

export interface SettingsPanelSize {
  /** Inline size for the narrow-pane top drawer; undefined keeps the CSS default. */
  drawerStyle: CSSProperties | undefined;
  /** Inline size for the wide-pane sidebar; undefined keeps the CSS default. */
  sidebarStyle: CSSProperties | undefined;
  /** Pointer handlers for the drawer's bottom edge. */
  drawerHandle: HandleProps;
  /** Pointer handlers for the sidebar's left edge. */
  sidebarHandle: HandleProps;
}

/**
 * Drag-to-resize for ChatView's settings panel: the top drawer in a narrow
 * pane, the right-hand sidebar in a wide one. Pointer deltas are viewport
 * px while the panel is sized in the shell's own (pane-zoomed) px, so each
 * delta is divided by the shell's zoom to keep the edge under the cursor.
 */
export function useSettingsPanelSize(shellRef: RefObject<HTMLElement | null>): SettingsPanelSize {
  const [drawerHeight, setDrawerHeight] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startX: number; startSize: number } | null>(null);

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const startDrag = (e: ReactPointerEvent<HTMLElement>, startSize: number) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startX: e.clientX, startSize };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDrawerPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const shell = shellRef.current;
    if (!shell) return;
    startDrag(e, drawerHeight ?? shell.offsetHeight * DRAWER_DEFAULT_FRAC);
  };

  const onDrawerPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      const shell = shellRef.current;
      if (!drag || !shell) return;
      const delta = (e.clientY - drag.startY) / getEffectiveZoom(shell);
      const maxH = shell.offsetHeight * DRAWER_MAX_H_FRAC;
      setDrawerHeight(Math.min(maxH, Math.max(DRAWER_MIN_H, drag.startSize + delta)));
    },
    [shellRef]
  );

  const onSidebarPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    startDrag(e, sidebarWidth ?? SIDEBAR_DEFAULT_W);
  };

  const onSidebarPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      // The handle is the sidebar's LEFT edge: dragging left widens it.
      const delta = (drag.startX - e.clientX) / getEffectiveZoom(shellRef.current);
      setSidebarWidth(Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, drag.startSize + delta)));
    },
    [shellRef]
  );

  return {
    drawerStyle:
      drawerHeight != null
        ? { height: `${drawerHeight}px`, maxHeight: `${drawerHeight}px` }
        : undefined,
    sidebarStyle:
      sidebarWidth != null
        ? { width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` }
        : undefined,
    drawerHandle: {
      onPointerDown: onDrawerPointerDown,
      onPointerMove: onDrawerPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    sidebarHandle: {
      onPointerDown: onSidebarPointerDown,
      onPointerMove: onSidebarPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
