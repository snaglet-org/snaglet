/**
 * Wheel handling for regions that scroll sideways (wide code blocks, markdown
 * tables, the pane rail). `consumeVerticalWheelAsHorizontal` handles a single
 * element; `attachHorizontalWheelDelegation` puts one listener on a subtree
 * root.
 *
 * Where such a region sits in a page that scrolls vertically (a doc, a chat),
 * vertical scrolling comes first: each wheel gesture keeps to one axis
 * (`wheelGestureAxis`), so scrolling down over a table moves the page only
 * and a sideways swipe moves the table only. A region with no vertical
 * scrolling around it (a strip in a toolbar) turns a plain vertical wheel
 * into sideways movement, so a mouse can reach it. Modified wheels are left
 * alone (Shift scrolls sideways, Ctrl/Meta zoom), a region at its edge hands
 * the wheel back to the page, and a nested vertical scroller keeps the wheel
 * until it bottoms out, matching native scroll chaining.
 */

/**
 * Marks a region that opts into wheel translation. Detection also accepts a
 * computed `overflow-x: auto|scroll`, but stamping the attribute makes the
 * intent explicit at the call site (and testable without a layout engine).
 */
export const WHEEL_SCROLL_X_ATTR = 'data-wheel-scroll-x';

/** JSX spread form of {@link WHEEL_SCROLL_X_ATTR}: `<div {...WHEEL_SCROLL_X_PROPS} />`. */
export const WHEEL_SCROLL_X_PROPS = { [WHEEL_SCROLL_X_ATTR]: '' } as const;

/** Nominal line height for `deltaMode === DOM_DELTA_LINE` wheel events. */
const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * The slice of `WheelEvent` these helpers read. Declared structurally so
 * tests (and any synthetic React wheel event) can pass a plain object.
 */
export type HorizontalWheelInput = Pick<
  WheelEvent,
  | 'deltaX'
  | 'deltaY'
  | 'deltaMode'
  | 'shiftKey'
  | 'ctrlKey'
  | 'metaKey'
  | 'cancelable'
  | 'preventDefault'
>;

/**
 * Is this a wheel event we are allowed to reinterpret? Only a pure vertical,
 * cancelable, unmodified wheel qualifies: anything horizontal is already the
 * gesture the user asked for, and modifier combos belong to the browser
 * (Shift = horizontal, Ctrl/Meta = zoom).
 */
export function isConvertibleVerticalWheel(event: HorizontalWheelInput): boolean {
  return (
    event.cancelable &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    Number.isFinite(event.deltaY) &&
    event.deltaY !== 0 &&
    event.deltaX === 0
  );
}

/** A wheel delta in CSS pixels, honoring `deltaMode` (pixel / line / page). */
function deltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
  const scale = deltaMode === 1 ? WHEEL_LINE_HEIGHT_PX : deltaMode === 2 ? pageSize : 1;
  return delta * scale;
}

/** The vertical wheel delta in CSS pixels, a page being `el`'s width. */
export function wheelDeltaToPixels(el: HTMLElement, event: HorizontalWheelInput): number {
  return deltaToPixels(event.deltaY, event.deltaMode, el.clientWidth);
}

export type WheelAxis = 'x' | 'y';

/** The axis a wheel gesture keeps, and when its latest event came. */
export interface WheelGesture {
  axis: WheelAxis;
  at: number;
}

/** Wheel events closer together than this belong to one gesture. */
const GESTURE_GAP_MS = 120;
/** Sideways movement must outweigh vertical by this much to make a gesture sideways. */
const SIDEWAYS_BIAS = 1.5;

/**
 * The axis an unmodified wheel event scrolls along, vertical first. A
 * gesture's first event decides: sideways only when |deltaX| > 1.5 ×
 * |deltaY|. Later events, each within `GESTURE_GAP_MS` of the one before,
 * keep that axis, so a vertical swipe that drifts sideways stays vertical;
 * after a pause the next event starts a new gesture. A modified wheel (Shift,
 * Ctrl, Meta) is no part of a gesture: the browser handles it, and the caller
 * leaves the gesture as it was.
 */
export function wheelGestureAxis(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY'>,
  previous: WheelGesture | null,
  now: number
): WheelGesture {
  if (previous && now - previous.at < GESTURE_GAP_MS) return { axis: previous.axis, at: now };
  const sideways = Math.abs(event.deltaX) > SIDEWAYS_BIAS * Math.abs(event.deltaY);
  return { axis: sideways ? 'x' : 'y', at: now };
}

function computedStyleOf(el: HTMLElement): CSSStyleDeclaration | null {
  return el.ownerDocument?.defaultView?.getComputedStyle(el) ?? null;
}

/**
 * Is `el` a region this mechanism may scroll sideways? It must overflow
 * horizontally and either carry {@link WHEEL_SCROLL_X_ATTR} or be a real
 * horizontal scroll container. The computed-style branch covers scroll
 * containers from CSS this app doesn't own (e.g. ProseMirror's `.tableWrapper`).
 */
export function isHorizontalWheelRegion(el: HTMLElement): boolean {
  if (el.scrollWidth - el.clientWidth <= 1) return false;
  if (el.hasAttribute(WHEEL_SCROLL_X_ATTR)) return true;
  const overflowX = computedStyleOf(el)?.overflowX;
  return overflowX === 'auto' || overflowX === 'scroll';
}

/**
 * Should `el` keep the vertical wheel for its own vertical scrolling? True
 * for a vertical scroll container that can still move in the wheel's
 * direction — e.g. a table cell whose long prose scrolls inside its capped
 * box. Once it hits its end the answer flips to false and the walk continues
 * outward, which is exactly how native scroll chaining behaves.
 */
export function prefersNativeVerticalScroll(el: HTMLElement, deltaY: number): boolean {
  const maxScrollTop = el.scrollHeight - el.clientHeight;
  if (maxScrollTop <= 1) return false;
  const overflowY = computedStyleOf(el)?.overflowY;
  if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
  return deltaY > 0 ? el.scrollTop < maxScrollTop - 1 : el.scrollTop > 1;
}

/**
 * Can `el` scroll vertically in the direction of `deltaY`? The document's
 * scrolling element counts whatever its overflow style says.
 */
function canScrollVertically(el: HTMLElement, deltaY: number): boolean {
  const maxScrollTop = el.scrollHeight - el.clientHeight;
  if (maxScrollTop <= 1) return false;
  if (el !== el.ownerDocument?.scrollingElement) {
    const overflowY = computedStyleOf(el)?.overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
  }
  return deltaY > 0 ? el.scrollTop < maxScrollTop - 1 : el.scrollTop > 1;
}

/**
 * Does `region` sit in a page that scrolls vertically: is any element around
 * it a vertical scroll container with room to scroll? Then a vertical wheel
 * over it belongs to that page.
 */
function scrollsWithPage(region: HTMLElement): boolean {
  for (let el = region.parentElement; el; el = el.parentElement) {
    if (canScrollVertically(el, 1) || canScrollVertically(el, -1)) return true;
  }
  return false;
}

/**
 * Move `el` horizontally by `delta` CSS pixels and report whether it moved.
 * The browser clamps `scrollLeft`, so a region at its edge reports `false`;
 * that also handles RTL without guessing the engine's `scrollLeft` convention.
 * Smooth scrolling is on globally and a smooth assignment doesn't move
 * synchronously, so this movement is forced to be immediate.
 */
function scrollHorizontallyBy(el: HTMLElement, delta: number): boolean {
  const maxScrollLeft = el.scrollWidth - el.clientWidth;
  if (maxScrollLeft <= 1) return false;

  const rawDelta = computedStyleOf(el)?.direction === 'rtl' ? -delta : delta;
  const before = el.scrollLeft;
  const previousScrollBehavior = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollLeft = before + rawDelta;
  el.style.scrollBehavior = previousScrollBehavior;
  return el.scrollLeft !== before;
}

/** Move `el` vertically by `delta` CSS pixels at once (smooth scrolling is on globally). */
function scrollVerticallyBy(el: HTMLElement, delta: number): void {
  const previousScrollBehavior = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop += delta;
  el.style.scrollBehavior = previousScrollBehavior;
}

/**
 * Translate a vertical wheel into horizontal movement of `el`.
 *
 * Returns true when the event was consumed (`preventDefault()` called).
 * Returns false — leaving the event untouched for the page/pane — when the
 * wheel is not convertible, when `el` cannot scroll sideways, or when it is
 * already at the boundary in that direction.
 */
export function consumeVerticalWheelAsHorizontal(
  el: HTMLElement,
  event: HorizontalWheelInput
): boolean {
  if (!isConvertibleVerticalWheel(event)) return false;
  if (!scrollHorizontallyBy(el, wheelDeltaToPixels(el, event))) return false;
  event.preventDefault();
  return true;
}

/**
 * Delegated form: walk from the pointed-at element outward to `root`
 * (inclusive) and let the first region that can actually move consume the
 * wheel.
 *
 * Walking outward means the innermost region wins (a wide code block inside a
 * table cell scrolls before the table does), and a region pinned at its
 * boundary hands off to the next one out — and finally to the page — rather
 * than swallowing the gesture.
 */
export function consumeVerticalWheelInRegion(
  root: HTMLElement,
  start: Element | null,
  event: HorizontalWheelInput
): boolean {
  if (!isConvertibleVerticalWheel(event)) return false;

  let el: HTMLElement | null = startWithin(root, start);
  while (el) {
    if (prefersNativeVerticalScroll(el, event.deltaY)) return false;
    if (isHorizontalWheelRegion(el)) {
      // In a page that scrolls vertically the wheel scrolls the page.
      if (scrollsWithPage(el)) return false;
      if (scrollHorizontallyBy(el, wheelDeltaToPixels(el, event))) {
        event.preventDefault();
        return true;
      }
    }
    if (el === root) break;
    el = el.parentElement;
  }
  return false;
}

/** Where a walk out to `root` starts: the pointed-at element, or `root` for one outside it. */
function startWithin(root: HTMLElement, start: Element | null): HTMLElement {
  return start instanceof HTMLElement && root.contains(start) ? start : root;
}

/** The regions under the pointer that scroll sideways in a vertically scrolling page, innermost first. */
function pageRegionsUnder(root: HTMLElement, start: Element | null): HTMLElement[] {
  const regions: HTMLElement[] = [];
  for (let el: HTMLElement | null = startWithin(root, start); el; el = el.parentElement) {
    if (isHorizontalWheelRegion(el) && scrollsWithPage(el)) regions.push(el);
    if (el === root) break;
  }
  return regions;
}

/**
 * Keep a wheel event over a sideways region of a vertically scrolling page to
 * its gesture's axis. The browser scrolls both axes of a diagonal event, so
 * an event that has movement off the axis is taken over: a vertical one
 * scrolls the first vertical scroller under the pointer that can move, a
 * sideways one the innermost region that can move, and the other axis stays
 * still. An event already on its axis is left to the browser. Returns true
 * when the event was taken over (`preventDefault()` called).
 */
export function lockWheelToAxis(
  root: HTMLElement,
  start: Element | null,
  event: HorizontalWheelInput,
  axis: WheelAxis
): boolean {
  if (!event.cancelable || event.shiftKey || event.ctrlKey || event.metaKey) return false;
  const offAxis = axis === 'y' ? event.deltaX : event.deltaY;
  if (!Number.isFinite(offAxis) || offAxis === 0) return false;
  const regions = pageRegionsUnder(root, start);
  if (regions.length === 0) return false;
  event.preventDefault();

  if (axis === 'x') {
    for (const region of regions) {
      const delta = deltaToPixels(event.deltaX, event.deltaMode, region.clientWidth);
      if (scrollHorizontallyBy(region, delta)) break;
    }
    return true;
  }
  for (let el: HTMLElement | null = startWithin(root, start); el; el = el.parentElement) {
    const delta = deltaToPixels(event.deltaY, event.deltaMode, el.clientHeight);
    if (canScrollVertically(el, delta)) {
      scrollVerticallyBy(el, delta);
      break;
    }
  }
  return true;
}

/** Nearest element for an event target (wheel can land on a text node). */
function nearestElement(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  if (!node || typeof node.nodeType !== 'number') return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * Attach one non-passive wheel listener that handles every horizontally
 * scrollable region inside `root`: each gesture keeps to one axis
 * (`lockWheelToAxis`), and a vertical one over a region outside any vertical
 * scrolling turns sideways (`consumeVerticalWheelInRegion`). Returns a detach
 * function.
 *
 * Nested roots are safe: an inner delegation that consumed the event marks it
 * `defaultPrevented`, and outer roots skip it instead of double-scrolling.
 */
export function attachHorizontalWheelDelegation(root: HTMLElement): () => void {
  let gesture: WheelGesture | null = null;
  const onWheel = (event: WheelEvent) => {
    // Modified wheels belong to the browser and neither start nor extend a
    // gesture: Shift scrolls sideways, Ctrl/Meta zoom (a trackpad pinch
    // arrives as Ctrl+wheel).
    if (event.defaultPrevented || event.shiftKey || event.ctrlKey || event.metaKey) return;
    gesture = wheelGestureAxis(event, gesture, event.timeStamp);
    const start = nearestElement(event.target);
    if (lockWheelToAxis(root, start, event, gesture.axis)) return;
    if (gesture.axis === 'y') consumeVerticalWheelInRegion(root, start, event);
  };
  // Non-passive: the handler may call preventDefault().
  root.addEventListener('wheel', onWheel, { passive: false });
  return () => root.removeEventListener('wheel', onWheel);
}
