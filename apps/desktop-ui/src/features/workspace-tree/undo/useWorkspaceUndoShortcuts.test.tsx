import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceUndoShortcuts } from './useWorkspaceUndoShortcuts';

const undoLast = vi.fn();
const redoLast = vi.fn();
let undoAvailable = true;
let redoAvailable = true;

vi.mock('./workspaceUndo', () => ({
  undoLast: (...args: unknown[]) => undoLast(...args),
  redoLast: (...args: unknown[]) => redoLast(...args),
  canUndo: () => undoAvailable,
  canRedo: () => redoAvailable,
}));

function Harness({ enabled = true }: { enabled?: boolean }) {
  useWorkspaceUndoShortcuts(enabled);
  return (
    <div>
      <input data-testid="text-input" />
      <textarea data-testid="composer" />
      <div contentEditable data-testid="editor" />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  undoAvailable = true;
  redoAvailable = true;
});

describe('useWorkspaceUndoShortcuts', () => {
  it('runs undo on Cmd+Z and redo on Cmd+Shift+Z', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undoLast).toHaveBeenCalledTimes(1);
    expect(redoLast).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    expect(redoLast).toHaveBeenCalledTimes(1);
    expect(undoLast).toHaveBeenCalledTimes(1);
  });

  it('accepts Ctrl as the modifier (Windows/Linux)', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true });
    expect(undoLast).toHaveBeenCalledTimes(1);
  });

  it('never fires while typing in an input, textarea, or contenteditable', () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId('text-input'), { key: 'z', metaKey: true });
    fireEvent.keyDown(screen.getByTestId('composer'), { key: 'z', metaKey: true });
    fireEvent.keyDown(screen.getByTestId('editor'), { key: 'z', metaKey: true });
    expect(undoLast).not.toHaveBeenCalled();
    expect(redoLast).not.toHaveBeenCalled();
  });

  it('stands down while focus sits in a text field even when the event bubbles', () => {
    render(<Harness />);
    const input = screen.getByTestId('text-input');
    input.focus();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undoLast).not.toHaveBeenCalled();
  });

  it('lets the event fall through when the stack is empty', () => {
    undoAvailable = false;
    render(<Harness />);
    const notPrevented = fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undoLast).not.toHaveBeenCalled();
    // fireEvent returns false only when preventDefault was called.
    expect(notPrevented).toBe(true);
  });

  it('ignores the gesture without a modifier or with Alt held', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'z' });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, altKey: true });
    expect(undoLast).not.toHaveBeenCalled();
  });

  it('does nothing while disabled', () => {
    render(<Harness enabled={false} />);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undoLast).not.toHaveBeenCalled();
  });

  it('fires exactly once when multiple surfaces mount the hook', () => {
    render(
      <>
        <Harness />
        <Harness />
      </>
    );
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undoLast).toHaveBeenCalledTimes(1);
  });
});
