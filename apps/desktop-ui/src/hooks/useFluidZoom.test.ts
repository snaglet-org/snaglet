/**
 * useFluidZoom — the ResizeObserver fallback for the fluid surface zoom.
 * jsdom has neither ResizeObserver nor `CSS.supports`, so both are stubbed:
 * the observer to capture its callback, `CSS.supports` to steer the hook
 * between "the engine evaluates the CSS clamp() itself" (hook is a no-op)
 * and "write `--pane-zoom` inline from the measured width".
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { useFluidZoom } from './useFluidZoom';

const SPEC = { fullWidth: 840, min: 0.7 } as const;

function stubEnvironment(cssSupported: boolean) {
  let callback: ResizeObserverCallback = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        callback = cb;
      }
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
    }
  );
  vi.stubGlobal('CSS', { supports: vi.fn(() => cssSupported) });
  const el = document.createElement('div');
  const ref = createRef<HTMLDivElement>();
  (ref as { current: HTMLDivElement | null }).current = el;
  const resizeTo = (width: number) =>
    callback(
      [{ contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
      {} as ResizeObserver
    );
  return { el, ref, observe, disconnect, resizeTo };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useFluidZoom', () => {
  it('writes clamp(min, width / full, 1) to the custom property as the surface resizes', () => {
    const { el, ref, observe, disconnect, resizeTo } = stubEnvironment(false);
    const rendered = renderHook(() => useFluidZoom(ref, '--pane-zoom', SPEC));
    expect(observe).toHaveBeenCalledWith(el);

    resizeTo(672);
    expect(el.style.getPropertyValue('--pane-zoom')).toBe('0.8');
    resizeTo(100);
    expect(el.style.getPropertyValue('--pane-zoom')).toBe('0.7');
    resizeTo(2000);
    expect(el.style.getPropertyValue('--pane-zoom')).toBe('1');

    rendered.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(el.style.getPropertyValue('--pane-zoom')).toBe('');
  });

  it('honors a per-surface spec (sidebar floor)', () => {
    const { el, ref, resizeTo } = stubEnvironment(false);
    renderHook(() => useFluidZoom(ref, '--sidebar-zoom', { fullWidth: 232, min: 0.75 }));
    resizeTo(116);
    expect(el.style.getPropertyValue('--sidebar-zoom')).toBe('0.75');
  });

  it('is a no-op when the engine evaluates the CSS expression itself', () => {
    const { el, ref, observe } = stubEnvironment(true);
    renderHook(() => useFluidZoom(ref, '--pane-zoom', SPEC));
    expect(observe).not.toHaveBeenCalled();
    expect(el.style.getPropertyValue('--pane-zoom')).toBe('');
  });

  it('does nothing without a ResizeObserver', () => {
    const { ref, el } = stubEnvironment(false);
    vi.stubGlobal('ResizeObserver', undefined);
    expect(() => renderHook(() => useFluidZoom(ref, '--pane-zoom', SPEC))).not.toThrow();
    expect(el.style.getPropertyValue('--pane-zoom')).toBe('');
  });
});
