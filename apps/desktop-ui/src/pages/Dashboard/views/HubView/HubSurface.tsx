import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition, useDismissable } from '@desktop/components/Popover';
import { cn } from '@desktop/utils/classNames';
import styles from './HubView.module.scss';

interface HubSurfaceProps {
  /** The control it hangs from; focus returns there on close. */
  anchor: HTMLElement;
  label: string;
  /** Escape or a press outside: close without saving. */
  onDismiss: () => void;
  width?: number;
  align?: 'start' | 'end';
  className?: string;
  children: ReactNode;
}

/**
 * A floating surface on Home (the pin picker, the instructions editor), built
 * like the app's other anchored surfaces: portaled out of the pane, placed by
 * `useAnchoredPosition` (below, else above, else sliding to stay in the
 * pane), and dismissed by `useDismissable`, so Escape or one press outside
 * closes only this innermost layer. Focus moves to `[data-autofocus]` once
 * placed and back to the anchor on close.
 */
export function HubSurface({
  anchor,
  label,
  onDismiss,
  width = 320,
  align = 'start',
  className,
  children,
}: HubSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { position } = useAnchoredPosition({ anchor, surfaceRef, width, align, maxHeight: 520 });
  // The anchor is the control that opened it: a press there toggles it shut
  // through the control's own click instead of dismiss-then-reopen.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const dismissProps = useDismissable({ open: true, onDismiss, surfaceRef, triggerRef: anchorRef });

  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    const surface = surfaceRef.current;
    if (!surface || surface.contains(document.activeElement)) return;
    surface.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(
    () => () => {
      const opener = anchorRef.current;
      const active = document.activeElement;
      if (opener.isConnected && (!active || active === document.body || !active.isConnected)) {
        opener.focus({ preventScroll: true });
      }
    },
    []
  );

  return createPortal(
    <div
      ref={surfaceRef}
      role="dialog"
      aria-label={label}
      className={cn(styles.surface, className)}
      style={position ?? { position: 'fixed', visibility: 'hidden', width }}
      data-floating-layer=""
      {...dismissProps}
    >
      {children}
    </div>,
    document.body
  );
}
