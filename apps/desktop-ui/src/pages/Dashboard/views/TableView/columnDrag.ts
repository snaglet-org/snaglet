import { getEffectiveZoom } from '@desktop/utils/cssZoom';
import { createEdgeAutoScroller } from '@desktop/utils/edgeAutoScroll';

/** Pointer travel before a header press becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 5;
const SLIDE = 'transform 150ms ease';

interface ColumnDragOptions {
  /** The horizontal scroller around the table; it auto-scrolls at its edges. */
  scroller: HTMLElement;
  table: HTMLTableElement;
  /** Index of the pressed header. */
  from: number;
  startX: number;
  startY: number;
  onStart?: () => void;
  /**
   * Called on release with the final column index. Must commit the new
   * order synchronously (flushSync) so
   * the live preview can be cleared without a flash of the previous order.
   */
  onDrop: (from: number, to: number) => void;
  /** Called once the gesture ends; `dragged` is false for a plain click. */
  onEnd: (dragged: boolean) => void;
}

function verticalClip(el: HTMLElement): DOMRect | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node.getBoundingClientRect();
  }
  return null;
}

/**
 * Column reorder by pointer, shaped like the workspace tree's drags: a copy
 * of the whole column floats under the pointer, the other columns slide
 * aside to preview where it lands, and the scroller auto-scrolls while the
 * pointer rests near its left or right edge. Escape cancels.
 *
 * Styles are applied imperatively for the length of the gesture so moving
 * the pointer never re-renders React; everything is removed on release.
 */
export function startColumnDrag({
  scroller,
  table,
  from,
  startX,
  startY,
  onStart,
  onDrop,
  onEnd,
}: ColumnDragOptions): () => void {
  const headers = Array.from(table.tHead?.rows[0]?.cells ?? []).filter(
    (cell) => cell.dataset.column !== undefined
  );
  const columnNames = headers.map((cell) => cell.dataset.column);
  const columnIndexes = new Map(columnNames.map((name, index) => [name, index]));
  let active = false;
  let slot = from;
  let clientX = startX;
  let ghost: HTMLDivElement | null = null;
  let grabOffset = 0;
  let lefts: number[] = [];
  let widths: number[] = [];
  let clip: DOMRect | null = null;
  // `lefts`/`widths` are table-local px (offsetLeft/offsetWidth); pointer and
  // rect geometry is viewport px. Under CSS zoom (pane zoom, ⌘+/−) they
  // differ by `zoom`; the ghost lives in document.body, so its px differ from
  // the viewport by `bodyZoom` only. See utils/cssZoom.
  let zoom = 1;
  let bodyZoom = 1;
  let ended = false;
  const autoScroll = createEdgeAutoScroller(scroller, { axis: 'x', onScroll: () => track() });
  const bodyStyle = {
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  };
  const destination = () => (slot > from ? slot - 1 : slot);

  const eachCell = (visit: (cell: HTMLTableCellElement, index: number) => void) => {
    for (const row of Array.from(table.rows)) {
      for (const cell of Array.from(row.cells)) {
        const index = columnIndexes.get(cell.dataset.column);
        if (index !== undefined) visit(cell, index);
      }
    }
  };

  /** Slide cells so the layout previews the order the drop would produce. */
  const preview = () => {
    const to = destination();
    const moved = widths[from] ?? 0;
    const offsets = widths.map((_, index) => {
      if (index === from) {
        if (to > from) return widths.slice(from + 1, to + 1).reduce((sum, w) => sum + w, 0);
        return -widths.slice(to, from).reduce((sum, w) => sum + w, 0);
      }
      if (from < index && index <= to) return -moved;
      if (to <= index && index < from) return moved;
      return 0;
    });
    eachCell((cell, index) => {
      cell.style.transition = SLIDE;
      cell.style.transform = offsets[index] ? `translateX(${offsets[index]}px)` : '';
      cell.style.opacity = index === from ? '0.3' : '';
    });
  };

  const placeGhost = () => {
    if (!ghost) return;
    const tableRect = table.getBoundingClientRect();
    const scrollRect = scroller.getBoundingClientRect();
    const width = (widths[from] ?? 0) * zoom;
    const left = Math.min(
      Math.max(clientX - grabOffset, scrollRect.left - width / 2),
      scrollRect.right - width / 2
    );
    ghost.style.left = `${left / bodyZoom}px`;
    ghost.style.top = `${tableRect.top / bodyZoom}px`;
    if (clip) {
      const height = ghost.getBoundingClientRect().height;
      const top = Math.max(0, clip.top - tableRect.top) / bodyZoom;
      const bottom = Math.max(0, tableRect.top + height - clip.bottom) / bodyZoom;
      ghost.style.clipPath = `inset(${top}px 0 ${bottom}px 0)`;
    }
  };

  /** Re-target the drop gap from the pointer (and any auto-scroll). */
  const track = () => {
    const x = (clientX - table.getBoundingClientRect().left) / zoom;
    const index = lefts.findIndex((left, i) => x < left + widths[i] / 2);
    const next = index === -1 ? lefts.length : index;
    if (next !== slot) {
      slot = next;
      preview();
    }
    placeGhost();
  };

  const buildGhost = () => {
    const header = headers[from];
    if (!header) return;
    grabOffset = startX - header.getBoundingClientRect().left;
    const copy = table.cloneNode(false) as HTMLTableElement;
    const head = document.createElement('thead');
    const body = document.createElement('tbody');
    for (const row of Array.from(table.rows)) {
      const cell = Array.from(row.cells).find((item) => item.dataset.column === columnNames[from]);
      if (!cell) continue;
      const tr = document.createElement('tr');
      tr.className = row.className;
      const clone = cell.cloneNode(true) as HTMLTableCellElement;
      clone.querySelectorAll('[data-column-control]').forEach((control) => control.remove());
      clone.style.cssText = `width:${widths[from]}px;height:${row.getBoundingClientRect().height / zoom}px`;
      tr.append(clone);
      (row.parentElement === table.tHead ? head : body).append(tr);
    }
    copy.append(head, body);
    // The copy renders at the column's on-screen size: its own px are the
    // table's, so re-apply the table's zoom relative to the body.
    copy.style.cssText = `width:${widths[from]}px;margin:0;table-layout:fixed;zoom:${zoom / bodyZoom}`;
    const computed = getComputedStyle(table);
    ghost = document.createElement('div');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.dataset.columnDragGhost = '';
    ghost.style.cssText = [
      'position:fixed',
      'z-index:10000',
      'pointer-events:none',
      'box-shadow:var(--shadow-lg)',
      'outline:1px solid var(--color-primary)',
      'border-radius:var(--radius-card)',
      'overflow:hidden',
      // The panel color can be translucent; lift the copy off an opaque base.
      'background:var(--color-background)',
      `font-family:${computed.fontFamily}`,
      `font-size:${computed.fontSize}`,
      `color:${computed.color}`,
    ].join(';');
    ghost.append(copy);
    document.body.append(ghost);
  };

  const activate = () => {
    active = true;
    zoom = getEffectiveZoom(table);
    bodyZoom = getEffectiveZoom(document.body);
    lefts = headers.map((cell) => cell.offsetLeft);
    widths = headers.map((cell) => cell.offsetWidth);
    clip = verticalClip(scroller);
    window.getSelection()?.removeAllRanges();
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    buildGhost();
    preview();
    onStart?.();
  };

  const cleanup = (animate: boolean) => {
    autoScroll.stop();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKeyDown, true);
    ghost?.remove();
    ghost = null;
    document.body.style.cursor = bodyStyle.cursor;
    document.body.style.userSelect = bodyStyle.userSelect;
    eachCell((cell) => {
      cell.style.transition = animate ? SLIDE : '';
      cell.style.transform = '';
      cell.style.opacity = '';
    });
    if (animate) setTimeout(() => eachCell((cell) => (cell.style.transition = '')), 160);
  };

  const onMove = (event: PointerEvent) => {
    clientX = event.clientX;
    if (!active) {
      if (
        Math.abs(event.clientX - startX) < DRAG_THRESHOLD_PX &&
        Math.abs(event.clientY - startY) < DRAG_THRESHOLD_PX
      )
        return;
      activate();
    }
    event.preventDefault();
    autoScroll.update(event.clientX, event.clientY);
    track();
  };

  const onUp = () => {
    if (ended) return;
    ended = true;
    const target = destination();
    if (active && target !== from) onDrop(from, target);
    cleanup(false);
    onEnd(active);
  };

  const onCancel = () => {
    if (ended) return;
    ended = true;
    cleanup(active);
    onEnd(active);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!active || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeyDown, true);
  return onCancel;
}
