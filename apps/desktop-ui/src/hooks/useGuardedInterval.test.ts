/**
 * useGuardedInterval — the shared single-flight polling loop. Pins the
 * enabled gate, the immediate first tick, per-interval firing, in-flight
 * skip, error swallowing, and cancellation on unmount/disable.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuardedInterval } from './useGuardedInterval';

const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useGuardedInterval', () => {
  it('does nothing while disabled', async () => {
    const tick = vi.fn(async () => {});
    renderHook(() =>
      useGuardedInterval(tick, { intervalMs: 1000, enabled: false, immediate: true })
    );

    await advance(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it('runs an immediate first tick when immediate is set', () => {
    const tick = vi.fn(async () => {});
    renderHook(() =>
      useGuardedInterval(tick, { intervalMs: 1000, enabled: true, immediate: true })
    );

    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('ticks once per interval', async () => {
    const tick = vi.fn(async () => {});
    renderHook(() => useGuardedInterval(tick, { intervalMs: 1000, enabled: true }));

    await advance(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('skips interval firings while the previous tick is still in flight', async () => {
    let release!: () => void;
    const tick = vi.fn(
      () =>
        new Promise<void>((res) => {
          release = res;
        })
    );
    renderHook(() => useGuardedInterval(tick, { intervalMs: 1000, enabled: true }));

    await advance(4000); // 4 firings, but the first tick never resolved
    expect(tick).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    await advance(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('swallows tick errors and retries next interval', async () => {
    const tick = vi.fn(async () => {
      throw new Error('transient');
    });
    renderHook(() => useGuardedInterval(tick, { intervalMs: 1000, enabled: true }));

    await advance(2000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('cancels the signal and stops ticking on unmount', async () => {
    let seen: { canceled: boolean } | undefined;
    const tick = vi.fn(async (signal: { canceled: boolean }) => {
      seen = signal;
    });
    const { unmount } = renderHook(() =>
      useGuardedInterval(tick, { intervalMs: 1000, enabled: true, immediate: true })
    );
    expect(seen?.canceled).toBe(false);

    unmount();
    expect(seen?.canceled).toBe(true);

    await advance(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('stops ticking when enabled flips false', async () => {
    const tick = vi.fn(async () => {});
    const { rerender } = renderHook(
      ({ enabled }) => useGuardedInterval(tick, { intervalMs: 1000, enabled }),
      { initialProps: { enabled: true } }
    );

    await advance(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });
    await advance(5000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
