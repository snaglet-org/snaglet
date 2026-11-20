/**
 * Structural pane-tree mutations: leaf/split creation (and the id counter
 * behind pane keys), split/close/resize operations, and the shared leaf
 * traversal (`mapLeaves`) they and the history operations are built on.
 */

import type { DetailSelection } from '../selection/types';
import type {
  LayoutLeaf,
  LayoutNode,
  LayoutSplit,
  PaneHistory,
  SplitDirection,
} from './paneTreeTypes';
import {
  evenPaneRatios,
  ratiosMatchAtPanelPrecision,
  repairPaneLayout,
  reportPaneLayoutRepairs,
  roundPaneRatiosToTotal,
} from './paneLayoutRepair';

/** Edge of a leaf where a drop creates a split. Center replaces content. */
export type DropZone = 'top' | 'bottom' | 'left' | 'right' | 'center';
type SplitZone = Exclude<DropZone, 'center'>;

interface SplitLeafResult {
  layout: LayoutNode;
  /** The leaf created by this operation, or null when the target was absent. */
  insertedLeafId: string | null;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}-${Date.now().toString(36)}`;
}

export function createLeaf(selection: DetailSelection = null): LayoutLeaf {
  const history: PaneHistory = selection
    ? { entries: [selection], index: 0 }
    : { entries: [], index: -1 };
  return { kind: 'leaf', id: nextId('leaf'), selection, history };
}

function createSplit(
  direction: SplitDirection,
  children: LayoutNode[],
  ratios?: number[]
): LayoutSplit {
  const rs = ratios ?? children.map(() => 100 / children.length);
  const split: LayoutSplit = {
    kind: 'split',
    id: nextId('split'),
    direction,
    ratios: rs,
    children,
  };
  return repairPaneLayout(split).layout as LayoutSplit;
}

/**
 * Recursively map a transform over leaves. Returns a new tree if any
 * leaf changes; otherwise returns the input (referential equality lets
 * React skip re-renders for untouched subtrees).
 */
export function mapLeaves(
  node: LayoutNode,
  fn: (leaf: LayoutLeaf) => LayoutNode | null
): LayoutNode | null {
  if (node.kind === 'leaf') return fn(node);
  let changed = false;
  const nextChildren: LayoutNode[] = [];
  const nextRatios: number[] = [];
  for (let i = 0; i < node.children.length; i += 1) {
    const out = mapLeaves(node.children[i], fn);
    if (out === null) {
      changed = true;
      continue;
    }
    if (out !== node.children[i]) changed = true;
    nextChildren.push(out);
    nextRatios.push(node.ratios[i]);
  }
  if (!changed) return node;
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0]; // collapse degenerate split
  // Rebalance ratios so they sum to 100.
  const total = nextRatios.reduce((a, b) => a + b, 0);
  const rebalanced = roundPaneRatiosToTotal(
    nextRatios.map((r) => (total > 0 ? (r / total) * 100 : 100 / nextRatios.length))
  );
  return {
    ...node,
    children: nextChildren,
    ratios: rebalanced,
  };
}

/**
 * Split a leaf into a 2-child split, placing the new selection on the
 * side indicated by `zone`. The original leaf keeps its content; the
 * new leaf shows `selection`.
 *
 * Zone → direction mapping:
 *   top/bottom → vertical split
 *   left/right → horizontal split
 *   center     → no split; caller should use `replaceLeafSelection`.
 *
 * If the target is already a direct child of a split with the same direction,
 * insert the new pane beside it and rebalance the entire sibling cohort. A
 * different-direction drop intentionally creates a nested split.
 */
export function splitLeafWithResult(
  tree: LayoutNode,
  leafId: string,
  zone: SplitZone,
  selection: DetailSelection,
  options: { newPaneRatio?: number } = {}
): SplitLeafResult {
  const direction: SplitDirection = zone === 'top' || zone === 'bottom' ? 'vertical' : 'horizontal';
  const newPaneRatio = clampRatio(options.newPaneRatio ?? 0.5);
  const oldPaneRatio = 1 - newPaneRatio;
  const targetGoesFirst = zone === 'bottom' || zone === 'right';
  let insertedLeafId: string | null = null;

  const createInsertedLeaf = (): LayoutLeaf => {
    const leaf = createLeaf(selection);
    insertedLeafId = leaf.id;
    return leaf;
  };

  const insert = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') {
      if (node.id !== leafId) return node;
      const newLeaf = createInsertedLeaf();
      const children: LayoutNode[] = targetGoesFirst ? [node, newLeaf] : [newLeaf, node];
      const ratios = targetGoesFirst
        ? [oldPaneRatio * 100, newPaneRatio * 100]
        : [newPaneRatio * 100, oldPaneRatio * 100];
      return createSplit(direction, children, ratios);
    }

    const directIndex = node.children.findIndex(
      (child) => child.kind === 'leaf' && child.id === leafId
    );
    if (directIndex >= 0 && node.direction === direction) {
      const nextChildren = node.children.slice();
      const insertAt = targetGoesFirst ? directIndex + 1 : directIndex;
      nextChildren.splice(insertAt, 0, createInsertedLeaf());
      return { ...node, children: nextChildren, ratios: evenPaneRatios(nextChildren.length) };
    }

    let changed = false;
    const nextChildren = node.children.map((child) => {
      const nextChild = insert(child);
      if (nextChild !== child) changed = true;
      return nextChild;
    });
    return changed ? { ...node, children: nextChildren } : node;
  };

  const repaired = repairPaneLayout(insert(tree));
  reportPaneLayoutRepairs('split', repaired.repairs);
  return { layout: repaired.layout, insertedLeafId };
}

/** `splitLeafWithResult` without the inserted id, for callers that do not own activation. */
export function splitLeaf(
  tree: LayoutNode,
  leafId: string,
  zone: SplitZone,
  selection: DetailSelection,
  options: { newPaneRatio?: number } = {}
): LayoutNode {
  return splitLeafWithResult(tree, leafId, zone, selection, options).layout;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(0.85, Math.max(0.15, value));
}

/**
 * Remove a leaf from the tree. If removal collapses a 2-child split
 * to a 1-child, mapLeaves automatically lifts the surviving child.
 * Returns the input if leafId isn't found, or a single empty leaf if
 * the entire tree would be removed.
 */
export function closeLeaf(tree: LayoutNode, leafId: string): LayoutNode {
  const next = mapLeaves(tree, (leaf) => (leaf.id === leafId ? null : leaf));
  const repaired = repairPaneLayout(next ?? createLeaf(null));
  reportPaneLayoutRepairs('close', repaired.repairs);
  return repaired.layout;
}

/**
 * Update the ratios of a single split node — used after the user drags
 * a resize handle. The renderer reports the full ratio set back to us
 * so we can persist it through future tree mutations.
 */
export function updateSplitRatios(tree: LayoutNode, splitId: string, ratios: number[]): LayoutNode {
  const update = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') return node;
    if (node.id === splitId) {
      return ratiosMatchAtPanelPrecision(node.ratios, ratios) ? node : { ...node, ratios };
    }
    let changed = false;
    const nextChildren = node.children.map((child) => {
      const nextChild = update(child);
      if (nextChild !== child) changed = true;
      return nextChild;
    });
    return changed ? { ...node, children: nextChildren } : node;
  };
  const repaired = repairPaneLayout(update(tree));
  reportPaneLayoutRepairs('resize', repaired.repairs);
  return repaired.layout;
}
