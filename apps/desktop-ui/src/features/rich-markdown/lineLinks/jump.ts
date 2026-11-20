// jump.ts — an outline jump: bring a heading near the top of the doc and
// flash it, in the rendered editor or the markdown view. The caret and focus
// stay put, so the reader can keep moving through the outline.

import type { Editor } from '@tiptap/core';
import { elementPxScale } from '@desktop/utils/cssZoom';
import { scrollParent } from '@desktop/utils/scrollParent';
import { flashSourceLine, sourceLineTop } from '../workspace-editor/SourceMarkdownArea';
import { LINE_FLASH_MS, lineHighlightKey } from './lineHighlightPlugin';
import { rangeForLines } from './lineMap';

/** A jump leaves its heading this far below the top of the scroll area. */
export const JUMP_MARGIN = 16;

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function scrollAreaTo(area: HTMLElement, top: number): void {
  const target = Math.max(0, Math.round(top));
  if (typeof area.scrollTo === 'function')
    area.scrollTo({ top: target, behavior: scrollBehavior() });
  else area.scrollTop = target;
}

/** Rendered editor: scroll the block on source `line` near the top and flash it. */
export function jumpToLine(editor: Editor, markdown: string, line: number): void {
  const range = rangeForLines(editor.state.doc, markdown, { startLine: line, endLine: line });
  if (!range) return;
  editor.view.dispatch(
    editor.state.tr
      .setMeta(lineHighlightKey, { ...range, flash: true })
      .setMeta('addToHistory', false)
  );
  let block: HTMLElement | null = null;
  try {
    const $pos = editor.state.doc.resolve(range.from);
    const dom = editor.view.nodeDOM($pos.before($pos.depth));
    block = dom instanceof HTMLElement ? dom : null;
  } catch {
    // The doc changed under us: no block to scroll to.
  }
  if (!block) return;
  const scroller = scrollParent(block);
  if (!scroller) {
    block.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() });
    return;
  }
  // Rects are viewport px; a zoomed pane scrolls in its own px.
  const offset =
    (block.getBoundingClientRect().top - scroller.getBoundingClientRect().top) /
    elementPxScale(scroller);
  scrollAreaTo(scroller, scroller.scrollTop + offset - JUMP_MARGIN);
}

/** Markdown view: scroll source `line` near the top of the textarea and flash it. */
export function jumpToSourceLine(area: HTMLTextAreaElement, line: number): void {
  const top = sourceLineTop(area, line - 1);
  const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 20;
  scrollAreaTo(area, (top ?? (line - 1) * lineHeight) - JUMP_MARGIN);
  flashSourceLine(area, line - 1, LINE_FLASH_MS);
}
