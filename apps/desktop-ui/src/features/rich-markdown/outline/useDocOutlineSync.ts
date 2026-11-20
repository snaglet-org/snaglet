// useDocOutlineSync.ts — the doc editor's side of the Outline: publish the
// doc's own headings to the outline store (at once, then after typing
// pauses) and which one is in view as the reader scrolls.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { scrollParent } from '@desktop/utils/scrollParent';
import { headingBlockPositions } from '../lineLinks/lineMap';
import { sourceLineTop } from '../workspace-editor/SourceMarkdownArea';
import {
  activeHeadingIndex,
  outlineEntries,
  type DocOutlineStore,
  type OutlineEntry,
} from './docOutline';

/** Typing pauses this long before the outline follows. */
const OUTLINE_DEBOUNCE_MS = 250;
/** A heading is in view once its top is this close to the top of the doc's visible area. */
const SPY_OFFSET = 48;
/** Animation frames to wait for the rendered editor to load its content. */
const MAX_LOAD_TRIES = 30;
/** What the reader does to move the doc themselves. */
const READER_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
/** A scroll this soon after one of those is the reader's own. */
const READER_SCROLL_MS = 500;

interface TrackedHeadings {
  /** The editor doc they were found in; a new doc means find them again. */
  doc: PMNode;
  /** Rendered heading per outline entry (by index), in order. */
  list: Array<{ index: number; el: HTMLElement }>;
}

/**
 * The rendered heading for each outline entry. Found through the editor's own
 * blocks, so a transcluded doc's headings (drawn inside a chip) never count.
 */
function trackHeadings(
  editor: Editor,
  markdown: string,
  entries: readonly OutlineEntry[]
): TrackedHeadings {
  const positions = headingBlockPositions(editor.state.doc, markdown);
  const list: TrackedHeadings['list'] = [];
  entries.forEach((entry, index) => {
    const pos = positions.get(entry.line);
    const el = pos === undefined ? null : editor.view.nodeDOM(pos);
    if (el instanceof HTMLElement) list.push({ index, el });
  });
  return { doc: editor.state.doc, list };
}

export function useDocOutlineSync(
  editor: Editor | null,
  markdown: string,
  sourceMode: boolean,
  sourceRef: RefObject<HTMLTextAreaElement | null>,
  store: DocOutlineStore | undefined
): void {
  const markdownRef = useRef(markdown);
  useLayoutEffect(() => {
    markdownRef.current = markdown;
  });
  const tracked = useRef<TrackedHeadings | null>(null);
  // Schedules a scroll-spy pass while the view is wired.
  const refresh = useRef<() => void>(() => undefined);

  // Headings: at once on mount, then once typing pauses. Every pass also
  // re-checks the heading in view, since edits move headings without a scroll.
  const published = useRef(false);
  useEffect(() => {
    if (!store) return;
    const publish = () => {
      if (store.setEntries(outlineEntries(markdownRef.current))) tracked.current = null;
      refresh.current();
    };
    if (!published.current) {
      published.current = true;
      publish();
      return;
    }
    const timer = window.setTimeout(publish, OUTLINE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [markdown, store]);

  // The other view opens at the caret's place, not at a jump's heading.
  const viewedSource = useRef(sourceMode);
  useEffect(() => {
    if (viewedSource.current === sourceMode) return;
    viewedSource.current = sourceMode;
    store?.release();
  }, [sourceMode, store]);

  useEffect(() => {
    if (!store) return;
    tracked.current = null;
    const area = sourceMode ? sourceRef.current : null;
    const rich = !sourceMode && editor && !editor.isDestroyed ? editor : null;
    if (!area && !rich) return;

    let frame = 0;
    let loadTries = 0;
    const spySource = (ta: HTMLTextAreaElement) => {
      const { entries } = store.getState();
      return activeHeadingIndex(
        entries.length,
        (i) => (sourceLineTop(ta, entries[i]!.line - 1) ?? Infinity) - ta.scrollTop,
        SPY_OFFSET,
        ta.clientHeight
      );
    };
    const spyRich = (ed: Editor) => {
      const current = tracked.current;
      const fresh =
        current?.doc === ed.state.doc && current.list.every((t) => t.el.isConnected)
          ? current
          : (tracked.current = trackHeadings(ed, markdownRef.current, store.getState().entries));
      const { list } = fresh;
      const box = (scrollParent(ed.view.dom) ?? ed.view.dom).getBoundingClientRect();
      const k = activeHeadingIndex(
        list.length,
        (i) => list[i]!.el.getBoundingClientRect().top - box.top,
        SPY_OFFSET,
        box.height
      );
      return k < 0 ? -1 : list[k]!.index;
    };
    const spy = () => {
      frame = 0;
      if (area) {
        store.setActive(spySource(area));
        return;
      }
      if (!rich || rich.isDestroyed) return;
      if (rich.isEmpty && markdownRef.current.trim() !== '' && ++loadTries < MAX_LOAD_TRIES) {
        frame = requestAnimationFrame(spy);
        return;
      }
      store.setActive(spyRich(rich));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(spy);
    };
    refresh.current = schedule;

    const root = area ?? rich!.view.dom;
    let readerAt = -Infinity;
    const onReader = (event: Event) => {
      const scroller = area ?? scrollParent(root) ?? root;
      if (event.target instanceof Node && scroller.contains(event.target)) {
        readerAt = performance.now();
      }
    };
    // Scroll events don't bubble: catch any scroll that moves the doc. Only
    // a scroll the reader makes ends a jump's hold: not the jump's own, and
    // not a wheel at the end of the doc that moves nothing.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target !== document && !(target instanceof Node && target.contains(root))) return;
      if (store.isHeld() && performance.now() - readerAt < READER_SCROLL_MS) store.release();
      schedule();
    };
    document.addEventListener('scroll', onScroll, true);
    READER_EVENTS.forEach((type) =>
      document.addEventListener(type, onReader, { capture: true, passive: true })
    );
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      refresh.current = () => undefined;
      document.removeEventListener('scroll', onScroll, true);
      READER_EVENTS.forEach((type) => document.removeEventListener(type, onReader, true));
      window.removeEventListener('resize', schedule);
    };
  }, [editor, sourceMode, sourceRef, store]);
}
