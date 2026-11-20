/**
 * The one floating surface every calendar popover is built on:
 * quick add, the event popover, "+N more", the field picker, the color
 * palette. Positioning comes from the shared `useAnchoredPosition`; dismiss
 * (Escape / outside press) from `useDismissable`: Escape closes the innermost
 * open surface first, and a press outside every surface closes them all (a
 * press inside a surface opened from this one is inside this one too); focus
 * returns to the opener on close (`returnFocusTo`).
 *
 * Side: anchored to something in a Week / 3-day / Day grid (`[data-time-grid]`)
 * it opens beside it (right, else left, else below / above), so it never
 * covers the clicked item or the hours under it; elsewhere below (else above).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition, useDismissable } from '@desktop/components/Popover';
import { cn } from '@desktop/utils/classNames';
import styles from './CalendarPopovers.module.scss';

export interface AnchoredSurfaceProps {
  anchor: HTMLElement;
  label: string;
  onDismiss: () => void;
  width?: number;
  role?: 'dialog' | 'menu';
  className?: string;
  /** Where focus goes on close; defaults to the anchor when it is focusable. */
  returnFocusTo?: HTMLElement | null;
  /** Presses inside these never dismiss (e.g. the ghost block). */
  keepOpenSelector?: string;
  /**
   * Find the anchor again when a re-render may replace it (a calendar item
   * redrawn after a refetch); while it returns null the last place is kept.
   */
  resolveAnchor?: () => HTMLElement | null;
  /** Where it opens; default `beside` in a time grid, else `below`. */
  side?: 'below' | 'above' | 'beside';
  children: ReactNode;
}

/** A Week / 3-day / Day grid: its items are tall and stacked, so surfaces open beside them. */
const TIME_GRID_SELECTOR = '[data-time-grid]';

export function AnchoredSurface({
  anchor,
  label,
  onDismiss,
  width = 300,
  role = 'dialog',
  className,
  returnFocusTo,
  keepOpenSelector,
  resolveAnchor,
  side,
  children,
}: AnchoredSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { position } = useAnchoredPosition({
    anchor,
    resolveAnchor,
    surfaceRef,
    width,
    side: side ?? (anchor.closest(TIME_GRID_SELECTOR) ? 'beside' : 'below'),
    // No height cap of its own: the pane is the limit, so it scrolls only
    // when it is taller than the pane.
    maxHeight: Number.POSITIVE_INFINITY,
  });
  const dismissProps = useDismissable({
    open: true,
    onDismiss,
    surfaceRef,
    keepOpenSelector,
  });

  // A hidden surface can't take focus (React's autoFocus runs while it is
  // still `visibility: hidden`), so focus `[data-autofocus]` once it is placed.
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    const surface = surfaceRef.current;
    if (!surface || surface.contains(document.activeElement)) return;
    surface.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [placed]);

  // Return focus to the opener (or anchor) when the surface unmounts.
  const returnTarget = useRef(returnFocusTo ?? anchor);
  returnTarget.current = returnFocusTo ?? anchor;
  const resolveRef = useRef(resolveAnchor);
  resolveRef.current = resolveAnchor;
  useEffect(
    () => () => {
      const opener = returnTarget.current;
      const target = opener?.isConnected ? opener : (resolveRef.current?.() ?? opener);
      const active = document.activeElement;
      // Only steal focus back when it was inside the surface (or lost to body).
      if (target?.isConnected && (!active || active === document.body || !active.isConnected)) {
        target.focus({ preventScroll: true });
      }
    },
    []
  );

  return createPortal(
    <div
      ref={surfaceRef}
      role={role}
      aria-label={label}
      className={cn(styles.surface, className)}
      style={position ?? { position: 'fixed', visibility: 'hidden', width }}
      data-calendar-surface=""
      data-floating-layer=""
      {...dismissProps}
    >
      {children}
    </div>,
    document.body
  );
}
