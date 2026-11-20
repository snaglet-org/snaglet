/**
 * useWorkspaceEditorAutosave — pins the unmount-flush contract: a dirty
 * editor writes its current value through the onSave ref when the
 * (entity-keyed) host unmounts, a pristine editor stays silent, an
 * in-flight save absorbs the latest edit in the same serialized drain,
 * and a failed flush is caught and logged.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceEditorAutosave } from './useWorkspaceEditorAutosave';

interface Gate {
  promise: Promise<string>;
  resolve: (value: string) => void;
}

/** An onSave double the test resolves by hand, to hold a save in flight. */
function gate(): Gate {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  vi.restoreAllMocks();
});

describe('useWorkspaceEditorAutosave unmount flush', () => {
  it('adopts an external document update while pristine without saving it back', async () => {
    const onSave = vi.fn(async (next: string) => next);
    const { result, rerender } = renderHook(
      ({ savedValue }: { savedValue: string }) =>
        useWorkspaceEditorAutosave({ savedValue, onSave }),
      { initialProps: { savedValue: 'before' } }
    );

    rerender({ savedValue: 'updated by agent' });

    expect(result.current.value).toBe('updated by agent');
    expect(result.current.state).toBe('pristine');
    await advance(1000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('preserves an unsaved local draft when an external document update arrives', () => {
    const onSave = vi.fn(async (next: string) => next);
    const { result, rerender } = renderHook(
      ({ savedValue }: { savedValue: string }) =>
        useWorkspaceEditorAutosave({ savedValue, onSave }),
      { initialProps: { savedValue: 'before' } }
    );

    act(() => result.current.onChange('local draft'));
    rerender({ savedValue: 'updated by agent' });

    expect(result.current.value).toBe('local draft');
    expect(result.current.state).toBe('dirty');
  });

  it('adopts an external update while the local save indicator is still visible', async () => {
    const onSave = vi.fn(async (next: string) => next);
    const { result, rerender } = renderHook(
      ({ savedValue }: { savedValue: string }) =>
        useWorkspaceEditorAutosave({ savedValue, onSave }),
      { initialProps: { savedValue: 'before' } }
    );

    act(() => result.current.onChange('local save'));
    await advance(600);
    expect(result.current.state).toBe('saved');

    rerender({ savedValue: 'newer agent edit' });

    expect(result.current.value).toBe('newer agent edit');
    expect(result.current.state).toBe('pristine');
  });

  it('flushes a pending dirty edit through onSave on unmount', async () => {
    const onSave = vi.fn(async (next: string) => next);
    const { result, unmount } = renderHook(() =>
      useWorkspaceEditorAutosave({ savedValue: 'a', onSave })
    );

    act(() => result.current.onChange('a draft'));
    expect(onSave).not.toHaveBeenCalled();

    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('a draft');

    // The canceled debounce timer must not fire a second save.
    await advance(5000);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('stays silent on unmount when the editor is pristine', () => {
    const onSave = vi.fn(async (next: string) => next);
    const { unmount } = renderHook(() => useWorkspaceEditorAutosave({ savedValue: 'a', onSave }));

    unmount();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('stays silent on unmount when the user typed back to the baseline', () => {
    const onSave = vi.fn(async (next: string) => next);
    const { result, unmount } = renderHook(() =>
      useWorkspaceEditorAutosave({ savedValue: 'a', onSave })
    );

    act(() => result.current.onChange('ab'));
    act(() => result.current.onChange('a'));

    unmount();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('queues behind an in-flight save instead of double-saving; the re-run ships the latest value', async () => {
    const gates: Gate[] = [];
    const onSave = vi.fn(() => {
      const g = gate();
      gates.push(g);
      return g.promise;
    });
    const { result, unmount } = renderHook(() =>
      useWorkspaceEditorAutosave({ savedValue: 'a', onSave })
    );

    act(() => result.current.onChange('b'));
    await advance(600);
    expect(onSave).toHaveBeenCalledTimes(1);

    // A newer edit lands while the save is in flight, then the host
    // unmounts before its debounce fires.
    act(() => result.current.onChange('bc'));
    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);

    // First save resolves → finally-block re-runs with the latest value.
    await act(async () => {
      gates[0]!.resolve('b');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith('bc');
  });

  it('still saves the latest edit on unmount when the in-flight save fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectFirst!: (err: Error) => void;
    const onSave = vi
      .fn<(next: string) => Promise<string>>()
      .mockImplementationOnce(
        () =>
          new Promise<string>((_, reject) => {
            rejectFirst = reject;
          })
      )
      .mockImplementation(async (next) => next);
    const { result, unmount } = renderHook(() =>
      useWorkspaceEditorAutosave({ savedValue: 'a', onSave })
    );

    act(() => result.current.onChange('b'));
    await advance(600);
    expect(onSave).toHaveBeenCalledTimes(1);

    // A newer edit, then the pane closes while the first save is in flight.
    act(() => result.current.onChange('bc'));
    unmount();
    await act(async () => {
      rejectFirst(new Error('connection reset'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith('bc');
  });

  it('flush waits for an in-flight save, persists the latest queued edit, and returns its canonical value', async () => {
    const gates: Gate[] = [];
    const onSave = vi.fn(() => {
      const nextGate = gate();
      gates.push(nextGate);
      return nextGate.promise;
    });
    const { result } = renderHook(() => useWorkspaceEditorAutosave({ savedValue: 'a', onSave }));

    act(() => result.current.onChange('b'));
    await advance(600);
    expect(onSave).toHaveBeenCalledTimes(1);

    act(() => result.current.onChange('latest'));
    let flushed: Promise<string> | undefined;
    act(() => {
      flushed = result.current.flush();
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      gates[0]!.resolve('b');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith('latest');

    let canonical: string | undefined;
    await act(async () => {
      gates[1]!.resolve('latest canonical');
      canonical = await flushed;
    });

    expect(canonical).toBe('latest canonical');
    expect(result.current.value).toBe('latest canonical');
  });

  it('catches and logs a failed unmount flush', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSave = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result, unmount } = renderHook(() =>
      useWorkspaceEditorAutosave({ savedValue: 'a', onSave })
    );

    act(() => result.current.onChange('ab'));
    unmount();
    expect(onSave).toHaveBeenCalledTimes(1);

    await advance(0);
    expect(errorSpy).toHaveBeenCalledWith(
      'workspace-editor: unmount flush failed',
      expect.any(Error)
    );
  });
});

describe('useWorkspaceEditorAutosave external update during a save', () => {
  /** The distinct states an indicator passed through, in order. */
  const transitions = (states: string[]): string[] =>
    states.filter((state, i) => state !== states[i - 1]);

  it("keeps 'saving' when the saving client's own echo lands before its save resolves", async () => {
    const saveGate = gate();
    const onSave = vi.fn(() => saveGate.promise);
    const savingStates: string[] = [];
    const saving = renderHook(
      ({ savedValue }: { savedValue: string }) => {
        const autosave = useWorkspaceEditorAutosave({ savedValue, onSave });
        savingStates.push(autosave.state);
        return autosave;
      },
      { initialProps: { savedValue: 'before' } }
    );
    // A second client showing the same doc, with no save of its own.
    const otherSave = vi.fn(async (next: string) => next);
    const other = renderHook(
      ({ savedValue }: { savedValue: string }) =>
        useWorkspaceEditorAutosave({ savedValue, onSave: otherSave }),
      { initialProps: { savedValue: 'before' } }
    );

    act(() => saving.result.current.onChange('typed'));
    await advance(600);
    expect(saving.result.current.state).toBe('saving');

    // The broadcast of this very save reaches both clients before the
    // saving client's HTTP response does.
    saving.rerender({ savedValue: 'typed' });
    other.rerender({ savedValue: 'typed' });
    expect(saving.result.current.state).toBe('saving');
    expect(other.result.current.value).toBe('typed');
    expect(other.result.current.state).toBe('pristine');

    await act(async () => {
      saveGate.resolve('typed');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saving.result.current.value).toBe('typed');
    expect(transitions(savingStates)).toEqual(['pristine', 'dirty', 'saving', 'saved']);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(otherSave).not.toHaveBeenCalled();
  });

  it('never blanks the indicator while a save is in flight, even when the value is adopted', async () => {
    const onSave = vi.fn(() => gate().promise);
    const { result, rerender } = renderHook(
      ({ savedValue }: { savedValue: string }) =>
        useWorkspaceEditorAutosave({ savedValue, onSave }),
      { initialProps: { savedValue: 'before' } }
    );

    act(() => result.current.onChange('typed'));
    await advance(600);
    rerender({ savedValue: 'typed' });
    // A further external update with no local diff left is adopted as-is.
    rerender({ savedValue: 'from elsewhere' });

    expect(result.current.value).toBe('from elsewhere');
    expect(result.current.state).toBe('saving');
  });
});
