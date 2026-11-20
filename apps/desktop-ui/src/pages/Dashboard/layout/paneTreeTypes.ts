import type { DetailSelection } from '../selection/types';

/**
 * Node shapes for the Dashboard's pane-layout tree — the vocabulary every
 * paneTree module (repair, history, mutation, queries) builds on.
 *
 * Two node shapes:
 *   - `leaf`   — a single pane displaying one selection (or nothing).
 *   - `split`  — a horizontal or vertical container with N children.
 *
 * "Horizontal" splits arrange children side-by-side (left/right).
 * "Vertical" splits stack children top/bottom.
 *
 * The tree is fully functional / pure — every operation returns a new
 * tree, so React state updates compare cleanly and history could be
 * added later for undo. Sizes (`ratios`) sum to 100; the renderer
 * passes them straight through to react-resizable-panels.
 */

/**
 * Per-pane navigation history — a browser-style back/forward stack
 * scoped to a single leaf. Each non-null selection landed in the pane
 * gets pushed into `entries`; `index` points at the entry currently
 * being shown (so `entries[index] === selection` whenever entries
 * is non-empty).
 *
 * Back/forward navigate by decrementing / incrementing `index` without
 * mutating `entries`. A fresh `replaceLeafSelection` truncates any
 * forward history (matches every browser since Mosaic) and appends.
 *
 * Empty state: `entries: []`, `index: -1`. This is the only time
 * `index` can be < 0.
 */
export type PaneHistory = {
  entries: NonNullableSelection[];
  index: number;
};

export type NonNullableSelection = Exclude<DetailSelection, null>;

export type LayoutLeaf = {
  kind: 'leaf';
  id: string;
  selection: DetailSelection;
  history: PaneHistory;
};

export type SplitDirection = 'horizontal' | 'vertical';

export type LayoutSplit = {
  kind: 'split';
  id: string;
  direction: SplitDirection;
  /** Percentages summing to ~100, one per child. */
  ratios: number[];
  children: LayoutNode[];
};

export type LayoutNode = LayoutLeaf | LayoutSplit;
