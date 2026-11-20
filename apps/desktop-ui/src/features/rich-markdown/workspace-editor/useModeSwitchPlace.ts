// Keeps the user's place across the doc editor's rendered ↔ markdown switch:
// the selection maps to the same text, the caret gets focus, and the view
// scrolls so the caret sits where it was on screen.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { scrollParent } from '@desktop/utils/scrollParent';

import { richToSourceSelection, sourceToRichSelection } from './modeSwitchSelection';
import { sourceLineTop } from './SourceMarkdownArea';

/** Animation frames to wait for the rendered editor to load its content. */
const MAX_TRIES = 30;

interface RichPlace {
  doc: PMNode;
  from: number;
  to: number;
  /** The caret's distance from the top of the visible area, if known. */
  y: number | null;
}

interface SourcePlace {
  start: number;
  end: number;
  y: number | null;
}

function richCaretY(editor: Editor, pos: number): number | null {
  const scroller = scrollParent(editor.view.dom);
  if (!scroller) return null;
  try {
    return editor.view.coordsAtPos(pos).top - scroller.getBoundingClientRect().top;
  } catch {
    return null;
  }
}

const lineIndexAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length - 1;

export function useModeSwitchPlace(
  sourceMode: boolean,
  editor: Editor | null,
  sourceRef: RefObject<HTMLTextAreaElement | null>,
  markdown: string
): void {
  const richPlace = useRef<RichPlace | null>(null);
  const sourcePlace = useRef<SourcePlace | null>(null);
  const markdownRef = useRef(markdown);
  useLayoutEffect(() => {
    markdownRef.current = markdown;
  });

  // Rendered editor: follow the selection; measure the caret on blur (the
  // mode toggle is a button, so clicking it blurs the editor first).
  useEffect(() => {
    if (!editor || sourceMode) return;
    const remember = () => {
      if (editor.isDestroyed) return;
      const { from, to } = editor.state.selection;
      richPlace.current = { doc: editor.state.doc, from, to, y: richPlace.current?.y ?? null };
    };
    const measure = () => {
      remember();
      if (richPlace.current) richPlace.current.y = richCaretY(editor, richPlace.current.from);
    };
    editor.on('transaction', remember);
    editor.on('blur', measure);
    return () => {
      editor.off('transaction', remember);
      editor.off('blur', measure);
    };
  }, [editor, sourceMode]);

  // Markdown textarea: the same.
  useEffect(() => {
    const area = sourceRef.current;
    if (!sourceMode || !area) return;
    const remember = () => {
      sourcePlace.current = {
        start: area.selectionStart,
        end: area.selectionEnd,
        y: sourcePlace.current?.y ?? null,
      };
    };
    const measure = () => {
      remember();
      const top = sourceLineTop(area, lineIndexAt(area.value, area.selectionStart));
      if (sourcePlace.current) sourcePlace.current.y = top === null ? null : top - area.scrollTop;
    };
    const events = ['select', 'keyup', 'mouseup', 'input'] as const;
    events.forEach((name) => area.addEventListener(name, remember));
    area.addEventListener('blur', measure);
    return () => {
      events.forEach((name) => area.removeEventListener(name, remember));
      area.removeEventListener('blur', measure);
    };
  }, [sourceMode, sourceRef]);

  // Into markdown: select the same text and scroll it to the same height.
  useLayoutEffect(() => {
    const place = richPlace.current;
    const area = sourceRef.current;
    if (!sourceMode || !place || !area) return;
    const text = markdownRef.current;
    const offsets = richToSourceSelection(place.doc, text, place.from, place.to);
    if (!offsets) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(offsets[0], offsets[1]);
    const top = sourceLineTop(area, lineIndexAt(text, offsets[0]));
    const y = place.y ?? area.clientHeight / 3;
    if (top !== null) area.scrollTop = Math.max(0, top - y);
    sourcePlace.current = { start: offsets[0], end: offsets[1], y };
  }, [sourceMode, sourceRef]);

  // Into the rendered editor: once it has loaded the text, the same.
  useEffect(() => {
    const place = sourcePlace.current;
    if (sourceMode || !editor || !place) return;
    let tries = 0;
    let frame = 0;
    let canceled = false;
    const attempt = () => {
      if (canceled || editor.isDestroyed) return;
      const text = markdownRef.current;
      if (editor.isEmpty && text.trim() !== '') {
        if (++tries < MAX_TRIES) frame = requestAnimationFrame(attempt);
        return;
      }
      sourcePlace.current = null;
      const range = sourceToRichSelection(editor.state.doc, text, place.start, place.end);
      if (!range) return;
      const { doc } = editor.state;
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(doc, range.from, range.to))
      );
      editor.view.focus();
      const scroller = scrollParent(editor.view.dom);
      const y = richCaretY(editor, range.from);
      if (scroller && y !== null) {
        scroller.scrollTop += y - (place.y ?? scroller.clientHeight / 3);
      } else {
        editor.commands.scrollIntoView();
      }
    };
    frame = requestAnimationFrame(attempt);
    return () => {
      canceled = true;
      cancelAnimationFrame(frame);
    };
  }, [editor, sourceMode]);
}
