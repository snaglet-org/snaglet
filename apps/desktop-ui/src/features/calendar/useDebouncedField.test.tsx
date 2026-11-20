import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedField } from './useDebouncedField';

describe('useDebouncedField', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves once, 400 ms after typing stops, with the pre-burst value', () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useDebouncedField('Gym', commit));
    act(() => result.current.setValue('Gym '));
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current.setValue('Gym w'));
    act(() => vi.advanceTimersByTime(300));
    act(() => result.current.setValue('Gym with Sam'));
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('Gym with Sam', 'Gym');
  });

  it('flush saves now; nothing pending saves nothing', () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useDebouncedField('a', commit));
    act(() => result.current.flush());
    expect(commit).not.toHaveBeenCalled();
    act(() => result.current.setValue('ab'));
    act(() => result.current.flush());
    expect(commit).toHaveBeenCalledWith('ab', 'a');
    act(() => vi.advanceTimersByTime(1000));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('unmount flushes a pending save (Esc closes, flushing)', () => {
    const commit = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedField('x', commit));
    act(() => result.current.setValue('xy'));
    unmount();
    expect(commit).toHaveBeenCalledWith('xy', 'x');
  });

  it('a second burst starts from the last saved value', () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useDebouncedField('1', commit));
    act(() => result.current.setValue('12'));
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.setValue('123'));
    act(() => vi.advanceTimersByTime(400));
    expect(commit.mock.calls).toEqual([
      ['12', '1'],
      ['123', '12'],
    ]);
  });
});
