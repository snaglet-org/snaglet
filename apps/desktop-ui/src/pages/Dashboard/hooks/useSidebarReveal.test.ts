import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarViewId } from '../sidebar';
import { useSidebarReveal } from './useSidebarReveal';

interface Props {
  sidebarOpen: boolean;
  sidebarView: SidebarViewId;
}

function setup(initialProps: Props) {
  const setSidebarOpen = vi.fn();
  const setSidebarView = vi.fn();
  const hook = renderHook(
    (props: Props) => useSidebarReveal({ ...props, setSidebarOpen, setSidebarView }),
    { initialProps }
  );
  return { ...hook, setSidebarOpen, setSidebarView };
}

describe('useSidebarReveal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reveals at once in the view that is showing', () => {
    const { result } = setup({ sidebarOpen: true, sidebarView: 'tools' });

    act(() => result.current.requestReveal('tool-a', 'tools'));

    expect(result.current.pendingRevealId).toBe('tool-a');
    expect(result.current.revealTargetView).toBe('tools');
  });

  it('drops the reveal once the sidebar shows another view, so a return starts fresh', () => {
    const { result, rerender } = setup({ sidebarOpen: true, sidebarView: 'tools' });
    act(() => result.current.requestReveal('tool-a', 'tools'));

    rerender({ sidebarOpen: true, sidebarView: 'library' });
    expect(result.current.pendingRevealId).toBeNull();

    rerender({ sidebarOpen: true, sidebarView: 'tools' });
    expect(result.current.pendingRevealId).toBeNull();
  });

  it('drops the reveal when the sidebar closes', () => {
    const { result, rerender } = setup({ sidebarOpen: true, sidebarView: 'tools' });
    act(() => result.current.requestReveal('tool-a', 'tools'));

    rerender({ sidebarOpen: false, sidebarView: 'tools' });

    expect(result.current.pendingRevealId).toBeNull();
  });

  it('replays a reveal requested for another view once the sidebar is on it', () => {
    const { result, rerender, setSidebarView } = setup({
      sidebarOpen: true,
      sidebarView: 'library',
    });

    act(() => result.current.requestReveal('tool-a', 'tools'));
    expect(setSidebarView).toHaveBeenCalledWith('tools');
    expect(result.current.pendingRevealId).toBeNull();

    rerender({ sidebarOpen: true, sidebarView: 'tools' });
    act(() => vi.runAllTimers());

    expect(result.current.pendingRevealId).toBe('tool-a');
    expect(result.current.revealTargetView).toBe('tools');
  });

  it('opens a closed sidebar and replays the reveal there', () => {
    const { result, rerender, setSidebarOpen } = setup({
      sidebarOpen: false,
      sidebarView: 'tools',
    });

    act(() => result.current.requestReveal('tool-a', 'tools'));
    expect(setSidebarOpen).toHaveBeenCalledWith(true);

    rerender({ sidebarOpen: true, sidebarView: 'tools' });
    act(() => vi.runAllTimers());

    expect(result.current.pendingRevealId).toBe('tool-a');
  });
});
