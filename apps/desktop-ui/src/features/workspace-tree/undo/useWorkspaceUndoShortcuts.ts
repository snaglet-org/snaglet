/**
 * Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z (redo) for workspace structural
 * edits. The sidebar tree and every ContainerView pane mount this hook, but
 * a module-level refcount keeps exactly one window listener alive — both
 * surfaces share the one undo history, so a keypress must replay once, not
 * once per mounted surface.
 *
 * The gesture never fights text editing: it stands down whenever the
 * keystroke targets (or focus sits in) an input, textarea, select, or
 * contenteditable — the doc editor, thread composer, rename inputs, and
 * search boxes all keep their native undo. When our stack is empty the
 * event falls through untouched. Same "act only when it's ours" discipline
 * as useTreeClipboard's Cmd+C/V listener.
 */

import { useEffect } from 'react';
import { canRedo, canUndo, redoLast, undoLast } from './workspaceUndo';

/** True when the keystroke is aimed at a text-editing surface — leave it alone. */
function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  // Attribute fallback: catches focus on a child of a contenteditable host
  // (rich-markdown leaf spans) and keeps the guard testable under jsdom,
  // which doesn't implement isContentEditable.
  return (
    target.closest(
      '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'
    ) !== null
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  if (e.key.toLowerCase() !== 'z') return;
  if (isTextEditingTarget(e.target) || isTextEditingTarget(document.activeElement)) return;
  if (e.shiftKey) {
    if (!canRedo()) return;
    e.preventDefault();
    void redoLast();
  } else {
    if (!canUndo()) return;
    e.preventDefault();
    void undoLast();
  }
}

let activeSurfaces = 0;

export function useWorkspaceUndoShortcuts(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    activeSurfaces += 1;
    if (activeSurfaces === 1) window.addEventListener('keydown', onKeyDown);
    return () => {
      activeSurfaces -= 1;
      if (activeSurfaces === 0) window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
