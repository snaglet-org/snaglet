import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZOOM_CHANGED_EVENT } from '@desktop/components/StatusBar/consumers/zoomWindow';
import {
  elementPxScale,
  fixedLayerScale,
  fixedLayerViewport,
  getEffectiveZoom,
  toElementPx,
  toFixedLayer,
} from './cssZoom';

afterEach(() => {
  vi.restoreAllMocks();
  // Drop the cached fixed-layer measurement between tests.
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT));
});

/**
 * Stand in for the engine's answer to the fixed-layer probes: `scale` rect px
 * per CSS px, and the viewport probe's size in rect px.
 */
function stubProbes(scale: number, viewport = { width: innerWidth, height: innerHeight }) {
  const original = Element.prototype.getBoundingClientRect;
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    const probe = this.getAttribute('data-fixed-layer-probe');
    if (probe === 'unit') return new DOMRect(100 * scale, 100 * scale, 100 * scale, 100 * scale);
    if (probe === 'viewport') return new DOMRect(0, 0, viewport.width, viewport.height);
    return original.call(this);
  });
}

describe('getEffectiveZoom', () => {
  it('is 1 for nothing and for an unzoomed element', () => {
    expect(getEffectiveZoom(null)).toBe(1);
    expect(getEffectiveZoom(undefined)).toBe(1);
    expect(getEffectiveZoom(document.createElement('div'))).toBe(1);
  });

  it('trusts the engine-provided currentCSSZoom when present', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'currentCSSZoom', { value: 0.56 });
    expect(getEffectiveZoom(el)).toBe(0.56);
  });

  it('otherwise multiplies the computed zoom of every ancestor', () => {
    const root = document.createElement('div');
    const pane = document.createElement('div');
    const leaf = document.createElement('span');
    root.append(pane);
    pane.append(leaf);
    const zooms = new Map<Element, string>([
      [root, '0.8'],
      [pane, '0.7'],
      [leaf, 'normal'],
    ]);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (node) => ({ zoom: zooms.get(node) ?? '' }) as CSSStyleDeclaration
    );
    expect(getEffectiveZoom(leaf)).toBeCloseTo(0.56, 10);
    expect(getEffectiveZoom(pane)).toBeCloseTo(0.56, 10);
    expect(getEffectiveZoom(root)).toBeCloseTo(0.8, 10);
  });
});

describe('elementPxScale / toElementPx', () => {
  function sized(rect: DOMRect, offsetWidth: number): HTMLElement {
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect);
    Object.defineProperty(el, 'offsetWidth', { value: offsetWidth });
    return el;
  }

  it('is identity where layout reports nothing (jsdom)', () => {
    const el = document.createElement('div');
    expect(elementPxScale(el)).toBe(1);
    expect(toElementPx(el, 30, 40)).toEqual({ x: 30, y: 40 });
  });

  it('measures rect px per own px off the element and converts pointers by it', () => {
    // A 400px-wide element drawn 500 rect px wide at (100, 50): zoom 1.25.
    const el = sized(new DOMRect(100, 50, 500, 250), 400);
    expect(elementPxScale(el)).toBe(1.25);
    expect(toElementPx(el, 350, 175)).toEqual({ x: 200, y: 100 });
  });

  it("is 1 where rects already come in the element's zoomed px", () => {
    const el = sized(new DOMRect(80, 40, 400, 200), 400);
    expect(elementPxScale(el)).toBe(1);
    expect(toElementPx(el, 180, 90)).toEqual({ x: 100, y: 50 });
  });
});

describe('fixedLayerScale', () => {
  it('is identity where layout reports nothing (jsdom) and leaves no probe behind', () => {
    expect(fixedLayerScale()).toBe(1);
    expect(fixedLayerViewport()).toEqual({ width: innerWidth, height: innerHeight });
    expect(toFixedLayer({ left: 70, top: 135 })).toEqual({ left: 70, top: 135 });
    expect(document.querySelector('[data-fixed-layer-probe]')).toBeNull();
  });

  it('reads the root zoom off the probe when fixed children are scaled (standardized zoom)', () => {
    stubProbes(1.25);
    expect(fixedLayerScale()).toBe(1.25);
    expect(fixedLayerViewport()).toEqual({ width: innerWidth, height: innerHeight });
    expect(toFixedLayer({ left: 70, top: 135, right: undefined })).toEqual({
      left: 56,
      top: 108,
      right: undefined,
    });
  });

  it('is 1 where rects already come in the zoomed px, with the viewport in those px', () => {
    // An engine that divides each rect by the element's own zoom: the probe
    // reads unscaled, and the window spans innerWidth / 1.25 of those px.
    stubProbes(1, { width: innerWidth / 1.25, height: innerHeight / 1.25 });
    expect(fixedLayerScale()).toBe(1);
    expect(fixedLayerViewport().width).toBeCloseTo(innerWidth / 1.25, 6);
    expect(fixedLayerViewport().height).toBeCloseTo(innerHeight / 1.25, 6);
    expect(toFixedLayer({ left: 70 })).toEqual({ left: 70 });
  });

  it('measures once per zoom level and again after the zoom changes', () => {
    const rects = stubProbes(1.25);
    expect(fixedLayerScale()).toBe(1.25);
    fixedLayerScale();
    fixedLayerViewport();
    toFixedLayer({ left: 1 });
    expect(rects).toHaveBeenCalledTimes(2); // one unit probe + one viewport probe
    rects.mockRestore();
    stubProbes(0.8);
    expect(fixedLayerScale()).toBe(1.25);
    window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT, { detail: { zoom: 0.8 } }));
    expect(fixedLayerScale()).toBe(0.8);
  });
});
