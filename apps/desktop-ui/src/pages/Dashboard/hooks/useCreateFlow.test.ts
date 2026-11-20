import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCreateFlow } from './useCreateFlow';

describe('useCreateFlow', () => {
  it('runs the callback once the item is created, and closes', () => {
    const { result } = renderHook(() => useCreateFlow());
    const onCreated = vi.fn();
    act(() => result.current.start(onCreated));
    expect(result.current.open).toBe(true);
    expect(onCreated).not.toHaveBeenCalled();

    act(() => result.current.finish());
    expect(result.current.open).toBe(false);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('never runs the callback when the form is canceled', () => {
    const { result } = renderHook(() => useCreateFlow());
    const onCreated = vi.fn();
    act(() => result.current.start(onCreated));
    act(() => result.current.cancel());
    expect(result.current.open).toBe(false);

    // A later create started without a callback does not run the dropped one.
    act(() => result.current.start());
    act(() => result.current.finish());
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("drops an earlier caller's callback when another caller starts the form", () => {
    const { result } = renderHook(() => useCreateFlow());
    const first = vi.fn();
    const second = vi.fn();
    act(() => result.current.start(first));
    act(() => result.current.start(second));
    act(() => result.current.finish());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
