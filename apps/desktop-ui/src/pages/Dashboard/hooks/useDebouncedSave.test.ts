/**
 * useDebouncedSave — the shared autosave state machine (TaskDetailsPanel,
 * DetailsPanel). Pins the debounce window, the
 * immediate-mode macrotask defer, in-flight coalescing (last write ships),
 * the saved→idle fade, the error landing, and unmount cancellation.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedSave } from './useDebouncedSave';

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

/** A persist double the test resolves by hand, to hold a save in flight. */
function gate(): Gate {
  let finish: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    finish = res;
  });
  return {
    promise,
    resolve: () => {
      if (!finish) throw new Error('Save gate was not initialized');
      finish();
    },
  };
}

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

describe('useDebouncedSave', () => {
  it('debounces: persists once, 400ms after the last queueSave', async () => {
    const persist = vi.fn(async () => {});
    const { result } = renderHook(() => useDebouncedSave(persist));
    expect(result.current.saveState).toBe('idle');

    act(() => result.current.queueSave());
    expect(result.current.saveState).toBe('dirty');

    await advance(300);
    act(() => result.current.queueSave()); // re-arms — resets the window
    await advance(399);
    expect(persist).not.toHaveBeenCalled();

    await advance(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.current.saveState).toBe('saved');
  });

  it("queueSave('immediate') defers to the next macrotask, not synchronously", async () => {
    const persist = vi.fn(async () => {});
    const { result } = renderHook(() => useDebouncedSave(persist));

    act(() => result.current.queueSave('immediate'));
    // Deferred so the caller's setState commits and refreshes the refs
    // persist reads before the save fires.
    expect(persist).not.toHaveBeenCalled();

    await advance(0);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("fades 'saved' back to 'idle' after 1600ms", async () => {
    const persist = vi.fn(async () => {});
    const { result } = renderHook(() => useDebouncedSave(persist));

    act(() => result.current.queueSave('immediate'));
    await advance(0);
    expect(result.current.saveState).toBe('saved');

    await advance(1599);
    expect(result.current.saveState).toBe('saved');
    await advance(1);
    expect(result.current.saveState).toBe('idle');
  });

  it('coalesces saves requested mid-flight into one re-run (last write ships)', async () => {
    const gates: Gate[] = [];
    const persist = vi.fn(() => {
      const g = gate();
      gates.push(g);
      return g.promise;
    });
    const { result } = renderHook(() => useDebouncedSave(persist));

    act(() => {
      void result.current.flush();
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.current.saveState).toBe('saving');

    // Two more requests while the first save is in flight → one queued re-run.
    act(() => {
      void result.current.flush();
      void result.current.flush();
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.current.saveState).toBe('saving');

    await act(async () => {
      gates[0]!.resolve();
      await gates[0]!.promise;
    });
    expect(persist).toHaveBeenCalledTimes(2);

    await act(async () => {
      gates[1]!.resolve();
      await gates[1]!.promise;
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(result.current.saveState).toBe('saved');
  });

  it("lands on 'error' when persist rejects", async () => {
    const persist = vi.fn(async () => {
      throw new Error('save failed');
    });
    const { result } = renderHook(() => useDebouncedSave(persist));

    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.saveState).toBe('error');
  });

  it('flush() persists right away without waiting for the debounce window', async () => {
    const persist = vi.fn(async () => {});
    const { result } = renderHook(() => useDebouncedSave(persist));

    await act(async () => {
      await result.current.flush();
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.current.saveState).toBe('saved');
  });

  it('flush clears an armed debounce so the saved draft is not persisted again', async () => {
    const persist = vi.fn(async () => {});
    const { result } = renderHook(() => useDebouncedSave(persist));

    act(() => result.current.queueSave());
    await advance(200);
    await act(async () => result.current.flush());
    expect(persist).toHaveBeenCalledOnce();
    expect(result.current.saveState).toBe('saved');

    await advance(200);
    expect(persist).toHaveBeenCalledOnce();
    expect(result.current.saveState).toBe('saved');
    await advance(1400);
    expect(result.current.saveState).toBe('idle');
    expect(persist).toHaveBeenCalledOnce();
  });

  it('stays dirty when an earlier save finishes while a newer debounce is armed', async () => {
    const first = gate();
    const second = gate();
    const persist = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useDebouncedSave(persist));

    act(() => void result.current.flush());
    act(() => result.current.queueSave());
    await advance(100);
    await act(async () => first.resolve());
    expect(result.current.saveState).toBe('dirty');
    expect(persist).toHaveBeenCalledOnce();

    await advance(299);
    expect(result.current.saveState).toBe('dirty');
    expect(persist).toHaveBeenCalledOnce();
    await advance(1);
    expect(result.current.saveState).toBe('saving');
    expect(persist).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve());
    expect(result.current.saveState).toBe('saved');
  });

  it('unmount cancels a pending debounced save', async () => {
    const persist = vi.fn(async () => {});
    const { result, unmount } = renderHook(() => useDebouncedSave(persist));

    act(() => result.current.queueSave());
    unmount();

    await advance(5000);
    expect(persist).not.toHaveBeenCalled();
  });

  it('flushes pending work synchronously on unmount when the host opts in', async () => {
    const persist = vi.fn(async () => {});
    const { result, unmount } = renderHook(() =>
      useDebouncedSave(persist, { flushOnUnmount: true })
    );

    act(() => result.current.queueSave());
    await advance(100);
    unmount();
    expect(persist).toHaveBeenCalledOnce();

    await advance(5000);
    expect(persist).toHaveBeenCalledOnce();
  });

  it.each(['debouncing', 'queued'] as const)(
    'drains the final %s write after an in-flight save when unmount flushing is enabled',
    async (phase) => {
      const first = gate();
      const second = gate();
      let draft = 'First draft';
      const writes: string[] = [];
      const persist = vi.fn(() => {
        writes.push(draft);
        return writes.length === 1 ? first.promise : second.promise;
      });
      const { result, unmount } = renderHook(() =>
        useDebouncedSave(persist, { flushOnUnmount: true })
      );

      act(() => void result.current.flush());
      draft = 'Final accepted draft';
      act(() => result.current.queueSave());
      if (phase === 'queued') await advance(400);
      unmount();
      expect(writes).toEqual(['First draft']);

      await act(async () => first.resolve());
      expect(writes).toEqual(['First draft', 'Final accepted draft']);
      await act(async () => second.resolve());
      await advance(5000);
      expect(persist).toHaveBeenCalledTimes(2);
    }
  );

  it('cancels an armed debounce before rehydrating the draft from the server', async () => {
    let draft = 'Discarded local draft';
    const writes: string[] = [];
    const persist = vi.fn(async () => {
      writes.push(draft);
    });
    const { result } = renderHook(() => useDebouncedSave(persist));

    act(() => result.current.queueSave());
    await advance(100);
    act(() => {
      result.current.cancelPending();
      draft = 'Authoritative server draft';
      result.current.setSaveState('idle');
    });
    await advance(5000);
    expect(persist).not.toHaveBeenCalled();
    expect(result.current.saveState).toBe('idle');

    draft = 'Intentional new edit';
    act(() => result.current.queueSave());
    await advance(400);
    expect(writes).toEqual(['Intentional new edit']);
  });

  it('cancels both a queued rerun and a debounce without aborting the already sent write', async () => {
    const pending = gate();
    let draft = 'Already sent draft';
    const writes: string[] = [];
    const persist = vi.fn(() => {
      writes.push(draft);
      return pending.promise;
    });
    const { result } = renderHook(() => useDebouncedSave(persist));

    act(() => void result.current.flush());
    draft = 'Discarded queued draft';
    act(() => {
      void result.current.flush();
      result.current.queueSave();
    });
    act(() => {
      result.current.cancelPending();
      draft = 'Authoritative server draft';
    });

    await act(async () => pending.resolve());
    await advance(5000);
    expect(writes).toEqual(['Already sent draft']);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('honors a custom delayMs', async () => {
    const persist = vi.fn(async () => {});
    const { result } = renderHook(() => useDebouncedSave(persist, { delayMs: 50 }));

    act(() => result.current.queueSave());
    await advance(50);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
