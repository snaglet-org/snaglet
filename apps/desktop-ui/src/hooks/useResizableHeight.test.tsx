import { act, fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { clampHeight, useResizableHeight } from './useResizableHeight';

const options = { storageKey: 'test.height', defaultHeight: 200, min: 100, max: 400 };

beforeEach(() => window.localStorage.clear());

describe('useResizableHeight', () => {
  it('starts at the default, or at the saved height clamped to the range', () => {
    expect(renderHook(() => useResizableHeight(options)).result.current.height).toBe(200);
    window.localStorage.setItem('test.height', '350');
    expect(renderHook(() => useResizableHeight(options)).result.current.height).toBe(350);
    window.localStorage.setItem('test.height', '9999');
    expect(renderHook(() => useResizableHeight(options)).result.current.height).toBe(400);
    window.localStorage.setItem('test.height', 'wide');
    expect(renderHook(() => useResizableHeight(options)).result.current.height).toBe(200);
  });

  it('dragging up makes it taller and down shorter, within the range, and saves it', () => {
    const { result } = renderHook(() => useResizableHeight(options));
    act(() =>
      result.current.onPointerDown({
        button: 0,
        clientY: 500,
        preventDefault: () => undefined,
      } as never)
    );
    expect(result.current.isResizing).toBe(true);
    expect(document.body.style.cursor).toBe('row-resize');
    act(() => {
      fireEvent.pointerMove(window, { clientY: 450 });
    });
    expect(result.current.height).toBe(250);
    act(() => {
      fireEvent.pointerMove(window, { clientY: 0 });
    });
    expect(result.current.height).toBe(400);
    act(() => {
      fireEvent.pointerMove(window, { clientY: 900 });
    });
    expect(result.current.height).toBe(100);
    act(() => {
      fireEvent.pointerUp(window);
    });
    expect(result.current.isResizing).toBe(false);
    expect(document.body.style.cursor).toBe('');
    expect(window.localStorage.getItem('test.height')).toBe('100');
  });

  it('moves by keys and resets to the default', () => {
    const { result } = renderHook(() => useResizableHeight(options));
    const key = (k: string) =>
      act(() => result.current.onKeyDown({ key: k, preventDefault: () => undefined } as never));
    key('ArrowUp');
    expect(result.current.height).toBe(216);
    key('ArrowDown');
    key('ArrowDown');
    expect(result.current.height).toBe(184);
    key('Home');
    expect(result.current.height).toBe(400);
    key('End');
    expect(result.current.height).toBe(100);
    act(() => result.current.reset());
    expect(result.current.height).toBe(200);
  });

  it('a bottom-edge handle grows when dragged down, and ↓ grows it', () => {
    const { result } = renderHook(() => useResizableHeight({ ...options, direction: 'down' }));
    act(() =>
      result.current.onPointerDown({
        button: 0,
        clientY: 100,
        preventDefault: () => undefined,
      } as never)
    );
    act(() => {
      fireEvent.pointerMove(window, { clientY: 150 });
    });
    expect(result.current.height).toBe(250);
    act(() => {
      fireEvent.pointerUp(window);
    });
    const key = (k: string) =>
      act(() => result.current.onKeyDown({ key: k, preventDefault: () => undefined } as never));
    key('ArrowDown');
    expect(result.current.height).toBe(266);
    key('ArrowUp');
    key('ArrowUp');
    expect(result.current.height).toBe(234);
  });

  it('clamps', () => {
    expect(clampHeight(50, 100, 400, 200)).toBe(100);
    expect(clampHeight(Number.NaN, 100, 400, 200)).toBe(200);
  });
});
