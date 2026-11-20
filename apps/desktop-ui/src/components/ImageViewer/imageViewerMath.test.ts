import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  ZOOM_STEP,
  canPan,
  clampScale,
  clampView,
  detailScale,
  fitScale,
  fittedView,
  isAtFit,
  panView,
  recenterView,
  stepScale,
  wheelDeltaPx,
  wheelZoomFactor,
  zoomAround,
} from './imageViewerMath';

const BOX = { width: 800, height: 600 };
const LARGE = { width: 1600, height: 900 };
const SMALL = { width: 200, height: 100 };

describe('fitScale', () => {
  it('shrinks a large image to fit the box, limited by the tighter axis', () => {
    expect(fitScale(LARGE, BOX)).toBeCloseTo(0.5, 10);
    expect(fitScale({ width: 600, height: 1200 }, BOX)).toBeCloseTo(0.5, 10);
  });

  it('never upscales a small image past its actual size', () => {
    expect(fitScale(SMALL, BOX)).toBe(1);
  });

  it('leaves the padding on every side', () => {
    expect(fitScale(LARGE, BOX, 50)).toBeCloseTo(700 / 1600, 10);
  });

  it('may grow a small image up to a raised fit cap, never past it', () => {
    expect(fitScale(SMALL, BOX, 0, 2)).toBe(2);
    expect(fitScale(LARGE, BOX, 0, 2)).toBeCloseTo(0.5, 10);
  });

  it('shrinks the padding on a cramped box instead of eating it', () => {
    expect(fitScale(LARGE, { width: 80, height: 60 }, 50)).toBeGreaterThan(0);
  });

  it('falls back to 1 without sizes', () => {
    expect(fitScale({ width: 0, height: 0 }, BOX)).toBe(1);
    expect(fitScale(LARGE, { width: 0, height: 600 })).toBe(1);
  });
});

describe('clampScale', () => {
  it('keeps the scale between fit and 8×', () => {
    expect(clampScale(0.1, 0.5)).toBe(0.5);
    expect(clampScale(20, 0.5)).toBe(MAX_SCALE);
    expect(clampScale(2, 0.5)).toBe(2);
    expect(clampScale(Number.NaN, 0.5)).toBe(0.5);
  });
});

describe('clampView', () => {
  it('centers an axis the image does not fill', () => {
    expect(clampView({ scale: 1, x: -500, y: 999 }, SMALL, BOX)).toEqual({
      scale: 1,
      x: 300,
      y: 250,
    });
  });

  it('keeps an overflowing image covering the box, so it never leaves view', () => {
    // 1600×900 at 1× in an 800×600 box: x ∈ [−800, 0], y ∈ [−300, 0].
    expect(clampView({ scale: 1, x: 100, y: 100 }, LARGE, BOX)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampView({ scale: 1, x: -5000, y: -5000 }, LARGE, BOX)).toEqual({
      scale: 1,
      x: -800,
      y: -300,
    });
    expect(clampView({ scale: 1, x: -400, y: -150 }, LARGE, BOX)).toEqual({
      scale: 1,
      x: -400,
      y: -150,
    });
  });
});

describe('fittedView / canPan / isAtFit', () => {
  it('fits and centers the whole image', () => {
    const view = fittedView(LARGE, BOX);
    expect(view.scale).toBeCloseTo(0.5, 10);
    expect(view.x).toBeCloseTo(0, 10);
    expect(view.y).toBeCloseTo((600 - 450) / 2, 10);
    expect(canPan(view, LARGE, BOX)).toBe(false);
    expect(isAtFit(view.scale, fitScale(LARGE, BOX))).toBe(true);
  });

  it('can pan only once the image overflows an axis', () => {
    expect(canPan({ scale: 1, x: 0, y: 0 }, LARGE, BOX)).toBe(true);
    expect(canPan({ scale: 2, x: 0, y: 0 }, SMALL, BOX)).toBe(false);
    expect(canPan({ scale: 5, x: 0, y: 0 }, SMALL, BOX)).toBe(true);
  });
});

describe('zoomAround', () => {
  it('keeps the image point under the anchor where it was', () => {
    const fit = fitScale(LARGE, BOX);
    const start = fittedView(LARGE, BOX);
    const anchor = { x: 200, y: 300 };
    const imagePoint = {
      x: (anchor.x - start.x) / start.scale,
      y: (anchor.y - start.y) / start.scale,
    };
    const next = zoomAround(start, 2, anchor, LARGE, BOX, fit);
    expect(next.scale).toBe(2);
    expect(next.x + imagePoint.x * next.scale).toBeCloseTo(anchor.x, 6);
    expect(next.y + imagePoint.y * next.scale).toBeCloseTo(anchor.y, 6);
  });

  it('clamps to fit…8× and keeps the result in view', () => {
    const fit = fitScale(LARGE, BOX);
    const start = fittedView(LARGE, BOX);
    expect(zoomAround(start, 0.01, { x: 0, y: 0 }, LARGE, BOX, fit)).toEqual(start);
    const max = zoomAround(start, 100, { x: 799, y: 599 }, LARGE, BOX, fit);
    expect(max.scale).toBe(MAX_SCALE);
    expect(max.x).toBeLessThanOrEqual(0);
    expect(max.x).toBeGreaterThanOrEqual(BOX.width - LARGE.width * MAX_SCALE);
  });
});

describe('panView', () => {
  it('moves an overflowing image and stops at its edges', () => {
    const view = { scale: 1, x: -400, y: -150 };
    expect(panView(view, 100, -50, LARGE, BOX)).toEqual({ scale: 1, x: -300, y: -200 });
    expect(panView(view, 10_000, 10_000, LARGE, BOX)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('does not move a fitted image', () => {
    const view = fittedView(LARGE, BOX);
    expect(panView(view, 100, 100, LARGE, BOX)).toEqual(view);
  });
});

describe('stepScale', () => {
  it('steps by 1.25× and clamps to fit…8×', () => {
    expect(stepScale(2, 1, 0.5)).toBeCloseTo(2 * ZOOM_STEP, 10);
    expect(stepScale(2, -1, 0.5)).toBeCloseTo(2 / ZOOM_STEP, 10);
    expect(stepScale(0.55, -1, 0.5)).toBe(0.5);
    expect(stepScale(7.5, 1, 0.5)).toBe(MAX_SCALE);
  });

  it('stops on actual size when a step would cross it', () => {
    expect(stepScale(0.9, 1, 0.5)).toBe(1);
    expect(stepScale(1.1, -1, 0.5)).toBe(1);
    expect(stepScale(1, 1, 0.5)).toBeCloseTo(ZOOM_STEP, 10);
  });
});

describe('detailScale', () => {
  it('is 2× fit, or actual size when that is larger', () => {
    expect(detailScale(1)).toBe(2);
    expect(detailScale(0.8)).toBeCloseTo(1.6, 10);
    expect(detailScale(0.1)).toBe(1);
  });
});

describe('wheel helpers', () => {
  it('turns line and page deltas into px', () => {
    expect(wheelDeltaPx(3, 0, 600)).toBe(3);
    expect(wheelDeltaPx(3, 1, 600)).toBe(48);
    expect(wheelDeltaPx(1, 2, 600)).toBe(600);
  });

  it('zooms in on a negative delta and out on a positive one, continuously', () => {
    expect(wheelZoomFactor(-4)).toBeGreaterThan(1);
    expect(wheelZoomFactor(4)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(Number.NaN)).toBe(1);
  });

  it('caps a detented notch near one key step', () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(wheelZoomFactor(-25), 10);
    expect(wheelZoomFactor(-100)).toBeLessThan(1.3);
  });
});

describe('recenterView', () => {
  it('keeps the centered image point centered across a resize', () => {
    const view = { scale: 2, x: -1000, y: -600 };
    const next = recenterView(view, LARGE, BOX, { width: 1000, height: 700 });
    const before = { x: (400 - view.x) / 2, y: (300 - view.y) / 2 };
    expect((500 - next.x) / next.scale).toBeCloseTo(before.x, 6);
    expect((350 - next.y) / next.scale).toBeCloseTo(before.y, 6);
  });
});
