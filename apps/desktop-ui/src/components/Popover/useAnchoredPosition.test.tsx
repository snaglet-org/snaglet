import { useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZOOM_CHANGED_EVENT } from '@desktop/components/StatusBar/consumers/zoomWindow';
import {
  placeBeside,
  placeVertically,
  useAnchoredPosition,
  type AnchoredPositionOptions,
} from './useAnchoredPosition';

// jsdom's window is 1024 × 768.
const anchors: HTMLElement[] = [];
function anchorAt(rect: DOMRect) {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  anchors.push(anchor);
  const geometry = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect);
  return { anchor, geometry };
}

/**
 * Answer utils/cssZoom's fixed-layer probes as an engine would under root
 * zoom: `scale` rect px per fixed-layer CSS px, viewport in rect px.
 */
function stubRootZoom(scale: number, viewport = { width: innerWidth, height: innerHeight }) {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const probe = this.getAttribute('data-fixed-layer-probe');
    if (probe === 'unit') return new DOMRect(100 * scale, 100 * scale, 100 * scale, 100 * scale);
    if (probe === 'viewport') return new DOMRect(0, 0, viewport.width, viewport.height);
    return original.call(this);
  });
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT));
}

type SurfaceOptions = Omit<AnchoredPositionOptions, 'anchor' | 'surfaceRef'>;

function Surface({ anchor, ...options }: { anchor: HTMLElement } & SurfaceOptions) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { position } = useAnchoredPosition({ anchor, surfaceRef, ...options });
  return <div ref={surfaceRef} data-testid="surface" style={position ?? undefined} />;
}

/**
 * Give the surface a laid-out size: `rect` is what getBoundingClientRect
 * reports (rect px), `scrollHeight` / `border` / `clientHeight` its own CSS
 * px. A `clientHeight` below `scrollHeight` means the surface is capped.
 */
function sizeSurface(
  rect: { width: number; height: number },
  scrollHeight: number,
  border = 0,
  clientHeight = scrollHeight
) {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.dataset.testid === 'surface') return new DOMRect(0, 0, rect.width, rect.height);
    return original.call(this);
  });
  const own = (element: HTMLElement) => element.dataset.testid === 'surface';
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return own(this) ? scrollHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return own(this) ? clientHeight + border : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return own(this) ? clientHeight : 0;
  });
}

function placed() {
  const style = screen.getByTestId('surface').style;
  return {
    left: Number.parseFloat(style.left),
    top: Number.parseFloat(style.top),
    width: Number.parseFloat(style.width),
    maxHeight: Number.parseFloat(style.maxHeight),
  };
}

afterEach(() => {
  for (const anchor of anchors.splice(0)) anchor.remove();
  vi.restoreAllMocks();
  window.dispatchEvent(new CustomEvent(ZOOM_CHANGED_EVENT));
});

describe('useAnchoredPosition under the root zoom', () => {
  it('places in rect px unchanged at zoom 1', () => {
    const { anchor } = anchorAt(new DOMRect(56, 100, 120, 30));
    render(<Surface anchor={anchor} />);
    expect(placed()).toEqual({ left: 56, top: 134, width: 320, maxHeight: 560 });
  });

  it('clamps to the right edge at zoom 1', () => {
    const { anchor } = anchorAt(new DOMRect(900, 100, 120, 30));
    render(<Surface anchor={anchor} />);
    expect(placed().left).toBe(1024 - 8 - 320);
  });

  it('divides the anchor rect by the measured scale so the card lands on the anchor', () => {
    stubRootZoom(1.25);
    const { anchor } = anchorAt(new DOMRect(56, 100, 120, 30));
    render(<Surface anchor={anchor} />);
    const at = placed();
    // On screen: left 44.8 × 1.25 = 56 (the anchor), top = bottom + a 4px gap at 1.25.
    expect(at.left).toBeCloseTo(56 / 1.25, 6);
    expect(at.top).toBeCloseTo((130 + 4 * 1.25) / 1.25, 6);
    // The intended width stays CSS px and grows with the zoom.
    expect(at.width).toBe(320);
    expect(at.maxHeight).toBeLessThanOrEqual(560);
  });

  it('clamps against the right edge with the card at its on-screen width', () => {
    stubRootZoom(1.25);
    const { anchor } = anchorAt(new DOMRect(900, 100, 120, 30));
    render(<Surface anchor={anchor} />);
    const at = placed();
    // The card's on-screen right edge sits the 8px (×1.25) inset from the edge.
    expect((at.left + at.width) * 1.25).toBeCloseTo(1024 - 8 * 1.25, 6);
  });

  it('caps the width to the room left, in CSS px', () => {
    stubRootZoom(1.25);
    const { anchor } = anchorAt(new DOMRect(10, 100, 120, 30));
    render(<Surface anchor={anchor} width={4096} />);
    expect(placed().width).toBeCloseTo((1024 - 2 * 8 * 1.25) / 1.25, 6);
    expect(placed().left).toBeCloseTo(8, 6);
  });

  it('clamps to the viewport the engine reports in rect px when rects are pre-zoomed', () => {
    // Rects already in zoomed px (scale 1); the window spans 1024 / 1.25 of them.
    stubRootZoom(1, { width: 1024 / 1.25, height: 768 / 1.25 });
    const { anchor } = anchorAt(new DOMRect(700, 100, 120, 30));
    render(<Surface anchor={anchor} />);
    expect(placed().left + placed().width).toBeCloseTo(1024 / 1.25 - 8, 6);
  });

  it('opens above when asked and it fits there, keeping the gap past its borders', () => {
    sizeSurface({ width: 320, height: 102 }, 100, 2);
    const { anchor } = anchorAt(new DOMRect(56, 700, 120, 24));
    render(<Surface anchor={anchor} side="above" />);
    // The 102px card (100 content + 2 border) ends the 4px gap above the anchor.
    expect(placed().top).toBe(700 - 4 - 102);
  });

  it('uses the exact rendered height while uncapped, not whole-px scroll metrics', () => {
    stubRootZoom(2);
    // 50.25 CSS px tall renders 100.5 rect px; scrollHeight rounds to 50.
    sizeSurface({ width: 640, height: 100.5 }, 50);
    const { anchor } = anchorAt(new DOMRect(56, 700, 120, 24));
    render(<Surface anchor={anchor} side="above" />);
    expect(placed().top * 2).toBeCloseTo(700 - 4 * 2 - 100.5, 6);
  });

  it('measures a capped surface by its whole content plus borders', () => {
    // 900 of content in a 300-tall box with 2px of border: 902 tall in full.
    sizeSurface({ width: 320, height: 302 }, 900, 2, 300);
    const { anchor } = anchorAt(new DOMRect(56, 300, 120, 24));
    render(<Surface anchor={anchor} side="above" maxHeight={Number.POSITIVE_INFINITY} />);
    // Taller than either side: from the roomier side (below) it slides up to
    // end at the window's bottom inset.
    expect(placed().top).toBe(768 - 8 - 752);
  });

  it('opens below when it is asked to go above but only below holds it', () => {
    sizeSurface({ width: 320, height: 100 }, 100);
    const { anchor } = anchorAt(new DOMRect(56, 20, 120, 24));
    render(<Surface anchor={anchor} side="above" />);
    expect(placed().top).toBe(44 + 4);
  });

  it('lines up with the anchor’s right edge for align end, sliding in from the window edge', () => {
    sizeSurface({ width: 200, height: 100 }, 100);
    const { anchor } = anchorAt(new DOMRect(600, 100, 120, 30));
    render(<Surface anchor={anchor} align="end" fitContent />);
    expect(placed().left).toBe(720 - 200);
    const { anchor: atEdge } = anchorAt(new DOMRect(0, 100, 40, 30));
    render(<Surface anchor={atEdge} align="end" fitContent />);
    expect(Number.parseFloat(screen.getAllByTestId('surface')[1].style.left)).toBe(8);
  });

  it('sizes a fitContent surface to its content under a maxWidth cap, at any zoom', () => {
    stubRootZoom(2);
    sizeSurface({ width: 480, height: 360 }, 180);
    const { anchor } = anchorAt(new DOMRect(800, 700, 100, 24));
    render(<Surface anchor={anchor} align="end" side="above" fitContent gap={4} padding={4} />);
    const style = screen.getByTestId('surface').style;
    expect(style.width).toBe('');
    expect(style.maxWidth).toBe('320px');
    // On screen the 480 rect-px card ends at the anchor's right edge, 8 rect px above it.
    expect(placed().left * 2 + 480).toBeCloseTo(900, 6);
    expect(placed().top * 2 + 360).toBeCloseTo(700 - 4 * 2, 6);
  });

  it('re-places an open surface when the zoom changes', () => {
    const { anchor, geometry } = anchorAt(new DOMRect(56, 100, 120, 30));
    render(<Surface anchor={anchor} />);
    expect(placed().left).toBe(56);
    // ⌘+ : the anchor now reads 1.25× further from the origin.
    geometry.mockReturnValue(new DOMRect(70, 125, 150, 37.5));
    act(() => stubRootZoom(1.25));
    expect(placed().left).toBeCloseTo(56, 6);
  });
});

describe('placeVertically', () => {
  // A 0–700 box with the anchor at 400–430 and a 4px gap: 266 below, 396 above.
  const box = {
    anchorTop: 400,
    anchorBottom: 430,
    topEdge: 0,
    bottomEdge: 700,
    gap: 4,
    limit: 700,
  };

  it('goes below when it fits whole there', () => {
    expect(placeVertically({ ...box, natural: 200 })).toEqual({ top: 434, height: 200 });
  });

  it('flips above when only above holds it whole', () => {
    expect(placeVertically({ ...box, natural: 300 })).toEqual({ top: 96, height: 300 });
  });

  it('slides over the anchor, never cut off, when neither side holds it', () => {
    // 500 fits the box but not 266 below nor 396 above: from the roomier side
    // (above) it slides down to the top edge.
    expect(placeVertically({ ...box, natural: 500 })).toEqual({ top: 0, height: 500 });
    // Near the top the roomier side is below: it slides up from the bottom edge.
    const low = { ...box, anchorTop: 100, anchorBottom: 130 };
    expect(placeVertically({ ...low, natural: 650 })).toEqual({ top: 50, height: 650 });
  });

  it('prefers above when asked: above if it fits, else below, else the roomier side', () => {
    expect(placeVertically({ ...box, side: 'above', natural: 200 })).toEqual({
      top: 196,
      height: 200,
    });
    // 250 would fit below too (266), but above holds it, so it goes above.
    expect(placeVertically({ ...box, side: 'above', natural: 250 })).toEqual({
      top: 146,
      height: 250,
    });
    const high = { ...box, anchorTop: 100, anchorBottom: 130 };
    expect(placeVertically({ ...high, side: 'above', natural: 200 })).toEqual({
      top: 134,
      height: 200,
    });
    expect(placeVertically({ ...box, side: 'above', natural: 500 })).toEqual({
      top: 0,
      height: 500,
    });
  });

  it('only a surface taller than the box (or its limit) is capped', () => {
    expect(placeVertically({ ...box, natural: 900 })).toEqual({ top: 0, height: 700 });
    expect(placeVertically({ ...box, natural: 900, limit: 360 })).toEqual({ top: 36, height: 360 });
  });
});

describe('beside the anchor', () => {
  const room = { leftEdge: 8, rightEdge: 1016, gap: 4, width: 320 };

  it('placeBeside: right when it fits, else left, else no room', () => {
    expect(placeBeside({ ...room, anchorLeft: 100, anchorRight: 300 })).toBe(304);
    // 700 + 4 + 320 runs past 1016: left of the anchor instead.
    expect(placeBeside({ ...room, anchorLeft: 500, anchorRight: 700 })).toBe(500 - 4 - 320);
    // A wide anchor (a Day view block) leaves room on neither side.
    expect(placeBeside({ ...room, anchorLeft: 200, anchorRight: 900 })).toBeNull();
  });

  it('opens right of the anchor, top-aligned, so it covers neither it nor what is below', () => {
    sizeSurface({ width: 320, height: 200 }, 200);
    const { anchor } = anchorAt(new DOMRect(100, 300, 150, 40));
    render(<Surface anchor={anchor} side="beside" />);
    expect(placed()).toMatchObject({ left: 254, top: 300 });
  });

  it('opens left of an anchor near the right edge, sliding up to show whole', () => {
    sizeSurface({ width: 320, height: 200 }, 200);
    const { anchor } = anchorAt(new DOMRect(700, 650, 150, 40));
    render(<Surface anchor={anchor} side="beside" />);
    expect(placed()).toMatchObject({ left: 700 - 4 - 320, top: 768 - 8 - 200 });
  });

  it('falls back to below when neither side has room', () => {
    sizeSurface({ width: 320, height: 200 }, 200);
    const { anchor } = anchorAt(new DOMRect(100, 100, 800, 40));
    render(<Surface anchor={anchor} side="beside" />);
    expect(placed()).toMatchObject({ left: 100, top: 144 });
  });
});
