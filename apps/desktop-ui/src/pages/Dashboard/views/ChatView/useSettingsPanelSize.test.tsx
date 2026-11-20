/**
 * useSettingsPanelSize — dragging the settings drawer's and sidebar's edges.
 */
import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { describe, expect, it } from 'vitest';
import { useSettingsPanelSize } from './useSettingsPanelSize';

function shellOfHeight(height: number): HTMLDivElement {
  const shell = document.createElement('div');
  Object.defineProperty(shell, 'offsetHeight', { configurable: true, value: height });
  return shell;
}

/** Just enough of a pointer event for the handlers. */
function pointer(clientX: number, clientY: number): ReactPointerEvent<HTMLElement> {
  const target = document.createElement('div');
  target.setPointerCapture = () => {};
  return {
    clientX,
    clientY,
    pointerId: 1,
    target,
    preventDefault: () => {},
  } as unknown as ReactPointerEvent<HTMLElement>;
}

describe('useSettingsPanelSize', () => {
  it('keeps the CSS sizes until an edge is dragged', () => {
    const { result } = renderHook(() => useSettingsPanelSize({ current: shellOfHeight(500) }));
    expect(result.current.drawerStyle).toBeUndefined();
    expect(result.current.sidebarStyle).toBeUndefined();
  });

  it('grows the drawer with a downward drag from its default height, within bounds', () => {
    const { result } = renderHook(() => useSettingsPanelSize({ current: shellOfHeight(500) }));

    act(() => result.current.drawerHandle.onPointerDown(pointer(0, 100)));
    act(() => result.current.drawerHandle.onPointerMove(pointer(0, 150)));
    expect(result.current.drawerStyle).toEqual({ height: '440px', maxHeight: '440px' });

    act(() => result.current.drawerHandle.onPointerMove(pointer(0, 900)));
    expect(result.current.drawerStyle).toEqual({ height: '460px', maxHeight: '460px' });

    act(() => result.current.drawerHandle.onPointerUp());
    act(() => result.current.drawerHandle.onPointerMove(pointer(0, 0)));
    expect(result.current.drawerStyle).toEqual({ height: '460px', maxHeight: '460px' });
  });

  it('widens the sidebar when its left edge is dragged left, within bounds', () => {
    const { result } = renderHook(() => useSettingsPanelSize({ current: shellOfHeight(500) }));

    act(() => result.current.sidebarHandle.onPointerDown(pointer(400, 0)));
    act(() => result.current.sidebarHandle.onPointerMove(pointer(350, 0)));
    expect(result.current.sidebarStyle).toEqual({ width: '350px', minWidth: '350px' });

    act(() => result.current.sidebarHandle.onPointerMove(pointer(1000, 0)));
    expect(result.current.sidebarStyle).toEqual({ width: '220px', minWidth: '220px' });

    act(() => result.current.sidebarHandle.onPointerCancel());
    act(() => result.current.sidebarHandle.onPointerMove(pointer(0, 0)));
    expect(result.current.sidebarStyle).toEqual({ width: '220px', minWidth: '220px' });
  });
});
