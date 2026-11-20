import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './useNow';

// 400 ms into a wall-clock second: the awkward case, where an interval started
// at mount ticks at :400 every second and a seconds countdown reads a stale
// value for 400 ms of each second.
const MID_SECOND = Date.UTC(2026, 0, 1, 12, 0, 0, 400);

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MID_SECOND);
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('useNow', () => {
  it('ticks on wall-clock second boundaries, not at the offset the hook mounted at', () => {
    const { result } = renderHook(() => useNow(true));
    expect(result.current).toBe(MID_SECOND);

    act(() => void vi.advanceTimersByTime(599));
    expect(result.current).toBe(MID_SECOND); // not yet the boundary
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current % 1000).toBe(0);
    expect(result.current).toBe(MID_SECOND + 600);
  });

  it('never skips or repeats a second across many ticks', () => {
    const { result } = renderHook(() => useNow(true));
    const seconds: number[] = [Math.floor(result.current / 1000)];
    for (let i = 0; i < 6; i++) {
      act(() => void vi.advanceTimersByTime(i === 0 ? 600 : 1000));
      seconds.push(Math.floor(result.current / 1000));
    }
    const first = seconds[0]!;
    expect(seconds).toEqual([
      first,
      first + 1,
      first + 2,
      first + 3,
      first + 4,
      first + 5,
      first + 6,
    ]);
  });

  it('honors a custom interval, aligned to it', () => {
    const { result } = renderHook(() => useNow(true, 5000));
    act(() => void vi.advanceTimersByTime(4600)); // 12:00:05.000
    expect(result.current).toBe(Date.UTC(2026, 0, 1, 12, 0, 5, 0));
    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current).toBe(Date.UTC(2026, 0, 1, 12, 0, 10, 0));
  });

  it('stops while hidden and realigns when shown again', () => {
    const { result } = renderHook(() => useNow(true));
    setVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(MID_SECOND + 10_250);
    setVisibility('visible');
    expect(result.current).toBe(MID_SECOND + 10_250); // catches up at once
    act(() => void vi.advanceTimersByTime(350)); // :10.650 -> the :11.000 boundary
    expect(result.current).toBe(Date.UTC(2026, 0, 1, 12, 0, 11, 0));
  });

  it('runs no timer while inactive, and none after unmount', () => {
    const { unmount, rerender } = renderHook(({ on }) => useNow(on), {
      initialProps: { on: false },
    });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ on: true });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
