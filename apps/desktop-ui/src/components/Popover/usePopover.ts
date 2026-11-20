import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useDismissable } from './useDismissable';
import { useReturnFocus } from './useReturnFocus';

/**
 * usePopover — open state + refs + the full dismiss/focus contract + the ARIA
 * wiring, in one call.
 *
 * The point is that correct behavior becomes the default rather than something
 * each caller remembers to add. Spreading `triggerProps` and `surfaceProps`
 * yields a surface that closes on Escape, closes on outside press, keeps its
 * trigger from double-firing, restores focus, and announces itself to screen
 * readers — with no per-file event listeners.
 *
 * `useDisclosure` remains the right tool for a purely inline expand/collapse
 * that should not be dismissable (a permanently visible properties section).
 * Use this when the surface overlays or floats above other content.
 */
export interface UsePopoverOptions {
  /** Start open. Defaults to closed, matching useDisclosure's convention. */
  defaultOpen?: boolean;
  closeOnEscape?: boolean;
  closeOnOutsidePress?: boolean;
  keepOpenSelector?: string;
  /** Notified after each change, for analytics or parent-held state. */
  onOpenChange?: (open: boolean) => void;
}

export function usePopover(options: UsePopoverOptions = {}) {
  const {
    defaultOpen = false,
    closeOnEscape,
    closeOnOutsidePress,
    keepOpenSelector,
    onOpenChange,
  } = options;

  const [open, setOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const surfaceId = useId();

  // Notify from an effect, not inside the setState updater: updaters must be
  // pure because StrictMode runs them twice.
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const notified = useRef(open);
  useEffect(() => {
    if (notified.current === open) return;
    notified.current = open;
    change.current?.(open);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  const openSurface = useCallback(() => setOpen(true), []);
  const toggle = useCallback(() => setOpen((previous) => !previous), []);

  const dismissableProps = useDismissable({
    open,
    onDismiss: close,
    surfaceRef,
    triggerRef,
    closeOnEscape,
    closeOnOutsidePress,
    keepOpenSelector,
  });
  useReturnFocus(open, surfaceRef, triggerRef);

  return {
    open,
    setOpen,
    openSurface,
    close,
    toggle,
    triggerRef,
    surfaceRef,
    surfaceId,
    /** Spread onto the control that opens the surface. */
    triggerProps: {
      ref: triggerRef,
      type: 'button' as const,
      'aria-expanded': open,
      'aria-controls': open ? surfaceId : undefined,
      onClick: toggle,
    },
    /** Spread onto the surface element (or pass to <Popover />). */
    surfaceProps: {
      ref: surfaceRef,
      id: surfaceId,
      ...dismissableProps,
    },
  };
}
