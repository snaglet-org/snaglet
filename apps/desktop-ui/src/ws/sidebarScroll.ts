import { parseSidebarTarget, type SidebarError } from '@snaglet/shared/types';
import { findMountedRow } from './sidebarMounted';

export interface SidebarScrollResult {
  scrolled: true;
  scroll_top: number;
  scroll_height: number;
  client_height: number;
  at_bottom: boolean;
}

const SCROLLABLE = /(auto|scroll|overlay)/;
function canScroll(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight && SCROLLABLE.test(getComputedStyle(el).overflowY || '');
}
/** The panel itself or its first scrollable descendant, in document order. */
function panelScroller(panel: HTMLElement): HTMLElement | null {
  if (canScroll(panel)) return panel;
  return Array.from(panel.querySelectorAll<HTMLElement>('*')).find(canScroll) ?? null;
}
/** Nearest scrollable ancestor of a row, bounded by the panel. */
function rowScroller(panel: HTMLElement, row: HTMLElement): HTMLElement | null {
  for (let el = row.parentElement; el; el = el.parentElement) {
    if (canScroll(el)) return el;
    if (el === panel) break;
  }
  return null;
}
function findRow(panel: HTMLElement, tab: string, target: string): HTMLElement | null {
  const parsed = parseSidebarTarget(target);
  if (!parsed) return null;
  if (parsed.kind === 'mounted') return findMountedRow(panel, tab, target);
  if (parsed.kind === 'container') {
    const row = Array.from(panel.querySelectorAll<HTMLElement>('[data-row-id]')).find(
      (el) => el.dataset.rowId === parsed.id
    );
    return (row?.closest<HTMLElement>('[role="treeitem"]') ?? row) || null;
  }
  return null;
}
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
function metrics(el: HTMLElement): SidebarScrollResult {
  return {
    scrolled: true,
    scroll_top: el.scrollTop,
    scroll_height: el.scrollHeight,
    client_height: el.clientHeight,
    at_bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
  };
}

/**
 * Programmatic eased scroll (rAF, not native smooth, which ignores duration).
 * Resolves only after the last frame so callers can verify the final position.
 */
export function requestSidebarScroll(
  panel: HTMLElement | null,
  tab: string,
  request: { to?: 'top' | 'bottom'; target?: string; duration_ms: number }
): Promise<SidebarScrollResult | { error: SidebarError }> {
  if (!panel) return Promise.resolve({ error: 'not_scrollable' });
  let scroller: HTMLElement | null;
  let row: HTMLElement | null = null;
  if (request.target !== undefined) {
    row = findRow(panel, tab, request.target);
    if (!row) return Promise.resolve({ error: 'node_unavailable' });
    scroller = rowScroller(panel, row);
  } else scroller = panelScroller(panel);
  if (!scroller) return Promise.resolve({ error: 'not_scrollable' });
  const el = scroller;
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  let end: number;
  if (row) {
    const rowRect = row.getBoundingClientRect();
    const boxRect = el.getBoundingClientRect();
    end = el.scrollTop + (rowRect.top - boxRect.top) - (el.clientHeight - rowRect.height) / 2;
  } else end = request.to === 'bottom' ? max : 0;
  end = Math.min(max, Math.max(0, end));
  const start = el.scrollTop;
  const duration = request.duration_ms;
  if (duration <= 0 || start === end) {
    el.scrollTop = end;
    return Promise.resolve(metrics(el));
  }
  return new Promise((resolve) => {
    let t0: number | null = null;
    const frame = (now: number) => {
      if (t0 === null) t0 = now;
      const progress = Math.min(1, (now - t0) / duration);
      el.scrollTop = start + (end - start) * easeInOut(progress);
      if (progress < 1 && el.isConnected) requestAnimationFrame(frame);
      else {
        if (el.isConnected) el.scrollTop = end;
        resolve(metrics(el));
      }
    };
    requestAnimationFrame(frame);
  });
}
