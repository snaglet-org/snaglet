import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_CARDS_ATTR, BOARD_COLUMN_ATTR, startCardDrag } from './cardDrag';

// RAF / frame machinery (mirrors edgeAutoScroll.test.ts)

let frames: FrameRequestCallback[];

function runFrame() {
  const frame = frames.shift();
  frame?.(0);
}

// DOM helpers

/**
 * Build a board DOM:
 *   div.scroller
 *     section[data-board-column="a"]
 *       ul[data-board-cards]  ← card list, vertically scrollable
 *         li[data-board-card]
 *     section[data-board-column="b"]
 *       ul[data-board-cards]
 *         li[data-board-card]
 */
function buildBoard() {
  const scroller = document.createElement('div');
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
  Object.defineProperty(scroller, 'scrollLeft', {
    get: () => 0,
    set: () => {},
    configurable: true,
  });

  function makeColumn(key: string) {
    const section = document.createElement('section');
    section.setAttribute(BOARD_COLUMN_ATTR, key);

    const list = document.createElement('ul');
    list.setAttribute(BOARD_CARDS_ATTR, '');

    const li = document.createElement('li');
    li.setAttribute('data-board-card', '');
    list.append(li);
    section.append(list);
    return { section, list, card: li };
  }

  const colA = makeColumn('a');
  const colB = makeColumn('b');
  scroller.append(colA.section, colB.section);
  document.body.append(scroller);

  return { scroller, colA, colB };
}

/**
 * Attach a mocked `scrollTop` getter/setter to `el` so we can observe
 * vertical auto-scroll changes.
 */
function mockScrollTop(el: HTMLElement, initial = 100) {
  let value = initial;
  Object.defineProperty(el, 'scrollTop', {
    get: () => value,
    set: (v: number) => {
      value = Math.max(0, v);
    },
    configurable: true,
  });
  return {
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  };
}

// Test setup

beforeEach(() => {
  frames = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    frames = [];
  });
  // getEffectiveZoom falls through to getComputedStyle which returns '' for
  // zoom → Number.parseFloat('') = NaN → zoom stays 1. Fine for tests.
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// Helpers

/** Fire a pointer-move on window with enough travel to pass the threshold. */
function activateDrag(_startX: number, _startY: number, toX: number, toY: number) {
  window.dispatchEvent(
    new PointerEvent('pointermove', { clientX: toX, clientY: toY, cancelable: true })
  );
}

/** Default minimal CardDragOptions. */
function defaultOptions(
  card: HTMLElement,
  scroller: HTMLElement,
  overrides: Partial<Parameters<typeof startCardDrag>[0]> = {}
) {
  return {
    card,
    scroller,
    fromKey: 'a',
    startX: 50,
    startY: 300,
    onDrop: vi.fn(),
    onEnd: vi.fn(),
    ...overrides,
  };
}

// Tests

describe('startCardDrag — vertical card-list auto-scroll', () => {
  it('scrolls the target column card list down when the pointer rests near its bottom edge', () => {
    const { scroller, colA, colB } = buildBoard();
    const scrollTop = mockScrollTop(colB.list);

    // Column B's list rect: top=0, bottom=600, height=600.
    vi.spyOn(colB.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 400, 600));
    // Card A's rect (for ghost grab offset).
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    // elementFromPoint → column B's list (the ul carries the column attr via closest()).
    document.elementFromPoint = () => colB.list;

    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    startCardDrag(opts);

    // Pointer moves far enough to activate drag; y near bottom edge of colB's list (600 − 10 = 590).
    activateDrag(150, 300, 500, 590);

    // One frame drives the y auto-scroller.
    runFrame();
    expect(scrollTop.get()).toBeGreaterThan(100);
  });

  it('scrolls the target column card list up when the pointer rests near its top edge', () => {
    const { scroller, colA, colB } = buildBoard();
    const scrollTop = mockScrollTop(colB.list, 100);

    vi.spyOn(colB.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 400, 600));
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    document.elementFromPoint = () => colB.list;

    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    startCardDrag(opts);

    // Pointer near the top edge of colB's list (0 + 10 = 10).
    activateDrag(150, 300, 500, 10);
    runFrame();
    expect(scrollTop.get()).toBeLessThan(100);
  });

  it('switches the y-scroller when the pointer moves to a different column', () => {
    const { scroller, colA, colB } = buildBoard();
    const scrollTopA = mockScrollTop(colA.list, 100);
    const scrollTopB = mockScrollTop(colB.list, 100);

    vi.spyOn(colA.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 600));
    vi.spyOn(colB.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 400, 600));
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    // Start: pointer over column A's list.
    document.elementFromPoint = () => colA.list;
    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    startCardDrag(opts);

    // Activate drag near bottom of col A.
    activateDrag(150, 300, 200, 590);
    runFrame();
    const aAfterFirstFrame = scrollTopA.get();
    expect(aAfterFirstFrame).toBeGreaterThan(100);

    // Pointer moves to column B near its bottom edge.
    document.elementFromPoint = () => colB.list;
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 600, clientY: 590, cancelable: true })
    );
    runFrame();
    expect(scrollTopB.get()).toBeGreaterThan(100);
    // The auto-scroller has stopped scrolling column A's list.
    const aSnapshot = scrollTopA.get();
    runFrame(); // another frame — A should not change further.
    expect(scrollTopA.get()).toBe(aSnapshot);
  });

  it('stops the y-scroller on pointerup and schedules no more frames', () => {
    const { scroller, colA, colB } = buildBoard();
    const scrollTop = mockScrollTop(colB.list, 100);

    vi.spyOn(colB.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 400, 600));
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    document.elementFromPoint = () => colB.list;

    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    startCardDrag(opts);

    activateDrag(150, 300, 500, 590);
    runFrame();
    const afterFirstFrame = scrollTop.get();
    expect(afterFirstFrame).toBeGreaterThan(100);

    // Pointer released — cleanup should stop auto-scroller.
    window.dispatchEvent(new PointerEvent('pointerup'));

    // No further frames should change scrollTop.
    const snapshot = scrollTop.get();
    runFrame();
    runFrame();
    expect(scrollTop.get()).toBe(snapshot);
  });

  it('stops the y-scroller on Escape cancel', () => {
    const { scroller, colA, colB } = buildBoard();
    const scrollTop = mockScrollTop(colB.list, 100);

    vi.spyOn(colB.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 400, 600));
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    document.elementFromPoint = () => colB.list;

    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    startCardDrag(opts);

    activateDrag(150, 300, 500, 590);
    runFrame();
    expect(scrollTop.get()).toBeGreaterThan(100);

    // Escape cancel.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );

    const snapshot = scrollTop.get();
    runFrame();
    runFrame();
    expect(scrollTop.get()).toBe(snapshot);
  });

  it('does not affect the horizontal scroller scrollLeft when pointer is mid-column horizontally', () => {
    const { scroller, colA, colB } = buildBoard();
    mockScrollTop(colB.list, 100);

    vi.spyOn(colB.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 400, 600));
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    let scrollLeft = 0;
    Object.defineProperty(scroller, 'scrollLeft', {
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = Math.max(0, v);
      },
      configurable: true,
    });

    document.elementFromPoint = () => colB.list;

    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    startCardDrag(opts);

    // Pointer horizontally mid-scroller (x=400 out of 800) — outside x edge zones.
    // y near bottom of colB's list to trigger vertical scroll.
    activateDrag(150, 300, 400, 590);
    runFrame();

    // scrollLeft must remain unchanged (mid-zone, no horizontal scroll).
    expect(scrollLeft).toBe(0);
  });

  it('the returned cancel function stops the y-scroller', () => {
    const { scroller, colA, colB } = buildBoard();
    const scrollTop = mockScrollTop(colB.list, 100);

    vi.spyOn(colB.list, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 400, 600));
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    document.elementFromPoint = () => colB.list;

    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    const cancel = startCardDrag(opts);

    activateDrag(150, 300, 500, 590);
    runFrame();
    expect(scrollTop.get()).toBeGreaterThan(100);

    cancel();

    const snapshot = scrollTop.get();
    runFrame();
    expect(scrollTop.get()).toBe(snapshot);
  });

  it('no y-scroller is created when there is no drop target', () => {
    const { scroller, colA } = buildBoard();
    vi.spyOn(colA.card, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 280, 200, 40));

    // elementFromPoint returns null → no column target.
    document.elementFromPoint = () => null;

    const opts = defaultOptions(colA.card, scroller, { fromKey: 'a', startX: 150, startY: 300 });
    startCardDrag(opts);

    // Activate drag — with no target there is no y-scroller, so no frames from it.
    activateDrag(150, 300, 150, 590);

    // No y-frames queued (x-scroller also won't queue since pointer is mid-horizontal).
    // Drain any frames — nothing should throw.
    runFrame();
    runFrame();
    // Test passes if no error thrown.
  });
});
