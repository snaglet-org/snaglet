import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  markThreadRunFinished,
  markThreadRunStarted,
  seedRunningThreads,
  setThreadRunParent,
  useThreadRunning,
} from './threadRunState';

const PARENT = 'thread-parent';
const HELPER = 'thread-helper';

describe('thread run state', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    act(() => {
      vi.advanceTimersByTime(2_000);
      seedRunningThreads([]);
    });
    vi.useRealTimers();
  });

  it('projects a live helper run onto its parent thread', () => {
    const { result } = renderHook(() => useThreadRunning(PARENT));

    act(() => {
      markThreadRunStarted(HELPER);
      setThreadRunParent(HELPER, PARENT);
    });

    expect(result.current).toBe(true);
  });

  it('keeps a parent running while another helper remains active', () => {
    const otherHelper = 'thread-helper-2';
    const { result } = renderHook(() => useThreadRunning(PARENT));

    act(() => {
      markThreadRunStarted(HELPER);
      setThreadRunParent(HELPER, PARENT);
      markThreadRunStarted(otherHelper);
      setThreadRunParent(otherHelper, PARENT);
      markThreadRunFinished(HELPER);
    });

    expect(result.current).toBe(true);
  });

  it('projects reconnect-seeded helper activity onto its parent', () => {
    const { result } = renderHook(() => useThreadRunning(PARENT));

    act(() => {
      setThreadRunParent(HELPER, PARENT);
      seedRunningThreads([HELPER]);
    });

    expect(result.current).toBe(true);
  });

  it('stops projecting a paused or stopped helper when its finish linger expires', () => {
    const { result } = renderHook(() => useThreadRunning(PARENT));

    act(() => {
      setThreadRunParent(HELPER, PARENT);
      markThreadRunStarted(HELPER);
      markThreadRunFinished(HELPER);
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current).toBe(false);
  });
});
