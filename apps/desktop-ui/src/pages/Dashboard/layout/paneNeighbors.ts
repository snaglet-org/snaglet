/**
 * Which pane keyboard focus moves to: the one beside the active pane in a
 * direction (⌘⌥ + arrow), or the next one in reading order (⌃Tab). Works on
 * the panes' on-screen boxes, so it follows the layout as drawn, whatever
 * nesting of splits produced it.
 */

export interface PaneBox {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

/** Panes sharing an edge sit this far apart, give or take the divider. */
const EDGE_TOLERANCE = 2;

interface Measure {
  /** Distance from the active pane's edge to the candidate's near edge. */
  gap: number;
  /** How much the two overlap across the direction of travel. */
  overlap: number;
  /** How far the candidate's center is off the active pane's, across it. */
  offset: number;
}

function measure(from: PaneBox, to: PaneBox, direction: PaneDirection): Measure {
  const horizontal = direction === 'left' || direction === 'right';
  const gap =
    direction === 'right'
      ? to.left - from.right
      : direction === 'left'
        ? from.left - to.right
        : direction === 'down'
          ? to.top - from.bottom
          : from.top - to.bottom;
  const [fromStart, fromEnd, toStart, toEnd] = horizontal
    ? [from.top, from.bottom, to.top, to.bottom]
    : [from.left, from.right, to.left, to.right];
  return {
    gap,
    overlap: Math.min(fromEnd, toEnd) - Math.max(fromStart, toStart),
    offset: Math.abs((toStart + toEnd) / 2 - (fromStart + fromEnd) / 2),
  };
}

/**
 * The pane beside `fromId` in `direction`, or null at the layout's edge.
 * Among the panes past that edge it prefers one level with the active pane
 * (overlapping it across the direction of travel), then the nearest, then
 * the one most in line; a tie goes to the first in reading order.
 */
export function paneInDirection(
  boxes: PaneBox[],
  fromId: string,
  direction: PaneDirection
): string | null {
  const from = boxes.find((candidate) => candidate.id === fromId);
  if (!from) return null;
  let best: { id: string; level: boolean; gap: number; offset: number } | null = null;
  for (const to of boxes) {
    if (to.id === fromId) continue;
    const { gap, overlap, offset } = measure(from, to, direction);
    if (gap < -EDGE_TOLERANCE) continue;
    const level = overlap > 0;
    const better =
      best === null ||
      (level && !best.level) ||
      (level === best.level &&
        (gap < best.gap - EDGE_TOLERANCE ||
          (Math.abs(gap - best.gap) <= EDGE_TOLERANCE && offset < best.offset)));
    if (better) best = { id: to.id, level, gap, offset };
  }
  return best?.id ?? null;
}

/**
 * The pane `step` places from `fromId` in reading order, wrapping at the
 * ends; the first (or last) pane when `fromId` is not among them. Null when
 * there is no other pane.
 */
export function paneInOrder(ids: string[], fromId: string | null, step: 1 | -1): string | null {
  if (ids.length < 2) return null;
  const at = fromId === null ? -1 : ids.indexOf(fromId);
  if (at < 0) return step === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(at + step + ids.length) % ids.length];
}
