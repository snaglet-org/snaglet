import { describe, expect, it } from 'vitest';
import {
  centerOn,
  clampMinutePx,
  clampTop,
  DAY_MIN,
  DEFAULT_MINUTE_PX,
  FALLBACK_FIT_PX,
  fitMinutePx,
  isFit,
  labelStepFor,
  MAX_MINUTE_PX,
  minDurationFor,
  panBy,
  parseStoredZoom,
  renderWindow,
  resizeWindow,
  runTimes,
  showsDots,
  snapMinutes,
  snapStepFor,
  tickStepFor,
  windowOf,
  zoomAbout,
  zoomAboutCenter,
} from './timeScale';

const MINUTE = 60_000;

describe('scale range', () => {
  it('defaults to 48 px an hour', () => {
    expect(DEFAULT_MINUTE_PX * 60).toBe(48);
  });

  it('fit is the whole day in the visible times, never past the max', () => {
    expect(fitMinutePx(720)).toBe(0.5);
    expect(fitMinutePx(DAY_MIN * 20)).toBe(MAX_MINUTE_PX);
    expect(fitMinutePx(null)).toBe(FALLBACK_FIT_PX);
    expect(fitMinutePx(0)).toBe(FALLBACK_FIT_PX);
  });

  it('clamps a scale between fit and 12 px a minute', () => {
    expect(clampMinutePx(0.1, 0.5)).toBe(0.5);
    expect(clampMinutePx(40, 0.5)).toBe(MAX_MINUTE_PX);
    expect(clampMinutePx(2, 0.5)).toBe(2);
    expect(clampMinutePx(Number.NaN, 0.5)).toBe(0.5);
    expect(isFit(0.5, 0.5)).toBe(true);
    expect(isFit(0.6, 0.5)).toBe(false);
  });

  it('reads the stored zoom: a scale, "fit", else the default', () => {
    expect(parseStoredZoom('2.5')).toBe(2.5);
    expect(parseStoredZoom('fit')).toBe('fit');
    expect(parseStoredZoom('99')).toBe(MAX_MINUTE_PX);
    expect(parseStoredZoom(null)).toBe(DEFAULT_MINUTE_PX);
    expect(parseStoredZoom('-1')).toBe(DEFAULT_MINUTE_PX);
    expect(parseStoredZoom('wide')).toBe(DEFAULT_MINUTE_PX);
  });
});

describe('zoom about a point', () => {
  const visible = 600;

  it('keeps the minute under the pointer where it was', () => {
    const view = { px: 1, top: 480 }; // 8 AM at the top
    const next = zoomAbout(view, 2, 300, 0.25, visible); // pointer 300 px down: 1 PM
    expect(next.px).toBe(2);
    expect(next.top + 300 / next.px).toBe(780);
    const out = zoomAbout(view, 0.5, 300, 0.25, visible);
    expect(out.top + 300 / out.px).toBeCloseTo(780);
  });

  it('stops at fit and at the max, and at the day’s edges', () => {
    const view = { px: 1, top: 480 };
    expect(zoomAbout(view, 0.01, 300, 600 / DAY_MIN, visible)).toEqual({
      px: 600 / DAY_MIN,
      top: 0,
    });
    expect(zoomAbout(view, 100, 300, 0.25, visible).px).toBe(MAX_MINUTE_PX);
    // Near midnight the end of the day stops it: the top can't pass 24:00 − span.
    const late = zoomAbout({ px: 2, top: 1140 }, 1, 0, 0.25, visible);
    expect(late.top).toBe(DAY_MIN - visible);
  });

  it('zooms about the middle for keys', () => {
    const next = zoomAboutCenter({ px: 1, top: 480 }, 2, 0.25, visible);
    expect(next.top + 300 / 2).toBe(780);
  });

  it('keeps the top inside the day; unmeasured, only above midnight', () => {
    expect(clampTop(-5, 1, visible)).toBe(0);
    expect(clampTop(2000, 1, visible)).toBe(DAY_MIN - 600);
    expect(clampTop(2000, 1, null)).toBe(DAY_MIN);
    expect(clampTop(900, 1, null)).toBe(900);
  });
});

describe('detail follows the scale', () => {
  it('snaps 15 minutes at the default, 5 zoomed in, 1 far in', () => {
    expect(snapStepFor(DEFAULT_MINUTE_PX)).toBe(15);
    expect(snapStepFor(0.3)).toBe(15);
    expect(snapStepFor(1.99)).toBe(15);
    expect(snapStepFor(2)).toBe(5); // 10 px a step
    expect(snapStepFor(9.9)).toBe(5);
    expect(snapStepFor(10)).toBe(1);
    expect(snapStepFor(MAX_MINUTE_PX)).toBe(1);
    expect(snapMinutes(622, 15)).toBe(615);
    expect(snapMinutes(622, 5)).toBe(620);
    expect(snapMinutes(622, 1)).toBe(622);
    expect(minDurationFor(15)).toBe(15);
    expect(minDurationFor(5)).toBe(5);
    expect(minDurationFor(1)).toBe(5);
  });

  it('adds ruler ticks and labels as room allows; hours only at the default', () => {
    expect(labelStepFor(DEFAULT_MINUTE_PX)).toBe(60);
    expect(tickStepFor(DEFAULT_MINUTE_PX)).toBe(15);
    expect(labelStepFor(1)).toBe(30);
    expect(labelStepFor(2)).toBe(15);
    expect(labelStepFor(6)).toBe(5);
    expect(labelStepFor(MAX_MINUTE_PX)).toBe(5);
    expect(tickStepFor(0.3)).toBe(30);
    expect(tickStepFor(2)).toBe(5);
    expect(tickStepFor(8)).toBe(1);
    expect(tickStepFor(0.1)).toBe(60);
  });

  it('draws dots once runs are a dot and a gap apart, else a line', () => {
    expect(showsDots(15 * MINUTE, DEFAULT_MINUTE_PX)).toBe(true); // 12 px
    expect(showsDots(10 * MINUTE, DEFAULT_MINUTE_PX)).toBe(false); // 8 px
    expect(showsDots(15 * MINUTE, 0.5)).toBe(false);
    expect(showsDots(MINUTE, MAX_MINUTE_PX)).toBe(true);
    expect(showsDots(MINUTE, 11)).toBe(false);
    expect(showsDots(0, MAX_MINUTE_PX)).toBe(false);
  });
});

describe('Every runs', () => {
  const anchor = Date.UTC(2026, 9, 14, 9, 0);

  it('lists the anchor plus whole steps inside the range, none before the anchor', () => {
    const runs = runTimes(anchor, 15 * MINUTE, anchor - 60 * MINUTE, anchor + 46 * MINUTE);
    expect(runs).toEqual([0, 15, 30, 45].map((m) => anchor + m * MINUTE));
    const later = runTimes(anchor, 15 * MINUTE, anchor + 20 * MINUTE, anchor + 50 * MINUTE);
    expect(later).toEqual([30, 45].map((m) => anchor + m * MINUTE));
  });

  it('works out only the range asked for, and caps it', () => {
    const everyMinute = runTimes(anchor, MINUTE, anchor + 600 * MINUTE, anchor + 660 * MINUTE);
    expect(everyMinute).toHaveLength(60);
    expect(runTimes(anchor, MINUTE, anchor, anchor + 10_000 * MINUTE, 50)).toHaveLength(50);
    expect(runTimes(anchor, 0, anchor, anchor + MINUTE)).toEqual([]);
    expect(runTimes(anchor, MINUTE, anchor + MINUTE, anchor)).toEqual([]);
  });

  it('draws around the visible range in steps, so small scrolls don’t redraw', () => {
    expect(renderWindow({ from: 780, to: 900 })).toEqual({ from: 720, to: 960 });
    expect(renderWindow({ from: 790, to: 910 })).toEqual({ from: 720, to: 990 });
    expect(renderWindow({ from: 0, to: DAY_MIN })).toEqual({ from: 0, to: DAY_MIN });
    expect(renderWindow({ from: 600, to: 640 })).toEqual({ from: 570, to: 660 });
  });
});

describe('overview window', () => {
  const visible = 600;

  it('is the visible range', () => {
    expect(windowOf({ px: 1, top: 480 }, visible)).toEqual({ from: 480, to: 1080 });
    expect(windowOf({ px: 1, top: 480 }, null)).toEqual({ from: 480, to: 1200 });
  });

  it('pans and centers inside the day', () => {
    expect(panBy({ px: 1, top: 480 }, 60, visible)).toEqual({ px: 1, top: 540 });
    expect(panBy({ px: 1, top: 480 }, 5000, visible).top).toBe(DAY_MIN - 600);
    expect(centerOn(720, { px: 1, top: 0 }, visible)).toEqual({ px: 1, top: 420 });
    expect(centerOn(10, { px: 1, top: 480 }, visible).top).toBe(0);
  });

  it('dragging the bottom edge up zooms in about the top; the top edge, about the bottom', () => {
    const view = { px: 1, top: 480 }; // 8 AM – 6 PM
    const smaller = resizeWindow('bottom', 780, view, 0.25, visible); // 8 AM – 1 PM
    expect(smaller.px).toBe(2);
    expect(smaller.top).toBe(480);
    const fromTop = resizeWindow('top', 780, view, 0.25, visible); // 1 PM – 6 PM
    expect(fromTop.px).toBe(2);
    expect(fromTop.top).toBe(780);
  });

  it('a full-height window is fit; the smallest is the max scale', () => {
    const fit = visible / DAY_MIN;
    const view = { px: 1, top: 480 };
    const grown = resizeWindow(
      'bottom',
      DAY_MIN,
      resizeWindow('top', 0, view, fit, visible),
      fit,
      visible
    );
    expect(isFit(grown.px, fit)).toBe(true);
    expect(grown.top).toBe(0);
    const tiny = resizeWindow('bottom', 481, view, fit, visible);
    expect(tiny.px).toBe(MAX_MINUTE_PX);
    expect(tiny.top).toBe(480);
  });
});
