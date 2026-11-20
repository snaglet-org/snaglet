import { useEffect, useMemo, useReducer, useRef, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import { FindBar } from './FindBar';
import { usePaneFindSession } from './PaneFindContext';
import {
  createDocumentFindPlugin,
  documentFindKey,
  findDocumentText,
  replaceDocumentMatches,
} from './documentFindPlugin';
import { scrollTextareaMatch } from './scrollTextareaMatch';
import { findText, replaceText } from './findText';

interface DocumentFindProps {
  editor: Editor | null;
  source: boolean;
  value: string;
  onChange: (value: string) => void;
  sourceRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}

export function DocumentFind({
  editor,
  source,
  value,
  onChange,
  sourceRef,
  disabled,
}: DocumentFindProps) {
  const session = usePaneFindSession();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const sourceUndo = useRef<{ before: string; after: string; undone: boolean } | null>(null);
  const activeEditor = !source && editor && !editor.isDestroyed ? editor : null;
  const doc = activeEditor?.state.doc;
  useEffect(() => {
    if (!activeEditor) return;
    activeEditor.registerPlugin(createDocumentFindPlugin());
    const onUpdate = () => refresh();
    activeEditor.on('update', onUpdate);
    return () => {
      activeEditor.off('update', onUpdate);
      if (!activeEditor.isDestroyed) activeEditor.unregisterPlugin(documentFindKey);
    };
  }, [activeEditor]);
  const matches = useMemo(
    () =>
      !session.open
        ? []
        : source
          ? findText(value, session.query, session.caseSensitive)
          : doc
            ? findDocumentText(doc, session.query, session.caseSensitive)
            : [],
    [session.open, session.query, session.caseSensitive, source, value, doc]
  );
  const current = matches[Math.min(session.index, matches.length - 1)];
  // Only a change to the search itself goes to the plugin; the decorations
  // already follow every document change.
  useEffect(() => {
    if (!activeEditor) return;
    activeEditor.view.dispatch(
      activeEditor.state.tr
        .setMeta(documentFindKey, {
          query: session.open ? session.query : '',
          caseSensitive: session.caseSensitive,
          index: session.index,
        })
        .setMeta('addToHistory', false)
    );
  }, [activeEditor, session.open, session.query, session.caseSensitive, session.index]);
  // Every edit re-finds, so `current` changes on each keystroke. While the
  // user types in the document, leave the view and the caret where they are:
  // only navigation from the bar (focus outside the document) moves to the match.
  useEffect(() => {
    if (!activeEditor || !current || activeEditor.view.hasFocus()) return;
    activeEditor.view.dom
      .querySelector('.snaglet-find-current')
      ?.scrollIntoView?.({ block: 'center' });
  }, [activeEditor, current]);
  useEffect(() => {
    const area = sourceRef.current;
    if (!source || !area || !current || document.activeElement === area) return;
    // Selection is retained while the query has focus; no caret/focus theft.
    area.setSelectionRange(current.from, current.to);
    scrollTextareaMatch(area, current.from);
  }, [source, sourceRef, current]);
  useEffect(() => {
    if (!source) {
      sourceUndo.current = null;
      return;
    }
    const area = sourceRef.current;
    if (!area) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const undo = sourceUndo.current;
      if (!undo) return;
      const redo = event.shiftKey;
      if (redo ? !undo.undone || value !== undo.before : undo.undone || value !== undo.after)
        return;
      event.preventDefault();
      onChange(redo ? undo.after : undo.before);
      undo.undone = !redo;
    };
    const onInput = () => {
      sourceUndo.current = null;
    };
    area.addEventListener('keydown', onKeyDown);
    area.addEventListener('input', onInput);
    return () => {
      area.removeEventListener('keydown', onKeyDown);
      area.removeEventListener('input', onInput);
    };
  }, [source, sourceRef, value, onChange]);
  return (
    <FindBar
      session={session}
      count={matches.length}
      label="Find in document"
      revision={source ? value : doc}
      onReplace={
        disabled
          ? undefined
          : (replacement, all) => {
              const selected = all ? matches : current ? [current] : [];
              if (source) {
                const next = replaceText(value, selected, replacement);
                sourceUndo.current = { before: value, after: next, undone: false };
                onChange(next);
              } else if (activeEditor) replaceDocumentMatches(activeEditor, selected, replacement);
              if (all) session.setIndex(0);
              else if (current) {
                const remaining = source
                  ? findText(
                      replaceText(value, selected, replacement),
                      session.query,
                      session.caseSensitive
                    )
                  : activeEditor
                    ? findDocumentText(activeEditor.state.doc, session.query, session.caseSensitive)
                    : [];
                const nextIndex = remaining.findIndex(
                  (match) => match.from >= current.from + replacement.length
                );
                session.setIndex(Math.max(0, nextIndex));
              }
            }
      }
    />
  );
}
