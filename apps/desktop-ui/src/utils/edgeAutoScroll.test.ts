import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEdgeAutoScroller } from './edgeAutoScroll';

let frames: FrameRequestCallback[];
let scrollLeft: number;

/**
 * With `smooth`, the scroller behaves like Snaglet's global `scroll-behavior:
 * smooth`: an assignment only lands synchronously when the element's own
 * behavior is `auto`.
 */
function scroller({ smooth = false } = {}): HTMLElement {
  const el = document.createElement('div');
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 100));
  Object.defineProperty(el, 'scrollLeft', {
    get: () => scrollLeft,
    set: (value: number) => {
      if (smooth && el.style.scrollBehavior !== 'auto') return;
      scrollLeft = Math.max(0, value);
    },
  });
  return el;
}

function runFrame() {
  const frame = frames.shift();
  frame?.(0);
}

beforeEach(() => {
  frames = [];
  scrollLeft = 100;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    frames = [];
  });
});

afterEach(() => vi.restoreAllMocks());

describe('createEdgeAutoScroller', () => {
  it('keeps scrolling while the pointer rests near an edge, faster closer to it', () => {
    const onScroll = vi.fn();
    const auto = createEdgeAutoScroller(scroller(), { axis: 'x', onScroll });
    auto.update(290, 50);
    runFrame();
    const firstStep = scrollLeft - 100;
    expect(firstStep).toBeGreaterThan(0);
    // No further pointer movement: the loop carries on by itself.
    runFrame();
    expect(scrollLeft - 100).toBeCloseTo(firstStep * 2);
    expect(onScroll).toHaveBeenCalledTimes(2);

    auto.update(250, 50);
    const before = scrollLeft;
    runFrame();
    expect(scrollLeft - before).toBeLessThan(firstStep);
  });

  it('scrolls immediately under smooth scrolling, so each step re-targets the drag', () => {
    const onScroll = vi.fn();
    const el = scroller({ smooth: true });
    el.style.scrollBehavior = 'smooth';
    const auto = createEdgeAutoScroller(el, { axis: 'x', onScroll });
    auto.update(290, 50);
    runFrame();
    expect(scrollLeft).toBeGreaterThan(100);
    expect(onScroll).toHaveBeenCalledTimes(1);
    // The element's own behavior is restored after the step.
    expect(el.style.scrollBehavior).toBe('smooth');
  });

  it('scrolls back from the leading edge and stops outside the zones', () => {
    const auto = createEdgeAutoScroller(scroller(), { axis: 'x' });
    auto.update(5, 50);
    runFrame();
    expect(scrollLeft).toBeLessThan(100);
    auto.update(150, 50);
    const settled = scrollLeft;
    runFrame();
    expect(scrollLeft).toBe(settled);
    expect(frames).toHaveLength(0);
  });

  it('does nothing outside the zones and cancels on stop', () => {
    const auto = createEdgeAutoScroller(scroller(), { axis: 'x' });
    auto.update(150, 50);
    expect(frames).toHaveLength(0);
    auto.update(295, 50);
    expect(frames).toHaveLength(1);
    auto.stop();
    expect(frames).toHaveLength(0);
    expect(scrollLeft).toBe(100);
  });
});
