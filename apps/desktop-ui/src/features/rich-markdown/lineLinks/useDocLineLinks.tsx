import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import {
  headingRangeForLines,
  headingRefFor,
  resolveDocAnchor,
  type DocAnchor,
  type LineRef,
} from '@snaglet/shared/utils';
import { hasOpenLinkModifier } from '@desktop/utils/externalLinks';
import { showToast } from '@desktop/utils/toast';
import { createInDocLinkPlugin, inDocLinkAt, inDocLinkKey, type InDocLink } from './inDocLinks';
import { lineHighlightKey, createLineHighlightPlugin } from './lineHighlightPlugin';
import {
  headingLineAtPos,
  linesForSelection,
  linesForSourceSelection,
  rangeForLines,
  sourceOffsetsForLines,
} from './lineMap';
import { CopyLineLinkButton, type SelectionAnchor } from './CopyLineLinkButton';
import { jumpToLine, jumpToSourceLine } from './jump';

export interface DocLineLinkOptions {
  docId: string;
  docTitle: string;
  /**
   * Lines to scroll to and highlight once the doc is loaded. A `jump` (from
   * the outline) instead lands the anchor's first line near the top and
   * flashes it, leaving the caret and focus alone.
   */
  focus?: { anchor: DocAnchor; nonce: number; jump?: boolean } | null;
  /** Called after `focus` was applied (or found to be past the doc's end). */
  onFocusApplied?: (nonce: number) => void;
}

const MAX_FOCUS_TRIES = 30;

function scrollToPos(editor: Editor, pos: number): void {
  try {
    const { node } = editor.view.domAtPos(pos);
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  } catch {
    // Position outside the rendered doc (it changed under us): skip the scroll.
  }
}

/**
 * Doc line links inside the doc editor:
 *   - `focus` scrolls to and highlights the linked lines (rich and source mode);
 *   - a link to one of the doc's own headings (`[Q4](#h=q4)`) jumps there in
 *     this pane: on a click in the rendered view, a ⌘-click in the markdown;
 *   - a text selection shows a floating link button that copies a line link.
 * Returns the floating button (or null) for the caller to render.
 */
export function useDocLineLinks(
  editor: Editor | null,
  markdown: string,
  sourceMode: boolean,
  sourceRef: RefObject<HTMLTextAreaElement | null>,
  options: DocLineLinkOptions | undefined
): ReactNode {
  const [selection, setSelection] = useState<{ anchor: SelectionAnchor; lines: LineRef } | null>(
    null
  );
  const enabled = options !== undefined;
  const docId = options?.docId ?? null;
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;

  // An in-doc heading link lands its heading near the top and flashes it, as
  // an outline jump does. One that names no heading moves nothing.
  const followRef = useRef<(link: InDocLink) => void>(() => undefined);
  followRef.current = (link: InDocLink) => {
    const current = markdownRef.current;
    const found = resolveDocAnchor(current, { heading: link.ref });
    if (!found.lines) {
      showToast(`No heading "${link.href}" in this doc; it may have been renamed or removed.`, {
        durationMs: 4000,
      });
      return;
    }
    if (found.note) showToast(found.note, { durationMs: 4000 });
    if (sourceMode) {
      const area = sourceRef.current;
      if (area) jumpToSourceLine(area, found.lines.startLine);
    } else if (editor && !editor.isDestroyed) {
      jumpToLine(editor, current, found.lines.startLine);
    }
  };

  // Highlight and in-doc link plugins live as long as the editor.
  useEffect(() => {
    if (!enabled || !editor || editor.isDestroyed) return;
    editor.registerPlugin(createLineHighlightPlugin());
    editor.registerPlugin(createInDocLinkPlugin((link) => followRef.current(link)));
    return () => {
      if (editor.isDestroyed) return;
      editor.unregisterPlugin(inDocLinkKey);
      editor.unregisterPlugin(lineHighlightKey);
    };
  }, [editor, enabled]);

  // Markdown view: a plain click places the caret, so ⌘-click (Ctrl-click off
  // macOS) follows the in-doc link the caret lands in.
  useEffect(() => {
    const area = sourceRef.current;
    if (!docId || !sourceMode || !area) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || !hasOpenLinkModifier(event)) return;
      const link = inDocLinkAt(area.value, area.selectionStart, docId);
      if (!link) return;
      event.preventDefault();
      followRef.current(link);
    };
    area.addEventListener('click', onClick);
    return () => area.removeEventListener('click', onClick);
  }, [docId, sourceMode, sourceRef]);

  // Scroll to + highlight the requested lines once the content is in.
  const focus = options?.focus ?? null;
  const onFocusApplied = options?.onFocusApplied;
  useEffect(() => {
    if (!focus) return;
    let canceled = false;
    let tries = 0;
    let frame = 0;
    // Heading links are found by name in the current markdown; a level
    // change or a missing heading is said out loud instead of guessed at.
    const resolveFocus = (): LineRef | null => {
      const r = resolveDocAnchor(markdown, focus.anchor);
      if (r.note) showToast(r.note, { durationMs: 4000 });
      return r.lines;
    };
    const attempt = () => {
      if (canceled) return;
      if (sourceMode) {
        const ta = sourceRef.current;
        if (!ta && ++tries < MAX_FOCUS_TRIES) {
          frame = requestAnimationFrame(attempt);
          return;
        }
        const lines = resolveFocus();
        if (focus.jump) {
          if (ta && lines) jumpToSourceLine(ta, lines.startLine);
          onFocusApplied?.(focus.nonce);
          return;
        }
        const offsets = lines ? sourceOffsetsForLines(markdown, lines) : null;
        if (ta && lines && offsets) {
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(offsets[0], offsets[1]);
          const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
          ta.scrollTop = Math.max(0, (lines.startLine - 3) * lineHeight);
        }
        onFocusApplied?.(focus.nonce);
        return;
      }
      const loaded = editor && !editor.isDestroyed && (markdown.trim() === '' || !editor.isEmpty);
      if (!loaded) {
        if (++tries < MAX_FOCUS_TRIES) frame = requestAnimationFrame(attempt);
        return;
      }
      const lines = resolveFocus();
      if (focus.jump) {
        if (lines) jumpToLine(editor, markdown, lines.startLine);
        onFocusApplied?.(focus.nonce);
        return;
      }
      const range = lines ? rangeForLines(editor.state.doc, markdown, lines) : null;
      if (range) {
        editor.view.dispatch(
          editor.state.tr.setMeta(lineHighlightKey, range).setMeta('addToHistory', false)
        );
        scrollToPos(editor, range.from);
      }
      onFocusApplied?.(focus.nonce);
    };
    frame = requestAnimationFrame(attempt);
    return () => {
      canceled = true;
      cancelAnimationFrame(frame);
    };
    // `markdown` is read when the attempt runs; re-running on every keystroke
    // would re-highlight while the user types.
  }, [focus?.nonce, editor, sourceMode]);

  // Rich editor selection → floating copy-link button.
  const updateFromEditor = useCallback(() => {
    if (!editor || editor.isDestroyed) return setSelection(null);
    const { from, to, empty } = editor.state.selection;
    if (empty || !editor.isFocused) return setSelection(null);
    const lines = linesForSelection(editor.state.doc, markdown, from, to);
    if (!lines) return setSelection(null);
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    const sameLine = Math.abs(start.top - end.top) < 4;
    setSelection({
      anchor: {
        top: Math.min(start.top, end.top),
        left: start.left,
        right: sameLine ? end.right : start.left + 1,
      },
      lines,
    });
  }, [editor, markdown]);

  useEffect(() => {
    if (!enabled || sourceMode || !editor || editor.isDestroyed) return;
    let mouseDown = false;
    const onSelection = () => {
      if (!mouseDown) updateFromEditor();
    };
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('[data-testid="copy-line-link"]')) return;
      mouseDown = true;
      setSelection(null);
    };
    const onUp = () => {
      if (!mouseDown) return;
      mouseDown = false;
      // Let ProseMirror settle the selection first.
      requestAnimationFrame(updateFromEditor);
    };
    const onBlur = () => setSelection(null);
    const onScroll = () => setSelection((s) => (s ? null : s));
    editor.on('selectionUpdate', onSelection);
    editor.on('blur', onBlur);
    editor.view.dom.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      editor.off('selectionUpdate', onSelection);
      editor.off('blur', onBlur);
      editor.view.dom.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [editor, enabled, sourceMode, updateFromEditor]);

  // Source (raw markdown) mode: exact offsets → exact line/char link.
  useEffect(() => {
    const ta = sourceRef.current;
    if (!enabled || !sourceMode || !ta) return;
    let lastMouse: { x: number; y: number } | null = null;
    const update = () => {
      const { selectionStart, selectionEnd } = ta;
      const lines = linesForSourceSelection(ta.value, selectionStart, selectionEnd);
      if (!lines || document.activeElement !== ta) return setSelection(null);
      const box = ta.getBoundingClientRect();
      const x = lastMouse?.x ?? box.left + 24;
      const y = lastMouse?.y ?? box.top + 8;
      setSelection({ anchor: { top: y - 12, left: x, right: x }, lines });
    };
    const onUp = (e: MouseEvent) => {
      lastMouse = { x: e.clientX, y: e.clientY };
      requestAnimationFrame(update);
    };
    const onKey = () => {
      lastMouse = null;
      update();
    };
    const onBlur = () => setSelection(null);
    ta.addEventListener('mouseup', onUp);
    ta.addEventListener('keyup', onKey);
    ta.addEventListener('blur', onBlur);
    return () => {
      ta.removeEventListener('mouseup', onUp);
      ta.removeEventListener('keyup', onKey);
      ta.removeEventListener('blur', onBlur);
    };
  }, [enabled, sourceMode, sourceRef]);

  useEffect(() => setSelection(null), [sourceMode]);

  // Hovering a heading (rich mode) shows a link icon in the gutter that
  // copies `doc-…#h=slug`: a section link that survives edits above it.
  const [hovered, setHovered] = useState<{
    anchor: SelectionAnchor;
    target: DocAnchor;
    text: string;
  } | null>(null);
  const overButton = useRef(false);
  useEffect(() => {
    if (!enabled || sourceMode || !editor || editor.isDestroyed) return;
    const dom = editor.view.dom;
    let hideTimer: number | null = null;
    const clearHide = () => {
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = null;
    };
    const hideSoon = () => {
      clearHide();
      hideTimer = window.setTimeout(() => {
        if (!overButton.current) setHovered(null);
      }, 250);
    };
    const onMove = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('h1, h2, h3, h4, h5, h6');
      if (!el || !dom.contains(el)) return hideSoon();
      clearHide();
      let pos: number;
      try {
        pos = editor.view.posAtDOM(el, 0);
      } catch {
        return;
      }
      const line = headingLineAtPos(editor.state.doc, markdownRef.current, pos);
      const ref = line ? headingRefFor(markdownRef.current, line) : null;
      if (!ref) return hideSoon();
      const box = el.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || box.height;
      setHovered((prev) => {
        const target: DocAnchor = { heading: ref };
        const top = box.top + Math.min(box.height, lineHeight) / 2 - 14;
        if (
          prev &&
          'heading' in prev.target &&
          prev.target.heading.slug === ref.slug &&
          prev.target.heading.level === ref.level &&
          Math.abs(prev.anchor.top - top) < 1
        ) {
          return prev;
        }
        return {
          anchor: { top, left: box.left, right: box.left },
          target,
          text: el.textContent ?? '',
        };
      });
    };
    const onScroll = () => setHovered(null);
    dom.addEventListener('mousemove', onMove);
    dom.addEventListener('mouseleave', hideSoon);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      clearHide();
      dom.removeEventListener('mousemove', onMove);
      dom.removeEventListener('mouseleave', hideSoon);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [editor, enabled, sourceMode]);
  useEffect(() => setHovered(null), [sourceMode]);

  if (!options) return null;
  if (selection) {
    return (
      <CopyLineLinkButton
        anchor={selection.anchor}
        docId={options.docId}
        docTitle={options.docTitle}
        {...selectionTarget(markdown, selection.lines)}
      />
    );
  }
  if (hovered) {
    return (
      <CopyLineLinkButton
        key={'heading' in hovered.target ? hovered.target.heading.slug : 'h'}
        anchor={hovered.anchor}
        docId={options.docId}
        docTitle={options.docTitle}
        target={hovered.target}
        headingText={hovered.text}
        placement="left"
        onMouseEnter={() => {
          overButton.current = true;
        }}
        onMouseLeave={() => {
          overButton.current = false;
          setHovered(null);
        }}
      />
    );
  }
  return null;
}

/** A selection from a heading across 2+ headings copies a heading range. */
function selectionTarget(
  markdown: string,
  lines: LineRef
): { target: DocAnchor; headingText?: string } {
  const range = headingRangeForLines(markdown, lines);
  return range
    ? { target: { heading: range.ref }, headingText: range.text }
    : { target: { lines } };
}
