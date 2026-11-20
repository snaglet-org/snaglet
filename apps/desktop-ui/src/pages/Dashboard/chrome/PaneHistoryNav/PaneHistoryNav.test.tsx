import { createRef } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneHistory } from '../../layout/paneTree';
import { PaneHistoryNav, type PaneHistoryNavHandle } from './PaneHistoryNav';

afterEach(() => vi.restoreAllMocks());

const history: PaneHistory = {
  entries: [{ kind: 'providers' }, { kind: 'storage' }],
  index: 1,
};

function renderNav() {
  render(
    <PaneHistoryNav
      history={history}
      canGoBack
      canGoForward={false}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpTo={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Recently visited' }));
  return screen.getByRole('menu', { name: 'Recently visited' });
}

function pressEscape(claimedAbove = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  if (claimedAbove) event.preventDefault();
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

describe('PaneHistoryNav menu rows', () => {
  it('lists a place visited several times once, newest first, with the current one marked', () => {
    const onJumpTo = vi.fn();
    render(
      <PaneHistoryNav
        history={{
          entries: [
            { kind: 'providers' },
            { kind: 'storage' },
            { kind: 'providers' },
            { kind: 'theme' },
            { kind: 'providers' },
          ],
          index: 4,
        }}
        canGoBack
        canGoForward={false}
        onGoBack={vi.fn()}
        onGoForward={vi.fn()}
        onJumpTo={onJumpTo}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recently visited' }));
    const menu = screen.getByRole('menu', { name: 'Recently visited' });

    const rows = within(menu).getAllByRole('menuitem');
    expect(rows.map((row) => row.querySelector('[data-row-label]')?.textContent)).toEqual([
      'Providers',
      'Theme',
      'Local storage',
    ]);
    expect(rows[0]).toHaveAttribute('aria-current', 'page');
    expect(rows[1]).not.toHaveAttribute('aria-current');

    fireEvent.click(rows[2]);
    expect(onJumpTo).toHaveBeenCalledWith(1);
  });
});

describe('PaneHistoryNav shortcuts', () => {
  it("names each button's shortcut in its tooltip", () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    render(
      <PaneHistoryNav
        history={history}
        canGoBack
        canGoForward={false}
        onGoBack={vi.fn()}
        onGoForward={vi.fn()}
        onJumpTo={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Back to Providers' })).toHaveAttribute(
      'title',
      'Back to Providers (⌘[)'
    );
    expect(screen.getByRole('button', { name: 'No later entry' })).toHaveAttribute(
      'title',
      'No later entry (⌘])'
    );
    const trigger = screen.getByRole('button', { name: 'Recently visited' });
    expect(trigger).toHaveAttribute('title', 'Recently visited (⌘Y)');
    expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Meta+Y');
  });

  it('opens the menu through its handle, and not for an empty pane', () => {
    const handle = createRef<PaneHistoryNavHandle>();
    const props = {
      canGoBack: false,
      canGoForward: false,
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onJumpTo: vi.fn(),
    };
    const { rerender } = render(
      <PaneHistoryNav ref={handle} history={{ entries: [], index: -1 }} {...props} />
    );
    act(() => handle.current?.openMenu());
    expect(screen.queryByRole('menu')).toBeNull();

    rerender(<PaneHistoryNav ref={handle} history={history} {...props} />);
    act(() => handle.current?.openMenu());
    expect(screen.getByRole('menu', { name: 'Recently visited' })).toBeInTheDocument();
  });
});

describe('PaneHistoryNav menu dismissal', () => {
  it('closes on Escape and claims the key so an outer layer stays open', () => {
    renderNav();

    const event = pressEscape();

    expect(screen.queryByRole('menu')).toBeNull();
    expect(event.defaultPrevented).toBe(true);
  });

  it('stays open when a surface above already handled Escape', () => {
    renderNav();

    pressEscape(true);

    expect(screen.getByRole('menu', { name: 'Recently visited' })).toBeInTheDocument();
  });

  it('closes on an outside press but not on the back button', () => {
    renderNav();

    fireEvent.pointerDown(screen.getByRole('button', { name: /Back to/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('PaneHistoryNav menu keyboard', () => {
  // Rows, newest first: Theme (current), Local storage, Home.
  const threePlaces: PaneHistory = {
    entries: [{ kind: 'hub' }, { kind: 'storage' }, { kind: 'theme' }],
    index: 2,
  };

  /**
   * Focus a stand-in for where the user was typing, then open the menu the
   * way ⌘Y does.
   */
  function openFromKeyboard(overrides: { onOpenInSplit?: () => void } = {}) {
    const onJumpTo = vi.fn();
    const onOpenInSplit = overrides.onOpenInSplit ?? vi.fn();
    const handle = createRef<PaneHistoryNavHandle>();
    render(
      <>
        <textarea aria-label="Doc editor" />
        <button type="button">Elsewhere</button>
        <PaneHistoryNav
          ref={handle}
          history={threePlaces}
          canGoBack
          canGoForward={false}
          onGoBack={vi.fn()}
          onGoForward={vi.fn()}
          onJumpTo={onJumpTo}
          onOpenInSplit={onOpenInSplit}
        />
      </>
    );
    const editor = screen.getByRole('textbox', { name: 'Doc editor' });
    editor.focus();
    act(() => handle.current?.openMenu());
    const menu = screen.getByRole('menu', { name: 'Recently visited' });
    const rows = within(menu).getAllByRole('menuitem');
    return { onJumpTo, onOpenInSplit, handle, editor, menu, rows };
  }

  function key(target: Element, init: KeyboardEventInit) {
    fireEvent.keyDown(target, init);
  }

  it('moves focus into the menu, onto the place before the current one', () => {
    const { rows } = openFromKeyboard();
    expect(rows[1]).toHaveTextContent('Local storage');
    expect(rows[1]).toHaveFocus();
  });

  it('moves between rows with the arrow keys, Home and End, wrapping at the ends', () => {
    const { rows } = openFromKeyboard();
    key(rows[1], { key: 'ArrowDown' });
    expect(rows[2]).toHaveFocus();
    key(rows[2], { key: 'ArrowDown' });
    expect(rows[0]).toHaveFocus();
    key(rows[0], { key: 'ArrowUp' });
    expect(rows[2]).toHaveFocus();
    key(rows[2], { key: 'Home' });
    expect(rows[0]).toHaveFocus();
    key(rows[0], { key: 'End' });
    expect(rows[2]).toHaveFocus();
  });

  it('opens the focused row in this pane on Enter and gives focus back', () => {
    const { rows, onJumpTo, editor } = openFromKeyboard();
    key(rows[1], { key: 'Enter' });
    expect(onJumpTo).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(editor).toHaveFocus();
  });

  it('opens the focused row in a new pane beside this one on ⌘Enter', () => {
    const { rows, onJumpTo, onOpenInSplit } = openFromKeyboard();
    key(rows[1], { key: 'ArrowDown' });
    key(rows[2], { key: 'Enter', metaKey: true });
    expect(onOpenInSplit).toHaveBeenCalledWith({ kind: 'hub' });
    expect(onJumpTo).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a row in a new pane on ⌘-click', () => {
    const onOpenInSplit = vi.fn();
    const { rows } = openFromKeyboard({ onOpenInSplit });
    fireEvent.click(rows[1], { metaKey: true });
    expect(onOpenInSplit).toHaveBeenCalledWith({ kind: 'storage' });
  });

  it('shows 1 to 9 on the rows and opens the Nth row on that number', () => {
    const { rows, onJumpTo } = openFromKeyboard();
    expect(rows.map((row) => row.querySelector('[data-row-hint]')?.textContent)).toEqual([
      '1',
      '2',
      '3',
    ]);
    key(rows[1], { key: '3' });
    expect(onJumpTo).toHaveBeenCalledWith(0);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ignores a number with no row', () => {
    const { rows, onJumpTo } = openFromKeyboard();
    key(rows[1], { key: '7' });
    expect(onJumpTo).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('jumps to the next row starting with a typed letter, or letters typed together', () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { rows } = openFromKeyboard();
    key(rows[1], { key: 'h' });
    expect(rows[2]).toHaveFocus();
    now += 1_000;
    key(rows[2], { key: 'l' });
    expect(rows[1]).toHaveFocus();
    now += 1_000;
    key(rows[1], { key: 't' });
    expect(rows[0]).toHaveFocus();
    now += 100;
    key(rows[0], { key: 'h' });
    expect(rows[0]).toHaveFocus();
  });

  it('closes on Escape and gives focus back to where it was', () => {
    const { rows, editor } = openFromKeyboard();
    act(() => {
      rows[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(editor).toHaveFocus();
  });

  it('closes on Tab and gives focus back', () => {
    const { rows, editor } = openFromKeyboard();
    key(rows[1], { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(editor).toHaveFocus();
  });

  it('closes when focus moves somewhere else, leaving focus there', () => {
    openFromKeyboard();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(elsewhere).toHaveFocus();
  });

  it('closes again on a second ⌘Y', () => {
    const { handle, editor } = openFromKeyboard();
    act(() => handle.current?.openMenu());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(editor).toHaveFocus();
  });
});
