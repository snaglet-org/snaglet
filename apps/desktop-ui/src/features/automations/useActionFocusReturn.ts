import { useCallback, useEffect, useRef } from 'react';

/**
 * Keeps keyboard focus on a group of action buttons when the one pressed is
 * replaced (Pause and Resume, Delete and Restore), instead of letting it fall
 * to the page. Call the returned `capture(group)` as an action starts; once
 * `busy` is false again (and `changeKey`, the record the buttons follow, has
 * re-rendered), focus goes back to the pressed button or, when it is gone,
 * to `fallback()`. Focus the person moved elsewhere meanwhile is left alone.
 */
export function useActionFocusReturn(
  busy: boolean,
  changeKey: unknown,
  fallback: () => HTMLElement | null | undefined
): (group: HTMLElement | null | undefined) => void {
  const pressed = useRef<HTMLElement | null>(null);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  useEffect(() => {
    const from = pressed.current;
    if (busy || !from) return;
    pressed.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== from) return;
    (from.isConnected ? from : fallbackRef.current())?.focus();
  }, [busy, changeKey]);

  return useCallback((group) => {
    const focused = document.activeElement;
    pressed.current = focused instanceof HTMLElement && group?.contains(focused) ? focused : null;
  }, []);
}
