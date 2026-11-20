/**
 * Pointer gesture for the calendar grids: moving / resizing an item,
 * and sweeping empty grid to create an event. Shaped like
 * `TableView/cardDrag.ts`: pointer events (never HTML5 DnD), a 4 px threshold
 * (in the pane's own px: the travel is divided by its CSS zoom), the
 * original item at 35 % while it lifts, edge auto-scroll of the calendar
 * scroller, Esc cancels, and the click after a drag is swallowed so it
 * doesn't open the item or start a second quick add.
 *
 * Unlike the Board, the ghost is not a cloned node following the pointer: the
 * grid draws it at the snapped place (from minutes / days, so the pane's CSS
 * zoom never enters the math). This module only reports the
 * pointer; `resolve` turns it into a preview (or null = invalid drop).
 */
import { getEffectiveZoom } from '@desktop/utils/cssZoom';
import { createEdgeAutoScroller } from '@desktop/utils/edgeAutoScroll';

const DRAG_THRESHOLD_PX = 4;

function swallowClick(event: MouseEvent): void {
  event.stopPropagation();
  event.preventDefault();
}

/**
 * Swallow the click that follows a drag's release (it fires in the same
 * task), so it doesn't open what the pointer ends over.
 */
export function swallowNextClick(): void {
  window.addEventListener('click', swallowClick, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
}

export interface CalendarDragOptions<P> {
  /** The pressed item: it fades to 35 % while it lifts. None for a create sweep. */
  item?: HTMLElement | null;
  /** The calendar's scroll container (auto-scrolls near its top / bottom). */
  scroller: HTMLElement | null;
  /** An element inside the zoomed pane, for the threshold's zoom correction. */
  zoomOf?: Element | null;
  startX: number;
  startY: number;
  /** Cursor while dragging (`grabbing`, `ns-resize` / `ew-resize`, `crosshair`). */
  cursor: string;
  /** The preview under a viewport point, or null when it can't drop there. */
  resolve: (clientX: number, clientY: number) => P | null;
  /** Each change of the preview while dragging (null = invalid, or canceled). */
  onPreview: (preview: P | null) => void;
  /** Release over a valid place. */
  onDrop: (preview: P) => void;
  /** Gesture over (after onDrop when there was one); `dragged` false = a plain click. */
  onEnd: (dragged: boolean) => void;
}

/** Start tracking a press; returns a cancel function. */
export function startCalendarDrag<P>({
  item = null,
  scroller,
  zoomOf,
  startX,
  startY,
  cursor,
  resolve,
  onPreview,
  onDrop,
  onEnd,
}: CalendarDragOptions<P>): () => void {
  let active = false;
  let ended = false;
  let clientX = startX;
  let clientY = startY;
  let preview: P | null = null;
  const zoom = getEffectiveZoom(zoomOf ?? item ?? scroller) || 1;
  const autoScroll = scroller
    ? createEdgeAutoScroller(scroller, { axis: 'y', onScroll: () => track() })
    : null;
  const bodyStyle = {
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  };
  const itemOpacity = item?.style.opacity ?? '';

  const track = () => {
    preview = resolve(clientX, clientY);
    document.body.style.cursor = preview === null ? 'not-allowed' : cursor;
    onPreview(preview);
  };

  const activate = () => {
    active = true;
    window.getSelection()?.removeAllRanges();
    document.body.style.userSelect = 'none';
    if (item) {
      item.style.opacity = '0.35';
      item.dataset.calendarDragging = '';
    }
  };

  // After Esc the button is still down: its release must not click either.
  const forgetRelease = () => {
    window.removeEventListener('pointerup', releaseAfterCancel, true);
    window.removeEventListener('pointercancel', forgetRelease, true);
  };
  const releaseAfterCancel = () => {
    forgetRelease();
    swallowNextClick();
  };

  const cleanup = () => {
    autoScroll?.stop();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKeyDown, true);
    document.body.style.cursor = bodyStyle.cursor;
    document.body.style.userSelect = bodyStyle.userSelect;
    if (item) {
      item.style.opacity = itemOpacity;
      delete item.dataset.calendarDragging;
    }
  };

  const onMove = (event: PointerEvent) => {
    clientX = event.clientX;
    clientY = event.clientY;
    if (!active) {
      if (
        Math.abs(clientX - startX) / zoom < DRAG_THRESHOLD_PX &&
        Math.abs(clientY - startY) / zoom < DRAG_THRESHOLD_PX
      )
        return;
      activate();
    }
    event.preventDefault();
    autoScroll?.update(clientX, clientY);
    track();
  };

  const onUp = (event: PointerEvent) => {
    if (ended) return;
    ended = true;
    if (active) {
      clientX = event.clientX;
      clientY = event.clientY;
      preview = resolve(clientX, clientY);
    }
    cleanup();
    // The click that follows must not open the item (or, on empty grid,
    // start a second quick add).
    if (active) swallowNextClick();
    if (active && preview !== null) onDrop(preview);
    else if (active) onPreview(null);
    onEnd(active);
  };

  const onCancel = () => {
    if (ended) return;
    ended = true;
    cleanup();
    if (active) onPreview(null);
    onEnd(active);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!active || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
    window.addEventListener('pointerup', releaseAfterCancel, true);
    window.addEventListener('pointercancel', forgetRelease, true);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeyDown, true);
  return onCancel;
}
