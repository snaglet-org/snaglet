import { getEffectiveZoom } from '@desktop/utils/cssZoom';
import { createEdgeAutoScroller } from '@desktop/utils/edgeAutoScroll';

/** Pointer travel before a card press becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 5;

/** Marks a Board column; its value is the column key a drop targets. */
export const BOARD_COLUMN_ATTR = 'data-board-column';
/** Set on the column the pointer is over while a card drags. */
const BOARD_DROP_TARGET_ATTR = 'data-board-drop-target';
/** Marks the scrollable card list inside each Board column. */
export const BOARD_CARDS_ATTR = 'data-board-cards';

interface CardDragOptions {
  /** The horizontal scroller around the columns; it auto-scrolls at its edges. */
  scroller: HTMLElement;
  card: HTMLElement;
  /** The column the card starts in. */
  fromKey: string;
  startX: number;
  startY: number;
  onStart?: () => void;
  /** Called on release over another column with that column's key. */
  onDrop: (toKey: string) => void;
  /** Called once the gesture ends; `dragged` is false for a plain click. */
  onEnd: (dragged: boolean) => void;
}

/**
 * Card move by pointer, shaped like the grid's column drag: a copy of the
 * card floats under the pointer, the column under it lights up as the drop
 * target, and the scroller auto-scrolls while the pointer rests near its
 * left or right edge, or the column's card list scrolls when the pointer
 * rests near that list's top or bottom edge. Escape cancels. Styles are
 * applied imperatively for the length of the gesture so moving the pointer
 * never re-renders React.
 */
export function startCardDrag({
  scroller,
  card,
  fromKey,
  startX,
  startY,
  onStart,
  onDrop,
  onEnd,
}: CardDragOptions): () => void {
  let active = false;
  let ended = false;
  let clientX = startX;
  let clientY = startY;
  let ghost: HTMLDivElement | null = null;
  let grabX = 0;
  let grabY = 0;
  let bodyZoom = 1;
  let target: HTMLElement | null = null;

  /** Horizontal scroller at left/right edges of the board. */
  const autoScroll = createEdgeAutoScroller(scroller, { axis: 'x', onScroll: () => track() });
  /**
   * Vertical scroller for the card list of the current drop-target column.
   * Replaced whenever the target column changes; null when there is no target.
   */
  let yAutoScroll: ReturnType<typeof createEdgeAutoScroller> | null = null;

  const bodyStyle = {
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  };

  const columnAt = (x: number, y: number): HTMLElement | null => {
    const hit = document.elementFromPoint(x, y);
    const column = hit?.closest<HTMLElement>(`[${BOARD_COLUMN_ATTR}]`) ?? null;
    return column && scroller.contains(column) ? column : null;
  };

  const setTarget = (next: HTMLElement | null) => {
    if (next === target) return;
    target?.removeAttribute(BOARD_DROP_TARGET_ATTR);
    target = next;
    target?.setAttribute(BOARD_DROP_TARGET_ATTR, '');

    // Stop the previous column's y-scroller and start one for the new column's card list.
    yAutoScroll?.stop();
    const list = target?.querySelector<HTMLElement>(`[${BOARD_CARDS_ATTR}]`) ?? null;
    yAutoScroll = list
      ? createEdgeAutoScroller(list, { axis: 'y', onScroll: () => track() })
      : null;
  };

  const placeGhost = () => {
    if (!ghost) return;
    ghost.style.left = `${(clientX - grabX) / bodyZoom}px`;
    ghost.style.top = `${(clientY - grabY) / bodyZoom}px`;
  };

  const track = () => {
    // The ghost ignores pointer events, so the hit test sees the column.
    setTarget(columnAt(clientX, clientY));
    placeGhost();
  };

  const buildGhost = () => {
    const rect = card.getBoundingClientRect();
    grabX = startX - rect.left;
    grabY = startY - rect.top;
    const copy = card.cloneNode(true) as HTMLElement;
    copy.removeAttribute('id');
    copy.style.cssText = `width:${rect.width / bodyZoom}px;margin:0`;
    ghost = document.createElement('div');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.dataset.boardCardGhost = '';
    ghost.style.cssText = [
      'position:fixed',
      'z-index:10000',
      'pointer-events:none',
      'box-shadow:var(--shadow-lg)',
      'outline:1px solid var(--color-primary)',
      'border-radius:var(--radius-card)',
      'overflow:hidden',
      'background:var(--color-background)',
      'opacity:0.95',
    ].join(';');
    ghost.append(copy);
    document.body.append(ghost);
  };

  const activate = () => {
    active = true;
    bodyZoom = getEffectiveZoom(document.body);
    window.getSelection()?.removeAllRanges();
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    card.style.opacity = '0.35';
    buildGhost();
    onStart?.();
  };

  const cleanup = () => {
    autoScroll.stop();
    yAutoScroll?.stop();
    yAutoScroll = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKeyDown, true);
    ghost?.remove();
    ghost = null;
    setTarget(null);
    card.style.opacity = '';
    document.body.style.cursor = bodyStyle.cursor;
    document.body.style.userSelect = bodyStyle.userSelect;
  };

  const onMove = (event: PointerEvent) => {
    clientX = event.clientX;
    clientY = event.clientY;
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
    // track() calls setTarget(), which may create or replace the y-scroller;
    // update the y-scroller after track() so it always sees the current pointer.
    track();
    yAutoScroll?.update(event.clientX, event.clientY);
  };

  const onUp = () => {
    if (ended) return;
    ended = true;
    const toKey = target?.getAttribute(BOARD_COLUMN_ATTR) ?? null;
    cleanup();
    if (active && toKey !== null && toKey !== fromKey) onDrop(toKey);
    onEnd(active);
  };

  const onCancel = () => {
    if (ended) return;
    ended = true;
    cleanup();
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
