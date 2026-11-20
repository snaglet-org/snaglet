import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePaneHistoryShortcuts } from './usePaneHistoryShortcuts';

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const BACK = { key: '[', metaKey: true };
const FORWARD = { key: ']', metaKey: true };
const HISTORY = { key: 'y', metaKey: true };
const UP = { key: 'ArrowUp', metaKey: true };

function renderShortcuts(
  options: { isActive?: boolean; canGoBack?: boolean; withParent?: boolean } = {}
) {
  const { isActive = true, canGoBack = true, withParent = true } = options;
  const targets = {
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onOpenHistory: vi.fn(),
    onGoUp: vi.fn(),
  };
  renderHook(() =>
    usePaneHistoryShortcuts(isActive, {
      canGoBack,
      canGoForward: true,
      onGoBack: targets.onGoBack,
      onGoForward: targets.onGoForward,
      onOpenHistory: targets.onOpenHistory,
      onGoUp: withParent ? targets.onGoUp : null,
    })
  );
  return targets;
}

function append<T extends HTMLElement>(element: T): T {
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('usePaneHistoryShortcuts', () => {
  it('steps back on ⌘[ and forward on ⌘] in the active pane', () => {
    const { onGoBack, onGoForward } = renderShortcuts();
    expect(press(BACK).defaultPrevented).toBe(true);
    press(FORWARD);
    press({ key: '[', ctrlKey: true });
    expect(onGoBack).toHaveBeenCalledTimes(2);
    expect(onGoForward).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an inactive pane', () => {
    const { onGoBack, onOpenHistory } = renderShortcuts({ isActive: false });
    press(BACK);
    press(HISTORY);
    expect(onGoBack).not.toHaveBeenCalled();
    expect(onOpenHistory).not.toHaveBeenCalled();
  });

  it('claims ⌘[ without moving when there is nothing to go back to', () => {
    const { onGoBack } = renderShortcuts({ canGoBack: false });
    expect(press(BACK).defaultPrevented).toBe(true);
    expect(onGoBack).not.toHaveBeenCalled();
  });

  it('steps back while typing in a text field or a rich editor', () => {
    const { onGoBack } = renderShortcuts();
    press(BACK, append(document.createElement('textarea')));
    const editor = append(document.createElement('div'));
    editor.contentEditable = 'true';
    press(BACK, editor);
    expect(onGoBack).toHaveBeenCalledTimes(2);
  });

  it('leaves the key to an editor that claims it (a code editor indents on ⌘[)', () => {
    const { onGoBack } = renderShortcuts();
    const codeEditor = append(document.createElement('div'));
    codeEditor.addEventListener('keydown', (event) => event.preventDefault());
    press(BACK, codeEditor);
    expect(onGoBack).not.toHaveBeenCalled();
  });

  it('does not navigate the pane behind an open modal dialog', () => {
    const { onGoBack, onOpenHistory } = renderShortcuts();
    const dialog = append(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    dialog.appendChild(button);
    press(BACK, button);
    press(HISTORY, button);
    expect(onGoBack).not.toHaveBeenCalled();
    expect(onOpenHistory).not.toHaveBeenCalled();
  });

  it('opens Recently visited on ⌘Y, once per press', () => {
    const { onOpenHistory } = renderShortcuts();
    expect(press(HISTORY).defaultPrevented).toBe(true);
    expect(press({ ...HISTORY, repeat: true }).defaultPrevented).toBe(true);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it('leaves ⌘Y to a text field, where it redoes', () => {
    const { onOpenHistory } = renderShortcuts();
    const event = press(HISTORY, append(document.createElement('input')));
    expect(onOpenHistory).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('goes up one level on ⌘↑ outside text fields', () => {
    const { onGoUp } = renderShortcuts();
    expect(press(UP).defaultPrevented).toBe(true);
    expect(onGoUp).toHaveBeenCalledTimes(1);
  });

  it('leaves ⌘↑ to a text field, where it moves the caret to the start', () => {
    const { onGoUp } = renderShortcuts();
    const event = press(UP, append(document.createElement('textarea')));
    expect(onGoUp).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves ⌘↑ to the page when nothing is above the pane item', () => {
    renderShortcuts({ withParent: false });
    expect(press(UP).defaultPrevented).toBe(false);
  });
});
