import { useEffect, useRef, type RefObject } from 'react';

/**
 * Return focus to whatever was focused before the surface opened.
 *
 * Dismissing with Escape while focus sits inside a surface that then unmounts
 * drops focus to `document.body`, which strands keyboard users mid-pane. This
 * records the previously focused element on open and restores it on close.
 *
 * WKWebView (Safari) does not focus a clicked button, so the recorded element
 * is often `body`; when it is, or when it has since left the document, focus
 * goes to the trigger instead.
 *
 * Only restores when focus is still inside the surface (or already lost), so a
 * dismissal caused by deliberately clicking some other control does not yank
 * focus back out of where the user just went.
 */
export function useReturnFocus(
  open: boolean,
  surfaceRef: RefObject<HTMLElement | null>,
  triggerRef?: RefObject<HTMLElement | null>
) {
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    previous.current = active instanceof HTMLElement ? active : null;

    return () => {
      const recorded = previous.current;
      previous.current = null;
      const restoreTo =
        recorded !== null && recorded !== document.body && recorded.isConnected
          ? recorded
          : triggerRef?.current;
      if (!restoreTo?.isConnected) return;
      const current = document.activeElement;
      const focusEscaped =
        current === null ||
        current === document.body ||
        (surfaceRef.current?.contains(current) ?? false);
      if (focusEscaped) restoreTo.focus();
    };
  }, [open, surfaceRef, triggerRef]);
}
