import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { placeVertically, useDismissable, type DismissReason } from '@desktop/components/Popover';
import { ZOOM_CHANGED_EVENT } from '@desktop/components/StatusBar/consumers/zoomWindow';
import { fixedLayerScale, fixedLayerViewport } from '@desktop/utils/cssZoom';
import styles from './CellPickerPopover.module.scss';

interface Props {
  anchor: HTMLElement | null;
  /** Narrowest width when the pane allows it; never wider than 360px. */
  minWidth?: number;
  /**
   * Close on a press outside the card and its cell, or Escape, through the
   * shared dismiss contract. Left out, the card follows the grid: it stays
   * open while you browse elsewhere for chips to drop on it.
   */
  onDismiss?: (reason: DismissReason) => void;
  children: ReactNode;
}

/**
 * Cell-owned pickers float inside pane bounds without changing the row's geometry.
 *
 * Portaled to `<body>`, so the card is outside the pane's zoom but inside the
 * root zoom: placement is done in rect px and divided by `fixedLayerScale()`
 * (utils/cssZoom); the intended sizes (min width, the 360px caps, insets)
 * stay CSS px.
 */
export function CellPickerPopover({ anchor, minWidth = 240, onDismiss, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const dismissProps = useDismissable({
    open: !!anchor && !!onDismiss,
    onDismiss: (reason) => onDismiss?.(reason),
    surfaceRef: ref,
    triggerRef: anchorRef,
    // The grid's undo and save-error actions act on the open cell.
    keepOpenSelector: '[data-keeps-cell]:not([data-cell-picker-popover])',
  });
  const updatePosition = useRef<(() => void) | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const popup = ref.current;
    if (!anchor || !popup) return;
    const pane = anchor.closest('.pane-body');
    const update = () => {
      // Edges and the cell are rect px; width / maxHeight / height are CSS px.
      const scale = fixedLayerScale();
      const viewport = fixedLayerViewport();
      const inset = 8 * scale;
      const gap = 4 * scale;
      const rect = anchor.getBoundingClientRect();
      const bounds = pane?.getBoundingClientRect();
      const left = Math.max(0, bounds?.left ?? 0) + inset;
      const right = Math.min(viewport.width, bounds?.right ?? viewport.width) - inset;
      const top = Math.max(0, bounds?.top ?? 0) + inset;
      const bottom = Math.min(viewport.height, bounds?.bottom ?? viewport.height) - inset;
      const width = Math.min(
        Math.max(minWidth, rect.width / scale),
        360,
        Math.max(0, right - left) / scale
      );
      // Whole below, else above, else slid over the cell: a long list scrolls
      // inside its 360px cap, but the card is never cut off by the pane.
      const maxHeight = Math.min(360, Math.max(0, bottom - top) / scale);
      const placed = placeVertically({
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        topEdge: top,
        bottomEdge: bottom,
        gap,
        natural: (popup.scrollHeight || 240) * scale,
        limit: maxHeight * scale,
      });
      const next: CSSProperties = {
        left: Math.max(left, Math.min(rect.left, right - width * scale)) / scale,
        top: placed.top / scale,
        width,
        maxHeight,
      };
      setPosition((previous) =>
        previous !== null &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.width === next.width &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next
      );
    };
    updatePosition.current = update;
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(anchor);
    observer?.observe(popup);
    if (pane) observer?.observe(pane);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener(ZOOM_CHANGED_EVENT, update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener(ZOOM_CHANGED_EVENT, update);
      updatePosition.current = null;
    };
  }, [anchor, minWidth]);

  useLayoutEffect(() => updatePosition.current?.());

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      className={styles.popover}
      style={position ?? { opacity: 0, pointerEvents: 'none' }}
      data-keeps-cell=""
      data-cell-picker-popover=""
      data-pane-drop-target="node-chip"
      onPointerDownCapture={dismissProps.onPointerDownCapture}
    >
      {position && children}
    </div>,
    document.body
  );
}
