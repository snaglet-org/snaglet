import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSidebarWidth } from './useSidebarWidth';

const KEY = 'snaglet.dashboard.sidebarWidth';

afterEach(() => localStorage.removeItem(KEY));

describe('useSidebarWidth, the dashboard sidebar', () => {
  it('opens a new install at 320px, wide enough for most seeded names, and remembers it', () => {
    localStorage.removeItem(KEY);
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(320);
    expect(localStorage.getItem(KEY)).toBe('320');
  });

  it('keeps a width the person already has, so the new default never resizes an install', () => {
    localStorage.setItem(KEY, '280');
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(280);
    expect(localStorage.getItem(KEY)).toBe('280');
  });

  it('goes back to the default on reset', () => {
    localStorage.setItem(KEY, '410');
    const { result } = renderHook(() => useSidebarWidth());
    act(() => result.current.resetWidth());
    expect(result.current.width).toBe(320);
  });
});
