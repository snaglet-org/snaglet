import { act, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoomableImage } from './ZoomableImage';

/**
 * jsdom does no layout: stand in for the viewer box's size, the image's
 * natural size, and ResizeObserver, so the viewer sees an 800×600 box and a
 * 1600×900 image (fit = 50%). Rects stay all-zero, so pointer clientX/Y map
 * 1:1 onto box px.
 */
let boxSize = { width: 800, height: 600 };
let naturalSize = { width: 1600, height: 900 };
const observers: Array<() => void> = [];

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    observers.push(this.callback);
  }
  unobserve() {}
  disconnect() {
    const index = observers.indexOf(this.callback);
    if (index >= 0) observers.splice(index, 1);
  }
}

function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => boxSize.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => boxSize.height);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(
    () => naturalSize.width
  );
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockImplementation(
    () => naturalSize.height
  );
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
}

function resizeBox(width: number, height: number) {
  boxSize = { width, height };
  act(() => observers.forEach((callback) => callback()));
}

function renderViewer(props: Partial<Parameters<typeof ZoomableImage>[0]> = {}) {
  const result = render(<ZoomableImage src="blob:first" alt="Test image" {...props} />);
  fireEvent.load(screen.getByRole('img', { name: 'Test image' }));
  return result;
}

const viewer = () => screen.getByRole('group', { name: 'Image viewer' });
const image = () => screen.getByRole('img', { name: 'Test image' });
const readout = () => screen.getByRole('status');

beforeEach(() => {
  boxSize = { width: 800, height: 600 };
  naturalSize = { width: 1600, height: 900 };
  observers.length = 0;
  stubLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ZoomableImage', () => {
  it('opens at fit, centered, with a polite zoom readout', () => {
    renderViewer();
    expect(image()).toHaveStyle({
      width: '800px',
      height: '450px',
      transform: 'translate(0px, 75px)',
    });
    expect(readout()).toHaveTextContent('Zoom 50%');
    expect(readout()).toHaveAttribute('aria-live', 'polite');
    expect(viewer()).not.toHaveAttribute('data-pannable');
  });

  it('never upscales a small image at fit', () => {
    naturalSize = { width: 200, height: 100 };
    renderViewer();
    expect(readout()).toHaveTextContent('100%');
    expect(image()).toHaveStyle({ width: '200px', height: '100px' });
  });

  it('grows a small image at fit up to a raised fit cap, and zoom-out stops there', () => {
    naturalSize = { width: 200, height: 100 };
    renderViewer({ maxFitScale: 2 });
    expect(readout()).toHaveTextContent('200%');
    expect(image()).toHaveStyle({ width: '400px', height: '200px' });
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
  });

  it('puts the host data attributes on the image element', () => {
    renderViewer({ imageDataAttributes: { 'data-test-preview': '' } });
    expect(image()).toHaveAttribute('data-test-preview', '');
    expect(image()).toHaveAttribute('draggable', 'false');
  });

  it('lays an overlay over the image that follows the view', () => {
    const overlay = vi.fn(({ view }: { view: { scale: number } }) => (
      <span data-testid="overlay-content">{view.scale}</span>
    ));
    renderViewer({ overlay });
    const layer = screen.getByTestId('overlay-content').parentElement;
    expect(layer?.previousElementSibling).toBe(image());
    expect(overlay).toHaveBeenLastCalledWith({
      natural: { width: 1600, height: 900 },
      view: { scale: 0.5, x: 0, y: 75 },
    });
    // Natural-size layer, placed and scaled like the image, so overlay
    // content works in image pixels and grows with the zoom.
    expect(layer).toHaveStyle({
      width: '1600px',
      height: '900px',
      transform: 'translate(0px, 75px) scale(0.5)',
    });

    fireEvent.keyDown(viewer(), { key: '1' });
    expect(screen.getByTestId('overlay-content')).toHaveTextContent('1');
    expect(layer?.style.transform).toBe('translate(-400px, -150px) scale(1)');
    expect(layer).toHaveAttribute('data-animate', 'true');
  });

  it('ignores keys, presses and clicks from content an overlay portals elsewhere', () => {
    const onBackdropClick = vi.fn();
    renderViewer({
      onBackdropClick,
      overlay: () =>
        createPortal(<button type="button">Portaled dialog control</button>, document.body),
    });
    const portaled = screen.getByRole('button', { name: 'Portaled dialog control' });
    expect(viewer().contains(portaled)).toBe(false);
    expect(fireEvent.keyDown(portaled, { key: '+' })).toBe(true);
    fireEvent.doubleClick(portaled);
    fireEvent.click(portaled);
    expect(readout()).toHaveTextContent('50%');
    expect(onBackdropClick).not.toHaveBeenCalled();

    fireEvent.keyDown(viewer(), { key: '1' });
    fireEvent.pointerDown(portaled, { button: 0, pointerId: 1, clientX: 400, clientY: 300 });
    expect(viewer()).not.toHaveAttribute('data-dragging');
  });

  it('renders no overlay layer until the image is ready', () => {
    const overlay = vi.fn(() => <span data-testid="overlay-content" />);
    render(<ZoomableImage src="blob:first" alt="Test image" overlay={overlay} />);
    expect(screen.queryByTestId('overlay-content')).toBeNull();
    expect(overlay).not.toHaveBeenCalled();
  });

  it('zooms with Ctrl/⌘ + wheel around the pointer and keeps the page from zooming', () => {
    renderViewer();
    // The image point under (200, 300) at fit: (400, 450) in image px.
    const notPrevented = fireEvent.wheel(viewer(), {
      ctrlKey: true,
      deltaY: -20,
      clientX: 200,
      clientY: 300,
    });
    expect(notPrevented).toBe(false);
    const scale = Number.parseFloat(image().style.width) / 1600;
    expect(scale).toBeGreaterThan(0.5);
    const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(image().style.transform);
    expect(match).not.toBeNull();
    const [x, y] = [Number(match?.[1]), Number(match?.[2])];
    expect(x + 400 * scale).toBeCloseTo(200, 3);
    expect(y + 450 * scale).toBeCloseTo(300, 3);

    expect(fireEvent.wheel(viewer(), { metaKey: true, deltaY: 20 })).toBe(false);
  });

  it('zooms with a WebKit trackpad pinch and keeps the webview from zooming', () => {
    renderViewer();
    const gesture = (type: string, scale: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { scale, clientX: 200, clientY: 300 });
      act(() => {
        viewer().dispatchEvent(event);
      });
      return event;
    };
    expect(gesture('gesturestart', 1).defaultPrevented).toBe(true);
    expect(gesture('gesturechange', 2).defaultPrevented).toBe(true);
    expect(readout()).toHaveTextContent('100%');
    // Ctrl+wheel arriving mid-pinch is not applied on top of the pinch.
    fireEvent.wheel(viewer(), { ctrlKey: true, deltaY: -20 });
    expect(readout()).toHaveTextContent('100%');
    gesture('gestureend', 2);
    // (400, 450) in image px stays under the pinch point (200, 300).
    expect(image().style.transform).toBe('translate(-200px, -150px)');
  });

  it('leaves plain wheel alone at fit, and pans with it once zoomed', () => {
    renderViewer();
    expect(fireEvent.wheel(viewer(), { deltaY: 40 })).toBe(true);
    expect(image().style.transform).toBe('translate(0px, 75px)');

    fireEvent.keyDown(viewer(), { key: '1' });
    // 100% of 1600×900 in 800×600, centered: (−400, −150).
    expect(image().style.transform).toBe('translate(-400px, -150px)');
    expect(fireEvent.wheel(viewer(), { deltaX: 30, deltaY: 40 })).toBe(false);
    expect(image().style.transform).toBe('translate(-430px, -190px)');
  });

  it('zooms with the toolbar buttons, clamps at fit, and fits again', () => {
    renderViewer();
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const fit = screen.getByRole('button', { name: 'Fit image to view' });
    expect(zoomOut).toBeDisabled();
    expect(fit).toBeDisabled();

    fireEvent.click(zoomIn);
    expect(readout()).toHaveTextContent('63%');
    fireEvent.click(zoomIn);
    expect(readout()).toHaveTextContent('78%');
    fireEvent.click(zoomOut);
    expect(readout()).toHaveTextContent('63%');

    fireEvent.click(fit);
    expect(readout()).toHaveTextContent('50%');
    expect(fit).toBeDisabled();
    // The button that disabled itself hands focus back to the viewer.
    expect(viewer()).toHaveFocus();
  });

  it('caps the zoom at 8×', () => {
    renderViewer();
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 40; i += 1) fireEvent.click(zoomIn);
    expect(readout()).toHaveTextContent('800%');
    expect(zoomIn).toBeDisabled();
  });

  it('handles + = - 0 1 while focused, but never ⌘/Ctrl combos (the app zoom)', () => {
    renderViewer();
    expect(fireEvent.keyDown(viewer(), { key: '+' })).toBe(false);
    expect(readout()).toHaveTextContent('63%');
    fireEvent.keyDown(viewer(), { key: '=' });
    expect(readout()).toHaveTextContent('78%');
    fireEvent.keyDown(viewer(), { key: '-' });
    expect(readout()).toHaveTextContent('63%');
    fireEvent.keyDown(viewer(), { key: '1' });
    expect(readout()).toHaveTextContent('100%');
    fireEvent.keyDown(viewer(), { key: '0' });
    expect(readout()).toHaveTextContent('50%');

    expect(fireEvent.keyDown(viewer(), { key: '=', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(viewer(), { key: '-', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(viewer(), { key: '0', metaKey: true })).toBe(true);
    expect(readout()).toHaveTextContent('50%');
  });

  it('pans with the arrow keys only when zoomed', () => {
    renderViewer();
    expect(fireEvent.keyDown(viewer(), { key: 'ArrowRight' })).toBe(true);
    fireEvent.keyDown(viewer(), { key: '1' });
    expect(fireEvent.keyDown(viewer(), { key: 'ArrowRight' })).toBe(false);
    // 10% of the 800px box.
    expect(image().style.transform).toBe('translate(-480px, -150px)');
  });

  it('double-click zooms in at the click point, and again fits', () => {
    renderViewer();
    fireEvent.doubleClick(image(), { clientX: 200, clientY: 300 });
    // detail scale for fit 0.5 is max(2 × 0.5, 1) = 100%; (400, 450) stays under (200, 300).
    expect(readout()).toHaveTextContent('100%');
    expect(image().style.transform).toBe('translate(-200px, -150px)');
    fireEvent.doubleClick(image(), { clientX: 200, clientY: 300 });
    expect(readout()).toHaveTextContent('50%');
  });

  it('drags to pan only when the image overflows', () => {
    renderViewer();
    fireEvent.pointerDown(image(), { button: 0, pointerId: 1, clientX: 400, clientY: 300 });
    expect(viewer()).not.toHaveAttribute('data-dragging');
    fireEvent.pointerMove(image(), { pointerId: 1, clientX: 300, clientY: 250 });
    fireEvent.pointerUp(image(), { pointerId: 1, clientX: 300, clientY: 250 });
    expect(image().style.transform).toBe('translate(0px, 75px)');

    fireEvent.keyDown(viewer(), { key: '1' });
    expect(viewer()).toHaveAttribute('data-pannable');
    fireEvent.pointerDown(image(), { button: 0, pointerId: 2, clientX: 400, clientY: 300 });
    expect(viewer()).toHaveAttribute('data-dragging');
    fireEvent.pointerMove(image(), { pointerId: 2, clientX: 300, clientY: 250 });
    expect(image().style.transform).toBe('translate(-500px, -200px)');
    // Clamped at the image's far edge.
    fireEvent.pointerMove(image(), { pointerId: 2, clientX: -5000, clientY: -5000 });
    expect(image().style.transform).toBe('translate(-800px, -300px)');
    fireEvent.pointerUp(image(), { pointerId: 2 });
    expect(viewer()).not.toHaveAttribute('data-dragging');
  });

  it('starts over at fit when the image changes', () => {
    const { rerender } = renderViewer();
    fireEvent.keyDown(viewer(), { key: '1' });
    expect(readout()).toHaveTextContent('100%');

    naturalSize = { width: 2400, height: 1800 };
    rerender(<ZoomableImage src="blob:second" alt="Test image" />);
    fireEvent.load(image());
    // The second image's own fit (1/3), not the first one's 100%.
    expect(readout()).toHaveTextContent('33%');
    expect(image()).toHaveStyle({ width: '800px', height: '600px' });
    expect(image().style.transform).toBe('translate(0px, 0px)');
  });

  it('re-fits on resize when fitted, and when the box grows past the zoom', () => {
    renderViewer();
    resizeBox(400, 300);
    expect(readout()).toHaveTextContent('25%');

    fireEvent.keyDown(viewer(), { key: '+' });
    expect(readout()).toHaveTextContent('31%');
    resizeBox(800, 600);
    expect(readout()).toHaveTextContent('50%');

    fireEvent.keyDown(viewer(), { key: '1' });
    resizeBox(1000, 700);
    // Still zoomed past the new fit (~62%): the zoom is kept.
    expect(readout()).toHaveTextContent('100%');
  });

  it('closes on a backdrop click at fit, but not on the image, after a drag, or zoomed', () => {
    const onBackdropClick = vi.fn();
    renderViewer({ onBackdropClick });

    fireEvent.click(image());
    expect(onBackdropClick).not.toHaveBeenCalled();

    fireEvent.pointerDown(viewer(), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(viewer(), { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.pointerUp(viewer(), { pointerId: 1, clientX: 60, clientY: 10 });
    fireEvent.click(viewer());
    expect(onBackdropClick).not.toHaveBeenCalled();

    fireEvent.click(viewer());
    expect(onBackdropClick).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(viewer(), { key: '+' });
    fireEvent.click(viewer());
    expect(onBackdropClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });

  it('takes focus on mount when asked', () => {
    renderViewer({ autoFocus: true });
    expect(viewer()).toHaveFocus();
  });
});
