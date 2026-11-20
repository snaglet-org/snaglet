/**
 * An active pane ignores mousedown, so the press that starts a text selection
 * inside it does not push a layout update (`onSelectLeaf`) that re-renders
 * the pane tree mid-gesture and drops the selection. An inactive pane still
 * activates on first press.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LayoutLeaf } from '../../layout/paneTree';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

// The pane body is irrelevant here — mock the router to a plain text node
// (which is exactly the kind of content the user selects).
vi.mock('../../views/DetailRouter.js', () => ({
  DetailRouter: () => <div>selectable message text</div>,
}));
vi.mock('../PaneHistoryNav/PaneHistoryNav.js', () => ({ PaneHistoryNav: () => null }));
vi.mock('../PathHeader/PathHeader.js', () => ({ PathHeader: () => null }));
vi.mock('../PathHeader/useNodeAncestors.js', () => ({ useNodeAncestors: () => [] }));

import { PaneChrome } from './PaneChrome';

function makeLeaf(): LayoutLeaf {
  return { kind: 'leaf', id: 'leaf-1', selection: null, history: { entries: [], index: -1 } };
}

function renderPane(isActive: boolean, options: { onOpenInSidebar?: () => void } = {}) {
  const onActivate = vi.fn();
  render(
    <PaneChrome
      leaf={makeLeaf()}
      isActive={isActive}
      onActivate={onActivate}
      onOpenInSidebar={options.onOpenInSidebar}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={vi.fn()}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
    />
  );
  return { onActivate };
}

describe('PaneChrome activation guard', () => {
  it('does NOT re-activate on mousedown when the pane is already active (text selection survives)', () => {
    const { onActivate } = renderPane(true);
    fireEvent.mouseDown(screen.getByText('selectable message text'));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('still activates an inactive pane on first mousedown', () => {
    const { onActivate } = renderPane(false);
    fireEvent.mouseDown(screen.getByText('selectable message text'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe('PaneChrome keyboard activation', () => {
  function focusTarget() {
    return screen.getByRole('button', { name: 'Close pane' });
  }

  it('activates an inactive pane when the keyboard moves focus into it', () => {
    const { onActivate } = renderPane(false);
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.focus(focusTarget());
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('ignores focus a view moves on its own or a pointer press already handled', () => {
    const { onActivate } = renderPane(false);
    fireEvent.focus(focusTarget());
    fireEvent.pointerDown(window);
    fireEvent.focus(focusTarget());
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not re-activate an already active pane on focus', () => {
    const { onActivate } = renderPane(true);
    fireEvent.keyDown(window, { key: 'Tab' });
    fireEvent.focus(focusTarget());
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe('PaneChrome empty pane', () => {
  it('hides "Open in sidebar" when the pane shows nothing', () => {
    renderPane(true, { onOpenInSidebar: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Open in sidebar' })).not.toBeInTheDocument();
  });

  it('does not activate a background pane when its Close button is pressed', () => {
    const { onActivate } = renderPane(false);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Close pane' }));
    expect(onActivate).not.toHaveBeenCalled();
  });
});
