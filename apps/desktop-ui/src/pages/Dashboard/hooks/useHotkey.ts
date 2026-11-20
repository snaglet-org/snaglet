import { useEffect, useRef } from 'react';

// useHotkey: bind one keyboard shortcut (key + modifiers, case-insensitive)
// to a handler. The handler is held in a ref, so inline arrows do not
// re-register the listener. `ignoreInEditable` defers to text fields (letter
// combos like Cmd+B); globals like Cmd+K fire everywhere. OS auto-repeat
// keydowns are swallowed unless the combo sets `allowRepeat` (zoom).

export interface HotkeyMatcher {
  /** Single key to match, case-insensitive (e.g. 'k', 'Escape'). */
  key: string;
  /** Require Cmd (mac) or Ctrl (others). */
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Skip when focus is inside an input, textarea, or contenteditable element. */
  ignoreInEditable?: boolean;
  /**
   * When false, the listener is not attached at all (default true). For
   * context-gated shortcuts — e.g. the zoom combos only exist in the desktop
   * shell, where merely matching (and preventDefault-ing) in a browser would
   * fight the native binding. Distinct from a no-op handler for that reason.
   */
  enabled?: boolean;
  /**
   * Fire the handler on OS auto-repeat keydowns too (default false: a held
   * key fires once). Opt in for steppers like zoom, where holding the combo
   * should keep going; leave off for toggles like the ⌘K palette.
   */
  allowRepeat?: boolean;
}

/** True for a text field, select or contenteditable surface that owns its own keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

export function useHotkey(matcher: HotkeyMatcher, handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const matcherRef = useRef(matcher);
  matcherRef.current = matcher;

  const enabled = matcher.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const m = matcherRef.current;
      if (e.key.toLowerCase() !== m.key.toLowerCase()) return;
      const wantMeta = !!m.meta;
      const hasMeta = e.metaKey || e.ctrlKey;
      if (wantMeta !== hasMeta) return;
      if (!!m.shift !== e.shiftKey) return;
      if (!!m.alt !== e.altKey) return;
      if (m.ignoreInEditable && isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.repeat && !m.allowRepeat) return;
      handlerRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
