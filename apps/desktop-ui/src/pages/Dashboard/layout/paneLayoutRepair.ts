/**
 * Pane-layout invariant enforcement: ratio math (rounding, minimums,
 * even shares) and the canonical repair pass every mutation runs its
 * result through before handing a tree back to React.
 */

import type { LayoutLeaf, LayoutNode } from './paneTreeTypes';

/** react-resizable-panels rounds percentage layouts to three decimals. */
export const PANE_RATIO_PRECISION = 3;
/** Practical minimum used by both the data invariant and <Panel minSize>. */
export const PANE_MIN_RATIO = 10;

interface PaneLayoutRepair {
  splitId: string;
  childIds: string[];
  previousRatios: number[];
  nextRatios: number[];
  reason:
    | 'empty-split'
    | 'invalid-child'
    | 'one-child'
    | 'ratio-count'
    | 'non-finite'
    | 'non-positive'
    | 'total'
    | 'minimum'
    | 'minimum-impossible';
}

interface PaneLayoutRepairResult {
  layout: LayoutNode;
  repairs: PaneLayoutRepair[];
}

const PANEL_TOTAL = 100;
const PANEL_PRECISION_FACTOR = 10 ** PANE_RATIO_PRECISION;

function roundPanelRatio(value: number): number {
  return Math.round(value * PANEL_PRECISION_FACTOR) / PANEL_PRECISION_FACTOR;
}

export function evenPaneRatios(count: number): number[] {
  if (count <= 0) return [];
  const share = PANEL_TOTAL / count;
  return roundPaneRatiosToTotal(Array.from({ length: count }, () => share));
}

export function roundPaneRatiosToTotal(ratios: number[]): number[] {
  if (ratios.length === 0) return [];
  const rounded = ratios.map(roundPanelRatio);
  const roundedTotal = rounded.reduce((sum, ratio) => sum + ratio, 0);
  const remainder = roundPanelRatio(PANEL_TOTAL - roundedTotal);
  if (remainder !== 0) {
    let largestIndex = 0;
    for (let index = 1; index < ratios.length; index += 1) {
      if (ratios[index] > ratios[largestIndex]) largestIndex = index;
    }
    rounded[largestIndex] = roundPanelRatio(rounded[largestIndex] + remainder);
  }
  return rounded;
}

export function ratiosMatchAtPanelPrecision(left: number[], right: number[]): boolean {
  return (
    left.length === right.length &&
    left.every((ratio, index) => roundPanelRatio(ratio) === roundPanelRatio(right[index]))
  );
}

function repairReason(ratios: number[], childCount: number): PaneLayoutRepair['reason'] {
  if (childCount === 1) return 'one-child';
  if (ratios.length !== childCount) return 'ratio-count';
  if (ratios.some((ratio) => !Number.isFinite(ratio))) return 'non-finite';
  if (ratios.some((ratio) => ratio <= 0)) return 'non-positive';
  if (roundPanelRatio(ratios.reduce((sum, ratio) => sum + ratio, 0)) !== PANEL_TOTAL) {
    return 'total';
  }
  if (childCount * PANE_MIN_RATIO > PANEL_TOTAL) return 'minimum-impossible';
  return 'minimum';
}

function ratiosAreValid(ratios: number[], childCount: number): boolean {
  if (ratios.length !== childCount) return false;
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) return false;
  if (childCount === 1) return ratios[0] === PANEL_TOTAL;
  if (roundPanelRatio(ratios.reduce((sum, ratio) => sum + ratio, 0)) !== PANEL_TOTAL) {
    return false;
  }
  if (childCount * PANE_MIN_RATIO > PANEL_TOTAL) {
    return ratiosMatchAtPanelPrecision(ratios, evenPaneRatios(childCount));
  }
  return ratios.every((ratio) => roundPanelRatio(ratio) >= PANE_MIN_RATIO);
}

function ratiosWithPracticalMinimum(ratios: number[]): number[] {
  const childCount = ratios.length;
  if (childCount === 1) return [PANEL_TOTAL];
  if (childCount * PANE_MIN_RATIO > PANEL_TOTAL) return evenPaneRatios(childCount);

  const total = ratios.reduce((sum, ratio) => sum + ratio, 0);
  const weights = ratios.map((ratio) => (ratio / total) * PANEL_TOTAL);
  const next = Array.from({ length: childCount }, () => 0);
  const remaining = new Set(weights.map((_, index) => index));

  while (remaining.size > 0) {
    const fixedTotal = next.reduce((sum, ratio) => sum + ratio, 0);
    const available = PANEL_TOTAL - fixedTotal;
    const remainingWeight = [...remaining].reduce((sum, index) => sum + weights[index], 0);
    const belowMinimum = [...remaining].filter((index) => {
      const share =
        remainingWeight > 0
          ? (weights[index] / remainingWeight) * available
          : available / remaining.size;
      return share < PANE_MIN_RATIO;
    });

    if (belowMinimum.length === 0) {
      for (const index of remaining) {
        next[index] =
          remainingWeight > 0
            ? (weights[index] / remainingWeight) * available
            : available / remaining.size;
      }
      break;
    }

    for (const index of belowMinimum) {
      next[index] = PANE_MIN_RATIO;
      remaining.delete(index);
    }
  }

  return roundPaneRatiosToTotal(next);
}

function normalizedPaneRatios(ratios: number[], childCount: number): number[] {
  if (ratiosAreValid(ratios, childCount)) return ratios;
  if (childCount === 1) return [PANEL_TOTAL];
  if (
    ratios.length !== childCount ||
    ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)
  ) {
    return evenPaneRatios(childCount);
  }
  return ratiosWithPracticalMinimum(ratios);
}

function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'leaf' || kind === 'split';
}

function repairPaneLayoutNode(node: LayoutNode, repairs: PaneLayoutRepair[]): LayoutNode {
  if (node.kind === 'leaf') return node;

  const rawChildren = Array.isArray(node.children) ? node.children : [];
  const validChildren = rawChildren.filter(isLayoutNode);
  if (validChildren.length === 0) {
    const recoveredLeaf: LayoutLeaf = {
      kind: 'leaf',
      id: `leaf-recovered-${node.id}`,
      selection: null,
      history: { entries: [], index: -1 },
    };
    repairs.push({
      splitId: node.id,
      childIds: [recoveredLeaf.id],
      previousRatios: Array.isArray(node.ratios) ? node.ratios.slice() : [],
      nextRatios: [PANEL_TOTAL],
      reason: 'empty-split',
    });
    return recoveredLeaf;
  }

  const nextChildren = validChildren.map((child) => repairPaneLayoutNode(child, repairs));
  const childrenChanged =
    validChildren.length !== rawChildren.length ||
    nextChildren.some((child, index) => child !== rawChildren[index]);
  const previousRatios = Array.isArray(node.ratios) ? node.ratios : [];
  const nextRatios = normalizedPaneRatios(previousRatios, nextChildren.length);
  const ratiosChanged = nextRatios !== previousRatios;

  if (validChildren.length !== rawChildren.length) {
    repairs.push({
      splitId: node.id,
      childIds: nextChildren.map((child) => child.id),
      previousRatios: previousRatios.slice(),
      nextRatios: nextRatios.slice(),
      reason: 'invalid-child',
    });
  } else if (ratiosChanged) {
    repairs.push({
      splitId: node.id,
      childIds: nextChildren.map((child) => child.id),
      previousRatios: previousRatios.slice(),
      nextRatios: nextRatios.slice(),
      reason: repairReason(previousRatios, nextChildren.length),
    });
  }

  return childrenChanged || ratiosChanged
    ? { ...node, children: nextChildren, ratios: nextRatios }
    : node;
}

/**
 * Canonical pure pane-layout invariant. Valid trees are returned by reference;
 * malformed splits are repaired without changing child order, ids, or content.
 */
export function repairPaneLayout(layout: LayoutNode): PaneLayoutRepairResult {
  const repairs: PaneLayoutRepair[] = [];
  return { layout: repairPaneLayoutNode(layout, repairs), repairs };
}

/** Emit one quiet, content-free diagnostic only when an invariant was repaired. */
export function reportPaneLayoutRepairs(source: string, repairs: PaneLayoutRepair[]): void {
  if (repairs.length === 0) return;
  console.warn('[pane-layout] repaired invalid layout', { source, repairs });
}
