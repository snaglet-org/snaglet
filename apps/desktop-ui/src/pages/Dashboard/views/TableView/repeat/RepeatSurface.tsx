import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition } from '@desktop/components/Popover';
import {
  datePickerOwnsEscape,
  isInsideDatePicker,
} from '@desktop/components/controls/DateInput/pickerLayer';
import styles from './RepeatSurface.module.scss';

export interface RepeatSurfaceProps {
  anchor: HTMLElement;
  label: string;
  onDismiss: () => void;
  width?: number;
  /** No padding: the content (the Repeat panel) brings its own, edge to edge. */
  flush?: boolean;
  children: ReactNode;
}

/**
 * The repeat editor's floating card: positioned by the shared
 * `useAnchoredPosition`, portaled to `<body>`, focus back to the opener on
 * close.
 *
 * Dismiss is handled here rather than with `useDismissable`, whose Escape
 * and outside-press rules defer to any open `aria-modal` (the row modal this
 * surface also opens from) and would leave the popover stuck. Escape is
 * taken in the window's capture phase (the popover is the topmost layer), so
 * it never also closes the row modal or the grid's cell; a date picker
 * opened from inside (the end date) sits above it, so its Escape and
 * presses are the picker's, and a press outside both closes only the
 * picker. `data-keeps-cell` keeps the grid's active cell open.
 */
export function RepeatSurface({
  anchor,
  label,
  onDismiss,
  width = 300,
  flush = false,
  children,
}: RepeatSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const { position } = useAnchoredPosition({ anchor, surfaceRef, width, maxHeight: 720 });

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (surfaceRef.current?.contains(target) || anchor.contains(target)) return;
      // A press in a picker opened from the card is inside it; a press
      // outside everything closes the picker and the card together.
      if (isInsideDatePicker(target)) return;
      dismiss.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || datePickerOwnsEscape(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchor]);

  // Focus returns to the opener when the surface closes with focus inside it.
  useEffect(() => {
    const surface = surfaceRef.current;
    return () => {
      const active = document.activeElement;
      if (
        anchor.isConnected &&
        (!active ||
          active === document.body ||
          !active.isConnected ||
          (surface !== null && surface.contains(active)))
      )
        anchor.focus({ preventScroll: true });
    };
  }, [anchor]);

  // Focus the checked option (or the first control) once placed.
  useEffect(() => {
    if (!position) return;
    const surface = surfaceRef.current;
    if (!surface || surface.contains(document.activeElement)) return;
    surface
      .querySelector<HTMLElement>('[aria-checked="true"], button:not(:disabled), input, select')
      ?.focus({ preventScroll: true });
  }, [position]);

  return createPortal(
    <div
      ref={surfaceRef}
      role="dialog"
      aria-label={label}
      className={flush ? `${styles.surface} ${styles.flush}` : styles.surface}
      style={position ?? { position: 'fixed', opacity: 0, pointerEvents: 'none', width }}
      data-keeps-cell=""
      data-repeat-surface=""
    >
      {position && children}
    </div>,
    document.body
  );
}
