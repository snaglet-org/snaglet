import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock('@desktop/utils/toast', () => toast);

import {
  __resetCalendarUndoForTests,
  calendarUndoState,
  offerUndo,
  onCalendarUndoChange,
  recordStep,
  redoCalendarStep,
  undoCalendarStep,
  useCalendarUndoShortcuts,
  type UndoableStep,
} from './calendarUndo';

function step(label: string, log: string[]): UndoableStep {
  return {
    label,
    undo: async () => void log.push(`undo ${label}`),
    redo: async () => void log.push(`redo ${label}`),
  };
}

function Shortcuts({ active }: { active: boolean }) {
  useCalendarUndoShortcuts(active);
  return (
    <div>
      <button type="button">item</button>
      <input aria-label="search" />
    </div>
  );
}

describe('calendar undo stack', () => {
  beforeEach(() => {
    __resetCalendarUndoForTests();
    toast.showToast.mockReset();
    toast.dismissToast.mockReset();
  });
  afterEach(() => __resetCalendarUndoForTests());

  it('undoes newest first, redoes, and a new step clears redo', async () => {
    const log: string[] = [];
    recordStep(step('a', log));
    recordStep(step('b', log));
    await undoCalendarStep();
    expect(log).toEqual(['undo b']);
    expect(calendarUndoState()).toEqual({ undo: 'a', redo: 'b' });
    await redoCalendarStep();
    expect(log).toEqual(['undo b', 'redo b']);
    await undoCalendarStep();
    recordStep(step('c', log));
    expect(calendarUndoState()).toEqual({ undo: 'c', redo: null });
  });

  it('undoing a step by Cmd+Z dismisses its Undo toast, and the stale toast cannot undo twice', async () => {
    const log: string[] = [];
    offerUndo('Deleted Standup', step('delete', log));
    const { id } = toast.showToast.mock.calls[0]![1] as { id: string };
    expect(id).toEqual(expect.any(String));
    render(<Shortcuts active />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }));
    await vi.waitFor(() => expect(log).toEqual(['undo delete']));
    expect(toast.dismissToast).toHaveBeenCalledWith(id);
    // The stale toast's Undo can't undo again (step already off the stack).
    const { action } = toast.showToast.mock.calls[0]![1] as { action: { run: () => void } };
    action.run();
    await undoCalendarStep();
    expect(log).toEqual(['undo delete']);
    await redoCalendarStep();
    expect(log).toEqual(['undo delete', 'redo delete']);
    expect(toast.dismissToast).toHaveBeenCalledTimes(1);
  });

  it('the toast Undo runs the same stack, at most once', async () => {
    const log: string[] = [];
    const changes = vi.fn();
    onCalendarUndoChange(changes);
    offerUndo('Moved Pay rent to Tue Oct 13', step('move', log));
    const { action } = toast.showToast.mock.calls[0]![1] as { action: { run: () => void } };
    action.run();
    action.run();
    await undoCalendarStep(); // nothing left
    expect(log).toEqual(['undo move']);
    expect(calendarUndoState().undo).toBeNull();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('an older toast undoes its own step out of order', async () => {
    const log: string[] = [];
    const a = step('a', log);
    recordStep(a);
    recordStep(step('b', log));
    await undoCalendarStep(a);
    expect(log).toEqual(['undo a']);
    expect(calendarUndoState()).toEqual({ undo: 'b', redo: null });
  });

  it('a failed undo toasts and is not redoable', async () => {
    recordStep({ label: 'x', undo: () => Promise.reject(new Error('gone')) });
    await undoCalendarStep();
    expect(toast.showToast).toHaveBeenCalledWith('gone');
    expect(calendarUndoState()).toEqual({ undo: null, redo: null });
  });

  it('Cmd+Z: capture phase, only while active, never in text fields; consumed even when empty', async () => {
    const log: string[] = [];
    const bubble = vi.fn();
    window.addEventListener('keydown', bubble);
    const { rerender, getByRole, getByLabelText } = render(<Shortcuts active={false} />);
    recordStep(step('a', log));
    const item = getByRole('button');
    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    expect(log).toEqual([]);
    expect(bubble).toHaveBeenCalledTimes(1);

    rerender(<Shortcuts active />);
    const input = getByLabelText('search');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    expect(log).toEqual([]);
    expect(bubble).toHaveBeenCalledTimes(2);

    item.focus();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['undo a']);
    expect(bubble).toHaveBeenCalledTimes(2); // stopped before the workspace undo

    item.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Z', metaKey: true, shiftKey: true, bubbles: true })
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['undo a', 'redo a']);

    __resetCalendarUndoForTests();
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    expect(bubble).toHaveBeenCalledTimes(2); // empty stack: still consumed
    window.removeEventListener('keydown', bubble);
  });
});
