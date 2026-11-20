import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachHorizontalWheelDelegation,
  consumeVerticalWheelAsHorizontal,
  consumeVerticalWheelInRegion,
  isConvertibleVerticalWheel,
  isHorizontalWheelRegion,
  lockWheelToAxis,
  prefersNativeVerticalScroll,
  wheelDeltaToPixels,
  wheelGestureAxis,
  WHEEL_SCROLL_X_ATTR,
  type HorizontalWheelInput,
  type WheelGesture,
} from './horizontalWheelScroll';

/**
 * jsdom has no layout: `scrollWidth`/`clientWidth` are always 0 and
 * `scrollLeft` never clamps. These helpers install the browser's observable
 * contract — a clamped scroll offset inside a known overflow — which is what
 * the wheel logic reads.
 */
function makeHorizontallyScrollable(
  el: HTMLElement,
  {
    clientWidth = 200,
    scrollWidth = 800,
    scrollLeft = 0,
    rtl = false,
  }: { clientWidth?: number; scrollWidth?: number; scrollLeft?: number; rtl?: boolean } = {}
): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  const max = Math.max(0, scrollWidth - clientWidth);
  // Modern engines run RTL scroll offsets from 0 (right edge) down to -max.
  const [lo, hi] = rtl ? [-max, 0] : [0, max];
  let current = scrollLeft;
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => current,
    set: (next: number) => {
      current = Math.min(hi, Math.max(lo, next));
    },
  });
  if (rtl) el.style.direction = 'rtl';
}

function makeVerticallyScrollable(
  el: HTMLElement,
  {
    clientHeight = 100,
    scrollHeight = 400,
    scrollTop = 0,
  }: { clientHeight?: number; scrollHeight?: number; scrollTop?: number } = {}
): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
  el.style.overflowY = 'auto';
}

function wheel(overrides: Partial<HorizontalWheelInput> = {}): HorizontalWheelInput & {
  preventDefault: ReturnType<typeof vi.fn>;
} {
  return {
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    cancelable: true,
    ...overrides,
    preventDefault: vi.fn(),
  };
}

/** Marked, overflowing region attached to the document. */
function region(tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute(WHEEL_SCROLL_X_ATTR, '');
  return el;
}

describe('isConvertibleVerticalWheel', () => {
  it('accepts a plain vertical mouse wheel', () => {
    expect(isConvertibleVerticalWheel(wheel())).toBe(true);
    expect(isConvertibleVerticalWheel(wheel({ deltaY: -100 }))).toBe(true);
  });

  it('leaves native horizontal input alone (trackpad / horizontal wheel)', () => {
    expect(isConvertibleVerticalWheel(wheel({ deltaX: -40, deltaY: 12 }))).toBe(false);
    expect(isConvertibleVerticalWheel(wheel({ deltaX: 40, deltaY: 0 }))).toBe(false);
  });

  it('leaves modifier gestures to the browser', () => {
    expect(isConvertibleVerticalWheel(wheel({ shiftKey: true }))).toBe(false);
    expect(isConvertibleVerticalWheel(wheel({ ctrlKey: true }))).toBe(false); // pinch-zoom
    expect(isConvertibleVerticalWheel(wheel({ metaKey: true }))).toBe(false);
  });

  it('ignores non-cancelable, zero and non-finite deltas', () => {
    expect(isConvertibleVerticalWheel(wheel({ cancelable: false }))).toBe(false);
    expect(isConvertibleVerticalWheel(wheel({ deltaY: 0 }))).toBe(false);
    expect(isConvertibleVerticalWheel(wheel({ deltaY: Number.NaN }))).toBe(false);
  });
});

describe('wheelDeltaToPixels', () => {
  it('respects deltaMode: pixel, line and page', () => {
    const el = region();
    makeHorizontallyScrollable(el, { clientWidth: 250, scrollWidth: 1000 });

    expect(wheelDeltaToPixels(el, wheel({ deltaY: 53, deltaMode: 0 }))).toBe(53);
    expect(wheelDeltaToPixels(el, wheel({ deltaY: 3, deltaMode: 1 }))).toBe(48);
    expect(wheelDeltaToPixels(el, wheel({ deltaY: 2, deltaMode: 2 }))).toBe(500);
  });
});

describe('consumeVerticalWheelAsHorizontal (element-owned form)', () => {
  it('turns a downward wheel into rightward scrolling and consumes the event', () => {
    const el = region();
    makeHorizontallyScrollable(el);
    const event = wheel({ deltaY: 120 });

    expect(consumeVerticalWheelAsHorizontal(el, event)).toBe(true);
    expect(el.scrollLeft).toBe(120);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('turns an upward wheel into leftward scrolling', () => {
    const el = region();
    makeHorizontallyScrollable(el, { scrollLeft: 300 });
    const event = wheel({ deltaY: -120 });

    expect(consumeVerticalWheelAsHorizontal(el, event)).toBe(true);
    expect(el.scrollLeft).toBe(180);
  });

  it('does nothing when the element does not overflow horizontally', () => {
    const el = region();
    makeHorizontallyScrollable(el, { clientWidth: 200, scrollWidth: 200 });
    const event = wheel();

    expect(consumeVerticalWheelAsHorizontal(el, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('hands the wheel back at the right boundary instead of trapping it', () => {
    const el = region();
    makeHorizontallyScrollable(el, { scrollLeft: 600 }); // already at max
    const event = wheel({ deltaY: 120 });

    expect(consumeVerticalWheelAsHorizontal(el, event)).toBe(false);
    expect(el.scrollLeft).toBe(600);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('hands the wheel back at the left boundary', () => {
    const el = region();
    makeHorizontallyScrollable(el, { scrollLeft: 0 });
    const event = wheel({ deltaY: -120 });

    expect(consumeVerticalWheelAsHorizontal(el, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('still consumes a wheel that only moves part way to the boundary', () => {
    const el = region();
    makeHorizontallyScrollable(el, { scrollLeft: 570 }); // 30px of travel left
    const event = wheel({ deltaY: 120 });

    expect(consumeVerticalWheelAsHorizontal(el, event)).toBe(true);
    expect(el.scrollLeft).toBe(600);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('inverts the delta for right-to-left regions', () => {
    const el = region();
    makeHorizontallyScrollable(el, { rtl: true });
    const event = wheel({ deltaY: 120 });

    expect(consumeVerticalWheelAsHorizontal(el, event)).toBe(true);
    expect(el.scrollLeft).toBe(-120);
  });

  it('restores the inline scroll-behavior override it used to force an instant move', () => {
    const el = region();
    makeHorizontallyScrollable(el);
    el.style.scrollBehavior = 'smooth';

    consumeVerticalWheelAsHorizontal(el, wheel());

    expect(el.style.scrollBehavior).toBe('smooth');
  });
});

describe('isHorizontalWheelRegion', () => {
  it('accepts a marked, overflowing region', () => {
    const el = region();
    makeHorizontallyScrollable(el);
    expect(isHorizontalWheelRegion(el)).toBe(true);
  });

  it('rejects a marked region that has nothing to scroll', () => {
    const el = region();
    makeHorizontallyScrollable(el, { clientWidth: 300, scrollWidth: 300 });
    expect(isHorizontalWheelRegion(el)).toBe(false);
  });

  it('accepts an unmarked scroll container (CSS we do not own)', () => {
    const el = document.createElement('div');
    makeHorizontallyScrollable(el);
    el.style.overflowX = 'auto';
    expect(isHorizontalWheelRegion(el)).toBe(true);
  });

  it('rejects an overflowing element that is not a scroll container', () => {
    const el = document.createElement('div');
    makeHorizontallyScrollable(el);
    el.style.overflowX = 'visible';
    expect(isHorizontalWheelRegion(el)).toBe(false);
  });
});

describe('prefersNativeVerticalScroll', () => {
  it('is true while a nested vertical scroller can still move', () => {
    const el = document.createElement('div');
    makeVerticallyScrollable(el, { scrollTop: 120 });
    expect(prefersNativeVerticalScroll(el, 100)).toBe(true);
    expect(prefersNativeVerticalScroll(el, -100)).toBe(true);
  });

  it('is false once it reaches the end in the wheel direction', () => {
    const el = document.createElement('div');
    makeVerticallyScrollable(el, { scrollTop: 300 });
    expect(prefersNativeVerticalScroll(el, 100)).toBe(false);
    expect(prefersNativeVerticalScroll(el, -100)).toBe(true);
  });

  it('ignores tall content that is not a vertical scroll container', () => {
    const el = document.createElement('div');
    makeVerticallyScrollable(el);
    el.style.overflowY = 'visible';
    expect(prefersNativeVerticalScroll(el, 100)).toBe(false);
  });
});

describe('consumeVerticalWheelInRegion (delegated form)', () => {
  /** root > outer(region) > inner(region) > leaf, as markdown nests. */
  function nested() {
    const root = document.createElement('div');
    const outer = region();
    const inner = region();
    const leaf = document.createElement('span');
    root.append(outer);
    outer.append(inner);
    inner.append(leaf);
    document.body.append(root);
    return { root, outer, inner, leaf };
  }

  it('scrolls the innermost region under the pointer', () => {
    const { root, outer, inner, leaf } = nested();
    makeHorizontallyScrollable(outer);
    makeHorizontallyScrollable(inner);
    const event = wheel({ deltaY: 90 });

    expect(consumeVerticalWheelInRegion(root, leaf, event)).toBe(true);
    expect(inner.scrollLeft).toBe(90);
    expect(outer.scrollLeft).toBe(0);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('hands off outward when the inner region is at its boundary', () => {
    const { root, outer, inner, leaf } = nested();
    makeHorizontallyScrollable(outer);
    makeHorizontallyScrollable(inner, { scrollLeft: 600 });
    const event = wheel({ deltaY: 90 });

    expect(consumeVerticalWheelInRegion(root, leaf, event)).toBe(true);
    expect(inner.scrollLeft).toBe(600);
    expect(outer.scrollLeft).toBe(90);
  });

  it('releases the wheel to the page when every region is at its boundary', () => {
    const { root, outer, inner, leaf } = nested();
    makeHorizontallyScrollable(outer, { scrollLeft: 600 });
    makeHorizontallyScrollable(inner, { scrollLeft: 600 });
    const event = wheel({ deltaY: 90 });

    expect(consumeVerticalWheelInRegion(root, leaf, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('scrolls the root itself when it is the overflowing region (chat bubble)', () => {
    const root = region();
    const leaf = document.createElement('code');
    root.append(leaf);
    makeHorizontallyScrollable(root);
    const event = wheel({ deltaY: 40 });

    expect(consumeVerticalWheelInRegion(root, leaf, event)).toBe(true);
    expect(root.scrollLeft).toBe(40);
  });

  it('lets a nested vertical scroller keep the wheel', () => {
    const { root, outer, inner, leaf } = nested();
    makeHorizontallyScrollable(outer);
    makeVerticallyScrollable(inner, { scrollTop: 50 });
    const event = wheel({ deltaY: 90 });

    expect(consumeVerticalWheelInRegion(root, leaf, event)).toBe(false);
    expect(outer.scrollLeft).toBe(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('falls through to the horizontal ancestor once that vertical scroller bottoms out', () => {
    const { root, outer, inner, leaf } = nested();
    makeHorizontallyScrollable(outer);
    makeVerticallyScrollable(inner, { scrollTop: 300 }); // at the end
    const event = wheel({ deltaY: 90 });

    expect(consumeVerticalWheelInRegion(root, leaf, event)).toBe(true);
    expect(outer.scrollLeft).toBe(90);
  });

  it('starts at the root when the event target is outside it', () => {
    const { root, outer } = nested();
    root.setAttribute(WHEEL_SCROLL_X_ATTR, '');
    makeHorizontallyScrollable(root);
    makeHorizontallyScrollable(outer);
    const stray = document.createElement('div');
    document.body.append(stray);
    const event = wheel({ deltaY: 40 });

    expect(consumeVerticalWheelInRegion(root, stray, event)).toBe(true);
    expect(root.scrollLeft).toBe(40);
    expect(outer.scrollLeft).toBe(0);
  });

  it('does not touch anything for a non-convertible wheel', () => {
    const { root, inner, leaf } = nested();
    makeHorizontallyScrollable(inner);
    const event = wheel({ shiftKey: true });

    expect(consumeVerticalWheelInRegion(root, leaf, event)).toBe(false);
    expect(inner.scrollLeft).toBe(0);
  });
});

describe('attachHorizontalWheelDelegation', () => {
  function dispatchWheel(el: Element, init: WheelEventInit = {}): WheelEvent {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 0,
      deltaY: 100,
      ...init,
    });
    el.dispatchEvent(event);
    return event;
  }

  it('handles every region in the subtree with a single listener', () => {
    const root = document.createElement('div');
    const codeBlock = region('pre');
    const tableWrap = region();
    const cell = document.createElement('td');
    tableWrap.append(cell);
    root.append(codeBlock, tableWrap);
    document.body.append(root);
    makeHorizontallyScrollable(codeBlock);
    makeHorizontallyScrollable(tableWrap);

    const detach = attachHorizontalWheelDelegation(root);

    expect(dispatchWheel(codeBlock).defaultPrevented).toBe(true);
    expect(codeBlock.scrollLeft).toBe(100);
    expect(dispatchWheel(cell).defaultPrevented).toBe(true);
    expect(tableWrap.scrollLeft).toBe(100);

    detach();
    expect(dispatchWheel(codeBlock).defaultPrevented).toBe(false);
    expect(codeBlock.scrollLeft).toBe(100);
  });

  it('never double-scrolls when delegated roots are nested', () => {
    const outerRoot = document.createElement('div');
    const innerRoot = region();
    const leaf = document.createElement('span');
    innerRoot.append(leaf);
    outerRoot.append(innerRoot);
    document.body.append(outerRoot);
    makeHorizontallyScrollable(innerRoot);

    const detachOuter = attachHorizontalWheelDelegation(outerRoot);
    const detachInner = attachHorizontalWheelDelegation(innerRoot);

    dispatchWheel(leaf, { deltaY: 60 });

    expect(innerRoot.scrollLeft).toBe(60);
    detachInner();
    detachOuter();
  });

  it('leaves shift+wheel and trackpad deltas to the browser', () => {
    const root = region();
    const leaf = document.createElement('span');
    root.append(leaf);
    document.body.append(root);
    makeHorizontallyScrollable(root);
    const detach = attachHorizontalWheelDelegation(root);

    expect(dispatchWheel(leaf, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatchWheel(leaf, { deltaX: -30, deltaY: 8 }).defaultPrevented).toBe(false);
    expect(root.scrollLeft).toBe(0);

    detach();
  });
});

describe('wheelGestureAxis', () => {
  const at = (axis: WheelGesture['axis'], time: number): WheelGesture => ({ axis, at: time });
  const delta = (deltaX: number, deltaY: number) => ({ deltaX, deltaY });

  it('starts a vertical gesture when vertical movement dominates or ties', () => {
    expect(wheelGestureAxis(delta(0, 40), null, 0).axis).toBe('y');
    expect(wheelGestureAxis(delta(30, 300), null, 0).axis).toBe('y');
    expect(wheelGestureAxis(delta(20, 20), null, 0).axis).toBe('y');
  });

  it('starts a sideways gesture only when sideways clearly dominates (1.5×)', () => {
    expect(wheelGestureAxis(delta(300, 20), null, 0).axis).toBe('x');
    expect(wheelGestureAxis(delta(-31, 20), null, 0).axis).toBe('x');
    expect(wheelGestureAxis(delta(29, 20), null, 0).axis).toBe('y');
  });

  it('keeps a vertical gesture vertical while it drifts sideways', () => {
    let gesture = wheelGestureAxis(delta(2, 40), null, 0);
    for (const [step, [dx, dy]] of [
      [8, 30],
      [25, 12],
      [40, 4],
    ].entries()) {
      gesture = wheelGestureAxis(delta(dx, dy), gesture, 16 * (step + 1));
      expect(gesture).toEqual(at('y', 16 * (step + 1)));
    }
  });

  it('lets a new gesture after a pause pick sideways', () => {
    const vertical = wheelGestureAxis(delta(0, 40), null, 0);
    expect(wheelGestureAxis(delta(60, 2), vertical, 100).axis).toBe('y');
    expect(wheelGestureAxis(delta(60, 2), at('y', 100), 260).axis).toBe('x');
  });
});

describe('lockWheelToAxis', () => {
  /** page (scrolls vertically) > root > table(region) > cell, as a doc nests. */
  function docPage() {
    const page = document.createElement('div');
    const root = document.createElement('div');
    const table = document.createElement('div');
    const cell = document.createElement('td');
    page.append(root);
    root.append(table);
    table.append(cell);
    document.body.append(page);
    makeVerticallyScrollable(page, { clientHeight: 300, scrollHeight: 2000, scrollTop: 400 });
    makeHorizontallyScrollable(table);
    table.style.overflowX = 'auto';
    return { page, root, table, cell };
  }

  it('scrolls the page only for a vertical gesture that drifts sideways', () => {
    const { page, root, table, cell } = docPage();
    const event = wheel({ deltaX: 30, deltaY: 300 });
    expect(lockWheelToAxis(root, cell, event, 'y')).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(page.scrollTop).toBe(700);
    expect(table.scrollLeft).toBe(0);
  });

  it('leaves a purely vertical wheel to the browser, and never turns it sideways', () => {
    const { page, root, table, cell } = docPage();
    const event = wheel({ deltaX: 0, deltaY: 300 });
    expect(lockWheelToAxis(root, cell, event, 'y')).toBe(false);
    expect(consumeVerticalWheelInRegion(root, cell, event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(table.scrollLeft).toBe(0);
    expect(page.scrollTop).toBe(400);
  });

  it('scrolls the table only for a sideways gesture that drifts vertically', () => {
    const { page, root, table, cell } = docPage();
    const event = wheel({ deltaX: 300, deltaY: 20 });
    expect(lockWheelToAxis(root, cell, event, 'x')).toBe(true);
    expect(table.scrollLeft).toBe(300);
    expect(page.scrollTop).toBe(400);
  });

  it('keeps the page still for a sideways gesture with the table at its edge', () => {
    const { page, root, table, cell } = docPage();
    table.scrollLeft = 600;
    const event = wheel({ deltaX: 50, deltaY: 20 });
    expect(lockWheelToAxis(root, cell, event, 'x')).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(table.scrollLeft).toBe(600);
    expect(page.scrollTop).toBe(400);
  });

  it('lets a nested vertical scroller under the pointer take the vertical part first', () => {
    const { page, root, cell } = docPage();
    const note = document.createElement('div');
    cell.append(note);
    makeVerticallyScrollable(note, { scrollTop: 0 });
    expect(lockWheelToAxis(root, note, wheel({ deltaX: 10, deltaY: 60 }), 'y')).toBe(true);
    expect(note.scrollTop).toBe(60);
    expect(page.scrollTop).toBe(400);
  });

  it('leaves Shift, zoom and on-axis wheels to the browser', () => {
    const { root, table, cell } = docPage();
    for (const event of [
      wheel({ deltaX: 0, deltaY: 100, shiftKey: true }),
      wheel({ deltaX: 5, deltaY: 100, ctrlKey: true }),
      wheel({ deltaX: 5, deltaY: 100, metaKey: true }),
      wheel({ deltaX: 120, deltaY: 0 }),
    ]) {
      expect(lockWheelToAxis(root, cell, event, event.deltaY ? 'y' : 'x')).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(table.scrollLeft).toBe(0);
  });

  it('does nothing away from a sideways region, or for one outside vertical scrolling', () => {
    const { root } = docPage();
    const paragraph = document.createElement('p');
    root.append(paragraph);
    expect(lockWheelToAxis(root, paragraph, wheel({ deltaX: 30, deltaY: 300 }), 'y')).toBe(false);

    const strip = region();
    const leaf = document.createElement('span');
    strip.append(leaf);
    document.body.append(strip);
    makeHorizontallyScrollable(strip);
    expect(lockWheelToAxis(strip, leaf, wheel({ deltaX: 30, deltaY: 300 }), 'y')).toBe(false);
  });
});

describe('attachHorizontalWheelDelegation in a vertically scrolling page', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps each gesture on its axis, and a later sideways gesture moves the table', () => {
    vi.useFakeTimers({ now: 10_000 });
    const page = document.createElement('div');
    const table = region();
    const cell = document.createElement('td');
    table.append(cell);
    page.append(table);
    document.body.append(page);
    makeVerticallyScrollable(page, { clientHeight: 300, scrollHeight: 3000 });
    makeHorizontallyScrollable(table);
    const detach = attachHorizontalWheelDelegation(page);
    const send = (deltaX: number, deltaY: number) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY });
      cell.dispatchEvent(event);
      vi.advanceTimersByTime(16);
      return event;
    };

    // A downward swipe whose drift grows past its vertical movement.
    send(0, 120);
    send(20, 60);
    send(40, 10);
    expect(table.scrollLeft).toBe(0);
    expect(page.scrollTop).toBe(70);

    vi.advanceTimersByTime(300);
    send(200, 10);
    send(150, 30);
    expect(table.scrollLeft).toBe(350);
    expect(page.scrollTop).toBe(70);
    detach();
  });

  it('leaves a Shift+wheel out of the gesture, so plain wheels after it scroll the page', () => {
    vi.useFakeTimers({ now: 10_000 });
    const page = document.createElement('div');
    const table = region();
    const cell = document.createElement('td');
    table.append(cell);
    page.append(table);
    document.body.append(page);
    makeVerticallyScrollable(page, { clientHeight: 300, scrollHeight: 3000 });
    makeHorizontallyScrollable(table);
    const detach = attachHorizontalWheelDelegation(page);
    const send = (init: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
      cell.dispatchEvent(event);
      vi.advanceTimersByTime(40);
      return event;
    };

    expect(send({ deltaY: 100, shiftKey: true }).defaultPrevented).toBe(false);
    // Purely vertical: the browser scrolls the page.
    expect(send({ deltaY: 100 }).defaultPrevented).toBe(false);
    // Drifting sideways: still the page, never the table.
    for (let i = 0; i < 3; i++) send({ deltaX: 8, deltaY: 100 });
    expect(page.scrollTop).toBe(300);
    expect(table.scrollLeft).toBe(0);
    detach();
  });
});
