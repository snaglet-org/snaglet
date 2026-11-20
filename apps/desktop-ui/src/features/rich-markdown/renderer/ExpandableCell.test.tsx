import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CellClampContext, ExpandableCell } from './ExpandableCell';
import styles from './ExpandableCell.module.scss';

function renderCell(
  children: ReactNode,
  {
    clamp = true,
    onSurfaceDoubleClick,
  }: { clamp?: boolean; onSurfaceDoubleClick?: () => void } = {}
) {
  return render(
    <CellClampContext.Provider value={clamp}>
      <div onDoubleClick={onSurfaceDoubleClick}>
        <table>
          <tbody>
            <tr>
              <ExpandableCell>{children}</ExpandableCell>
            </tr>
          </tbody>
        </table>
      </div>
    </CellClampContext.Provider>
  );
}

const LONG =
  'a very long, text-heavy cell that would otherwise run its row tall — ' +
  'it shows two lines and opens in place on a click';

/** The cell's more/less button, under either of its names. */
const toggle = () => screen.getByRole('button', { name: /^Show (the whole cell|less)$/ });
const queryToggle = () => screen.queryByRole('button', { name: /^Show (the whole cell|less)$/ });

/**
 * jsdom has no layout: give the clamped box two lines (40px) and let text
 * longer than 40 characters run past them, as a real narrow column would.
 */
beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(40);
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return (this.textContent ?? '').length > 40 ? 120 : 40;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe('ExpandableCell (two-line clamp, opens in place)', () => {
  it('renders a short cell as a plain cell: no toggle, clicks do nothing', () => {
    const onSurfaceDoubleClick = vi.fn();
    renderCell('short cell', { onSurfaceDoubleClick });
    const cell = screen.getByRole('cell');
    expect(cell).toHaveTextContent('short cell');
    expect(screen.queryByRole('button')).toBeNull();

    fireEvent.click(cell);
    expect(screen.queryByRole('button')).toBeNull();
    expect(cell.firstElementChild).toHaveClass(styles.clamped);
    fireEvent.doubleClick(cell);
    expect(onSurfaceDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the whole text in the DOM, clamps it with CSS and adds no button role to it', () => {
    renderCell(LONG);
    const content = screen.getByRole('cell').firstElementChild!;
    expect(content).toHaveTextContent(LONG);
    expect(content).toHaveClass(styles.clamped);
    expect(content).not.toHaveAttribute('role');
    expect(content).not.toHaveAttribute('tabindex');
  });

  it('adds a "more" button under the text only when it overflows; a cell click opens it', async () => {
    const user = userEvent.setup();
    renderCell(LONG);
    const cell = screen.getByRole('cell');
    expect(toggle()).toHaveTextContent('more');
    expect(toggle()).toHaveAccessibleName('Show the whole cell');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(cell).toHaveClass(styles.expandable);

    await user.click(cell.firstElementChild!);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(toggle()).toHaveTextContent('less');
    // Named for what it shows, so voice control can target "less".
    expect(toggle()).toHaveAccessibleName('Show less');
    expect(cell.firstElementChild).not.toHaveClass(styles.clamped);
    // A mouse click moves no focus into the cell (focusing scrolled a wide
    // table sideways).
    expect(cell).not.toContainElement(document.activeElement as HTMLElement);

    await user.click(toggle());
    expect(cell).not.toContainElement(document.activeElement as HTMLElement);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(cell.firstElementChild).toHaveClass(styles.clamped);
  });

  it('opens from the keyboard with the button, and a mouse press does not focus it', async () => {
    const user = userEvent.setup();
    renderCell(LONG);
    expect(fireEvent.mouseDown(toggle())).toBe(false);

    toggle().focus();
    await user.keyboard('{Enter}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves clicks on a link inside the cell to the link', () => {
    renderCell(
      <>
        {LONG} <a href="#notes">a link</a>
      </>
    );
    fireEvent.click(screen.getByRole('link', { name: 'a link' }));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('ignores clicks React bubbles up from a portal inside the cell (a chip preview)', () => {
    renderCell(
      <>
        {LONG}
        {createPortal(<div data-testid="preview-backdrop" />, document.body)}
      </>
    );
    fireEvent.click(screen.getByTestId('preview-backdrop'));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('ignores a click that ends a text selection in the cell, but not its own button', () => {
    renderCell(LONG);
    const content = screen.getByRole('cell').firstElementChild!;
    window.getSelection()!.selectAllChildren(content);
    fireEvent.click(content);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    // Text selected in the opened cell: "less" still closes it.
    window.getSelection()!.selectAllChildren(content);
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps double-clicks on a long cell from reaching the surface around the table', () => {
    const onSurfaceDoubleClick = vi.fn();
    renderCell(LONG, { onSurfaceDoubleClick });
    fireEvent.doubleClick(screen.getByRole('cell'));
    fireEvent.doubleClick(toggle());
    expect(onSurfaceDoubleClick).not.toHaveBeenCalled();
  });

  it('re-measures when its content changes without a re-render (a chip title loading)', async () => {
    let setTitle: (title: string) => void = () => {};
    function LateTitle() {
      const [title, set] = useState('short');
      useEffect(() => {
        setTitle = set;
      }, []);
      return <span>{title}</span>;
    }
    renderCell(<LateTitle />);
    expect(queryToggle()).toBeNull();

    act(() => setTitle(LONG));
    expect(await screen.findByRole('button', { name: 'Show the whole cell' })).toBeVisible();
  });

  it('shows every cell in full, inert, in the expanded table view', () => {
    renderCell(LONG, { clamp: false });
    const cell = screen.getByRole('cell');
    expect(screen.queryByRole('button')).toBeNull();
    expect(cell.firstElementChild).not.toHaveClass(styles.clamped);
  });
});
