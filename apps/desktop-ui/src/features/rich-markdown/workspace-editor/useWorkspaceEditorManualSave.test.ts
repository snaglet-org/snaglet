/**
 * useWorkspaceEditorManualSave — the explicit-Save contract the thread
 * system prompt and project description editors rely on: nothing is sent
 * while typing, typed text is never rewritten (not by a trimming save, not
 * by a `savedValue` echo), a failed save keeps the draft, and an unsaved
 * draft survives an unmount.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceEditorManualSave } from './useWorkspaceEditorManualSave';

type Props = { savedValue: string; onSave: (next: string) => Promise<string | void> };

function setup(initial: Props, draftKey?: string) {
  return renderHook(
    ({ savedValue, onSave }: Props) =>
      useWorkspaceEditorManualSave({ savedValue, onSave, draftKey }),
    { initialProps: initial }
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useWorkspaceEditorManualSave', () => {
  it('sends nothing while typing; spaces and newlines stay exactly as typed', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn(async (next: string) => next);
    const { result } = setup({ savedValue: 'Be brief.', onSave });

    expect(result.current.dirty).toBe(false);
    expect(result.current.state).toBe('pristine');

    const typed = ['Be brief.', 'Be brief. ', 'Be brief.  ', 'Be brief.  \n', 'Be brief.  \n\nNo '];
    for (const v of typed) act(() => result.current.onChange(v));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(result.current.value).toBe('Be brief.  \n\nNo ');
    expect(result.current.dirty).toBe(true);
    expect(result.current.state).toBe('dirty');
  });

  it('typing back to the saved value is clean again (Save disables)', () => {
    const { result } = setup({ savedValue: 'abc', onSave: vi.fn() });
    act(() => result.current.onChange('abcd'));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.onChange('abc'));
    expect(result.current.dirty).toBe(false);
  });

  it('a save that trims whitespace keeps the draft as typed and reads clean', async () => {
    const onSave = vi.fn(async (next: string) => next.trimEnd());
    const { result, rerender } = setup({ savedValue: '', onSave });

    act(() => result.current.onChange('Line one\n\n  '));
    await act(async () => {
      await expect(result.current.flush()).resolves.toBe('Line one');
    });

    expect(onSave).toHaveBeenCalledWith('Line one\n\n  ');
    // The editor is not rewritten with the trimmed value: no caret jump.
    expect(result.current.value).toBe('Line one\n\n  ');
    expect(result.current.dirty).toBe(false);
    expect(result.current.state).toBe('saved');

    // The host mirrors the canonical value into the prop (the echo).
    rerender({ savedValue: 'Line one', onSave });
    expect(result.current.value).toBe('Line one\n\n  ');
    expect(result.current.dirty).toBe(false);

    // Typing on from the kept draft is a real change again.
    act(() => result.current.onChange('Line one\n\n  more'));
    expect(result.current.dirty).toBe(true);
  });

  it('an echoed or remote savedValue never overwrites a dirty draft', () => {
    const onSave = vi.fn(async (next: string) => next);
    const { result, rerender } = setup({ savedValue: 'v1', onSave });

    act(() => result.current.onChange('v1 my edit '));
    rerender({ savedValue: 'v2 from another client', onSave });

    expect(result.current.value).toBe('v1 my edit ');
    expect(result.current.dirty).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('adopts a remote savedValue while clean', () => {
    const { result, rerender } = setup({ savedValue: 'v1', onSave: vi.fn() });
    rerender({ savedValue: 'v2', onSave: vi.fn() });
    expect(result.current.value).toBe('v2');
    expect(result.current.dirty).toBe(false);
  });

  it('edits typed while a save is in flight stay and stay dirty', async () => {
    let resolve!: (v: string) => void;
    const onSave = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolve = res;
        })
    );
    const { result } = setup({ savedValue: '', onSave });
    act(() => result.current.onChange('first'));
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.flush();
    });
    expect(result.current.state).toBe('saving');
    act(() => result.current.onChange('first second'));
    await act(async () => {
      resolve('first');
      await pending;
    });
    expect(result.current.value).toBe('first second');
    expect(result.current.dirty).toBe(true);
    expect(result.current.state).toBe('dirty');
  });

  it('a failed save keeps the draft and shows the error', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('Network down');
    });
    const { result } = setup({ savedValue: 'old', onSave });
    act(() => result.current.onChange('new text '));
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('Network down');
    });
    expect(result.current.value).toBe('new text ');
    expect(result.current.dirty).toBe(true);
    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('Network down');
  });

  it('flush on a clean draft sends nothing', async () => {
    const onSave = vi.fn();
    const { result } = setup({ savedValue: 'same', onSave });
    await act(async () => {
      await expect(result.current.flush()).resolves.toBe('same');
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('discard brings the saved value back', () => {
    const { result } = setup({ savedValue: 'saved', onSave: vi.fn() });
    act(() => result.current.onChange('scratch'));
    act(() => result.current.discard());
    expect(result.current.value).toBe('saved');
    expect(result.current.dirty).toBe(false);
  });

  it('an unsaved draft survives an unmount and comes back dirty', () => {
    const key = 'snaglet:draft:test-manual';
    const first = setup({ savedValue: 'saved', onSave: vi.fn() }, key);
    act(() => first.result.current.onChange('half-typed '));
    first.unmount();

    const second = setup({ savedValue: 'saved', onSave: vi.fn() }, key);
    expect(second.result.current.value).toBe('half-typed ');
    expect(second.result.current.dirty).toBe(true);
  });

  it('a successful save clears the stored draft', async () => {
    const key = 'snaglet:draft:test-manual-clear';
    const first = setup({ savedValue: '', onSave: vi.fn(async (n: string) => n) }, key);
    act(() => first.result.current.onChange('kept'));
    await act(async () => {
      await first.result.current.flush();
    });
    first.unmount();
    expect(localStorage.getItem(key)).toBeNull();
  });
});
