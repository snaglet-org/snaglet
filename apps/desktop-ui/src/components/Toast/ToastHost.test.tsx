import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_TOAST_DURATION_MS, dismissToast, showToast } from '@desktop/utils/toast';
import { ToastHost } from './ToastHost';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function toastText(text: string) {
  return screen.queryByText(text);
}

describe('ToastHost', () => {
  it('keeps plain toasts unchanged: message only, gone after their duration', () => {
    render(<ToastHost />);
    act(() => showToast('Task ID copied'));
    expect(toastText('Task ID copied')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1800));
    expect(toastText('Task ID copied')).not.toBeInTheDocument();
  });

  it('dismissToast(id) closes only the toast opened with that id', () => {
    render(<ToastHost />);
    act(() => showToast('Deleted Standup', { id: 'u1', action: { label: 'Undo', run: vi.fn() } }));
    act(() => showToast('Task ID copied', { durationMs: 10_000 }));
    act(() => dismissToast('u1'));
    expect(toastText('Deleted Standup')).not.toBeInTheDocument();
    expect(toastText('Task ID copied')).toBeInTheDocument();
    act(() => dismissToast('missing'));
    expect(toastText('Task ID copied')).toBeInTheDocument();
  });

  it('replaces a shown toast that has the same id instead of stacking another', () => {
    render(<ToastHost />);
    act(() => showToast('Downloading… 10%', { id: 'progress', durationMs: 1000 }));
    act(() => vi.advanceTimersByTime(900));
    act(() => showToast('Downloading… 20%', { id: 'progress', durationMs: 1000 }));
    expect(toastText('Downloading… 10%')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Downloading…/)).toHaveLength(1);
    // The replacement restarts the timer with its own duration.
    act(() => vi.advanceTimersByTime(900));
    expect(toastText('Downloading… 20%')).toBeInTheDocument();

    const run = vi.fn();
    act(() =>
      showToast('Failed', { id: 'progress', durationMs: 1000, action: { label: 'Retry', run } })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(run).toHaveBeenCalledTimes(1);
    // Once closed, the same id opens a fresh toast.
    act(() => showToast('Again', { id: 'progress' }));
    expect(toastText('Again')).toBeInTheDocument();
    act(() => dismissToast('progress'));
    expect(toastText('Again')).not.toBeInTheDocument();
  });

  it('keeps a hovered toast up when its content is replaced', () => {
    render(<ToastHost />);
    act(() => showToast('Step 1', { id: 'steps', durationMs: 1000 }));
    fireEvent.pointerEnter(toastText('Step 1')!.parentElement!);
    act(() => showToast('Step 2', { id: 'steps', durationMs: 1000 }));
    act(() => vi.advanceTimersByTime(5000));
    expect(toastText('Step 2')).toBeInTheDocument();
    fireEvent.pointerLeave(toastText('Step 2')!.parentElement!);
    act(() => vi.advanceTimersByTime(1000));
    expect(toastText('Step 2')).not.toBeInTheDocument();
  });

  it('defaults an action toast to the longer duration', () => {
    render(<ToastHost />);
    act(() => showToast('Moved Pay rent', { action: { label: 'Undo', run: vi.fn() } }));
    act(() => vi.advanceTimersByTime(1800));
    expect(toastText('Moved Pay rent')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(ACTION_TOAST_DURATION_MS - 1800));
    expect(toastText('Moved Pay rent')).not.toBeInTheDocument();
  });

  it('runs the action at most once and closes the toast', () => {
    const run = vi.fn();
    render(<ToastHost />);
    act(() => showToast('Archived Work', { action: { label: 'Undo', run } }));
    const button = screen.getByRole('button', { name: 'Undo' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
    expect(toastText('Archived Work')).not.toBeInTheDocument();
  });

  it('pauses while hovered and restarts the full duration on leave', () => {
    render(<ToastHost />);
    act(() => showToast('Hover me', { durationMs: 1000, action: { label: 'Undo', run: vi.fn() } }));
    const toast = toastText('Hover me')!.parentElement!;
    act(() => vi.advanceTimersByTime(900));
    fireEvent.pointerEnter(toast);
    act(() => vi.advanceTimersByTime(5000));
    expect(toastText('Hover me')).toBeInTheDocument();
    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(900));
    expect(toastText('Hover me')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(100));
    expect(toastText('Hover me')).not.toBeInTheDocument();
  });

  it('pauses while focused (Tab reaches the action) and resumes on blur', () => {
    render(
      <>
        <button type="button">Elsewhere</button>
        <ToastHost />
      </>
    );
    act(() => showToast('Focus me', { durationMs: 1000, action: { label: 'Undo', run: vi.fn() } }));
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo.tabIndex).toBe(0);
    act(() => undo.focus());
    act(() => vi.advanceTimersByTime(5000));
    expect(toastText('Focus me')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    act(() => vi.advanceTimersByTime(1000));
    expect(toastText('Focus me')).not.toBeInTheDocument();
  });

  it('dismisses the focused toast on Escape without running its action', () => {
    const run = vi.fn();
    render(<ToastHost />);
    act(() => {
      showToast('First', { action: { label: 'Undo', run } });
      showToast('Second');
    });
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => undo.focus());
    fireEvent.keyDown(undo, { key: 'Escape' });
    expect(toastText('First')).not.toBeInTheDocument();
    expect(toastText('Second')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });
});
