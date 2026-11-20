import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePointerMoveGate } from './usePointerMoveGate';

const at = (clientX: number, clientY: number) => ({ clientX, clientY });

describe('usePointerMoveGate', () => {
  it('does not count the first event after a reset: it only learns where the pointer rests', () => {
    const { result } = renderHook(() => usePointerMoveGate());

    expect(result.current.moved(at(10, 20))).toBe(false);
  });

  it('ignores events at the same spot, as browsers send when content moves under a still pointer', () => {
    const { result } = renderHook(() => usePointerMoveGate());

    result.current.moved(at(10, 20));
    expect(result.current.moved(at(10, 20))).toBe(false);
    expect(result.current.moved(at(10, 20))).toBe(false);
  });

  it('counts a real move once the resting spot is known', () => {
    const { result } = renderHook(() => usePointerMoveGate());

    result.current.moved(at(10, 20));
    expect(result.current.moved(at(11, 20))).toBe(true);
    expect(result.current.moved(at(11, 24))).toBe(true);
  });

  it('forgets the resting spot on reset, so the next event only learns it again', () => {
    const { result } = renderHook(() => usePointerMoveGate());

    result.current.moved(at(10, 20));
    result.current.reset();
    expect(result.current.moved(at(50, 60))).toBe(false);
    expect(result.current.moved(at(50, 61))).toBe(true);
  });

  it('keeps the same functions across renders', () => {
    const { result, rerender } = renderHook(() => usePointerMoveGate());
    const first = result.current;

    rerender();
    expect(result.current.moved).toBe(first.moved);
    expect(result.current.reset).toBe(first.reset);
  });
});
