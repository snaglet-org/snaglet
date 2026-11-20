import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * The tree's keyboard stops, in drawn order: every focusable tree item (node
 * rows, group headers, table and board rows) and the focusable row inside a
 * Files group item. Collapsed content is not rendered, so the DOM order is
 * the on-screen order.
 */
const STOP_SELECTOR =
  '[role="treeitem"][tabindex="0"], [role="treeitem"] > [role="button"][tabindex="0"]';

function levelOf(el: HTMLElement): number | null {
  const level = Number(el.getAttribute('aria-level'));
  return Number.isInteger(level) && level > 0 ? level : null;
}

/**
 * Arrow-key walking between the tree's rows, per the WAI-ARIA tree pattern:
 * Down / Up move to the next / previous row, Home / End to the first / last,
 * Right on an open row steps into its first child, and Left on a row that is
 * not open steps out to its parent (the nearest row above at a lower level).
 * Opening and closing stay with each row's own handler, which marks the key
 * handled; anything aimed at an input, a button or another control is left
 * alone.
 */
export function handleTreeNavigationKey(e: ReactKeyboardEvent<HTMLElement>): void {
  if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const target = e.target as HTMLElement;
  if (!target.matches(STOP_SELECTOR)) return;
  const stops = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(STOP_SELECTOR));
  const index = stops.indexOf(target);
  if (index === -1) return;

  let next: HTMLElement | undefined;
  if (e.key === 'ArrowDown') next = stops[index + 1];
  else if (e.key === 'ArrowUp') next = stops[index - 1];
  else if (e.key === 'Home') next = stops[0];
  else if (e.key === 'End') next = stops[stops.length - 1];
  else {
    const level = levelOf(target);
    if (level === null) return;
    if (e.key === 'ArrowRight') {
      if (target.getAttribute('aria-expanded') !== 'true') return;
      const child = stops[index + 1];
      const childLevel = child ? levelOf(child) : null;
      if (childLevel !== null && childLevel > level) next = child;
    } else {
      if (target.getAttribute('aria-expanded') === 'true') return;
      for (let i = index - 1; i >= 0; i -= 1) {
        const above = levelOf(stops[i]);
        if (above !== null && above < level) {
          next = stops[i];
          break;
        }
      }
    }
  }
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/**
 * Where keyboard focus goes once the rows `focusIndex` points at leave the
 * tree: the row that took their place, or the last row when they were last.
 */
export function focusTreeStopAt(tree: HTMLElement, focusIndex: number): void {
  const stops = tree.querySelectorAll<HTMLElement>(STOP_SELECTOR);
  if (stops.length === 0) return;
  stops[Math.min(focusIndex, stops.length - 1)].focus({ preventScroll: true });
}

/** The position of `el` among the tree's keyboard stops, or -1. */
export function treeStopIndex(tree: HTMLElement, el: Element | null): number {
  if (!el) return -1;
  return Array.from(tree.querySelectorAll(STOP_SELECTOR)).indexOf(el);
}
