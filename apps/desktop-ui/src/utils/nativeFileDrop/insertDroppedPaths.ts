// Turn dropped absolute path(s) into ProseMirror content at an arbitrary
// document position — including mid-paragraph, which a naive `tr.insert`
// can't do for multi-line content (a `paragraph` node isn't valid content
// *inside* another paragraph's inline run). `pastedTextToSlice` already
// solves exactly this for real clipboard pastes — each `\n`-separated
// line becomes its own paragraph, wrapped in a `Slice.maxOpen` so
// ProseMirror splits/merges the surrounding paragraph correctly. Reusing
// it here means a multi-file drop behaves exactly like pasting the same
// `\n`-joined text would.
import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { pastedTextToSlice } from '@desktop/features/rich-markdown/editor/richMarkdown';

/**
 * Insert `pathsText` (already `\n`-joined by the caller — one line per
 * dropped file/folder) at `pos`, splitting the surrounding paragraph as
 * needed. No-ops if the editor was destroyed between the drop firing and
 * this running (surface unmounted mid-drop) or if there's nothing to
 * insert.
 */
export function insertDroppedPathsAtPos(editor: Editor, pathsText: string, pos: number): void {
  if (editor.isDestroyed || !pathsText) return;
  const { state } = editor;
  const clamped = Math.max(0, Math.min(pos, state.doc.content.size));
  const $pos = state.doc.resolve(clamped);
  const slice = pastedTextToSlice(pathsText, state.schema, true);
  const tr = state.tr.setSelection(TextSelection.near($pos)).replaceSelection(slice);
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}
