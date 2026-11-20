// docOutline.ts — a doc's own headings for the Properties panel's Outline,
// which one is in view, and the store the editor and the panel share. The
// editor writes to the store and only the outline re-renders, so typing and
// scrolling never re-render the editor for it.

import { docOutline, type HeadingRef } from '@snaglet/shared/utils';

/** One heading in a doc's outline. */
export interface OutlineEntry {
  level: number;
  /** Heading text with inline markdown stripped. */
  text: string;
  /** 1-indexed source line. */
  line: number;
  /** The heading link a jump resolves; unique even when a name repeats. */
  ref: HeadingRef;
}

/**
 * The doc's own headings in document order. A transcluded doc is a single
 * `![…](doc-…)` line in this markdown, so its headings are never listed;
 * fenced code is skipped, and a heading with no text is left out.
 */
export function outlineEntries(markdown: string): OutlineEntry[] {
  return docOutline(markdown)
    .filter((h) => h.text.trim() !== '')
    .map(({ level, text, line, ref }) => ({ level, text, line, ref }));
}

function sameEntry(a: OutlineEntry, b: OutlineEntry): boolean {
  return (
    a.level === b.level &&
    a.text === b.text &&
    a.line === b.line &&
    a.ref.slug === b.ref.slug &&
    a.ref.level === b.ref.level
  );
}

/**
 * The heading in view: the last one whose top (px from the top of the visible
 * area) is at or above `offset`. Before the first heading gets there, the
 * first heading if it is on screen, else none (-1). Tops grow in document
 * order, so a binary search reads only a few of them in a long doc.
 */
export function activeHeadingIndex(
  count: number,
  topAt: (index: number) => number,
  offset: number,
  viewHeight: number
): number {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topAt(mid) <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0 && count > 0 && topAt(0) < viewHeight) return 0;
  return found;
}

interface DocOutlineState {
  entries: readonly OutlineEntry[];
  /** Index of the heading in view, or -1. */
  active: number;
}

export interface DocOutlineStore {
  getState: () => DocOutlineState;
  subscribe: (listener: () => void) => () => void;
  /** The editor's current headings; true when they changed. A change ends a hold. */
  setEntries: (entries: readonly OutlineEntry[]) => boolean;
  /** The heading in view, from scrolling. Ignored while a jump holds one. */
  setActive: (index: number) => void;
  /**
   * A jump from the outline: mark `index` as in view until `release`. A jump
   * near the end of a doc may not bring its heading to the top, so scrolling
   * alone would mark an earlier one.
   */
  hold: (index: number) => void;
  /** The reader scrolled the doc: scrolling decides again. */
  release: () => void;
  isHeld: () => boolean;
}

/** One store per doc view: its editor writes, its Outline reads. */
export function createDocOutlineStore(): DocOutlineStore {
  let state: DocOutlineState = { entries: [], active: -1 };
  let held = false;
  const listeners = new Set<() => void>();
  const update = (next: DocOutlineState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEntries: (entries) => {
      const prev = state.entries;
      if (prev.length === entries.length && prev.every((e, i) => sameEntry(e, entries[i]!))) {
        return false;
      }
      held = false;
      update({ entries, active: state.active < entries.length ? state.active : -1 });
      return true;
    },
    setActive: (index) => {
      if (held || index === state.active) return;
      update({ ...state, active: index });
    },
    hold: (index) => {
      held = true;
      if (index !== state.active) update({ ...state, active: index });
    },
    release: () => {
      held = false;
    },
    isHeld: () => held,
  };
}
