import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPortal } from 'react-dom';
import type { Element } from 'hast';

import { TOAST_EVENT_NAME, type ToastDetail } from '@desktop/utils/toast';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MarkdownTable } from './MarkdownTable';
import styles from './MarkdownTable.module.scss';

const table = (...rows: string[]) =>
  ['| Item | Owner | Files |', '| --- | --- | --- |', ...rows].join('\n');

const ROWS = [
  '| Step 10 | Sam | 36 |',
  '| Step 9 | sam | 1,029 |',
  '| step 2 | Lin | 3 |',
  '| Step 1 | Claude | 158 |',
];

/** Body cell text of one column, in the order shown. */
function column(container: HTMLElement, index: number): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map(
    (row) => row.querySelectorAll('td')[index]?.textContent ?? ''
  );
}

const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });

// A hand-built hast table, for rendering MarkdownTable with exact children.
const hastCell = (tagName: 'th' | 'td', value: string): Element => ({
  type: 'element',
  tagName,
  properties: {},
  children: [{ type: 'text', value }],
});
const hastRow = (tagName: 'th' | 'td', ...values: string[]): Element => ({
  type: 'element',
  tagName: 'tr',
  properties: {},
  children: values.map((value) => hastCell(tagName, value)),
});
const hastSection = (tagName: string, ...rows: Element[]): Element => ({
  type: 'element',
  tagName,
  properties: {},
  children: rows,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

describe('MarkdownTable: numeric columns', () => {
  it('right-aligns a column whose every body cell is a number, header included', () => {
    const { container } = render(<MarkdownRenderer content={table(...ROWS)} />);
    expect(header('Files')).toHaveClass(styles.numeric);
    for (const cell of container.querySelectorAll('tbody td:nth-child(3)'))
      expect(cell).toHaveClass(styles.numeric);
    expect(header('Item')).not.toHaveClass(styles.numeric);
    expect(container.querySelector('tbody td')).not.toHaveClass(styles.numeric);
  });

  it('accepts signs, currency, decimals and percents, and skips empty cells', () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          '| A | B |',
          '| - | - |',
          '| -$1,200.50 | 12% |',
          '| +3 | |',
          '| €4 | 7.5% |',
        ].join('\n')}
      />
    );
    for (const cell of container.querySelectorAll('tbody td'))
      expect(cell).toHaveClass(styles.numeric);
  });

  it('keeps the source alignment of a GFM column over the numeric default', () => {
    const { container } = render(
      <MarkdownRenderer content={['| N |', '| :-- |', '| 1 |', '| 2 |'].join('\n')} />
    );
    const cell = container.querySelector('tbody td')!;
    expect(cell).toHaveClass(styles.numeric);
    expect(cell).toHaveStyle({ textAlign: 'left' });
  });
});

describe('MarkdownTable: sorting', () => {
  it('cycles ascending, descending, then source order on header clicks', () => {
    const { container } = render(<MarkdownRenderer content={table(...ROWS)} />);
    const files = header('Files');
    expect(within(files).getByRole('button', { name: 'Sort by Files' })).toBeInTheDocument();
    expect(files).not.toHaveAttribute('aria-sort');

    fireEvent.click(files);
    expect(files).toHaveAttribute('aria-sort', 'ascending');
    expect(column(container, 2)).toEqual(['3', '36', '158', '1,029']);

    fireEvent.click(files);
    expect(files).toHaveAttribute('aria-sort', 'descending');
    expect(column(container, 2)).toEqual(['1,029', '158', '36', '3']);

    fireEvent.click(files);
    expect(files).not.toHaveAttribute('aria-sort');
    expect(column(container, 2)).toEqual(['36', '1,029', '3', '158']);
  });

  it("sorts from the keyboard with Enter and Space on the header's sort button", async () => {
    const user = userEvent.setup();
    const { container } = render(<MarkdownRenderer content={table(...ROWS)} />);
    const owner = header('Owner');
    within(owner).getByRole('button', { name: 'Sort by Owner' }).focus();
    await user.keyboard('{Enter}');
    expect(owner).toHaveAttribute('aria-sort', 'ascending');
    await user.keyboard(' ');
    expect(owner).toHaveAttribute('aria-sort', 'descending');
    expect(column(container, 1)).toEqual(['Sam', 'sam', 'Lin', 'Claude']);
  });

  it('orders text by value, digits by number and case ignored, ties in source order', () => {
    const { container } = render(<MarkdownRenderer content={table(...ROWS)} />);
    fireEvent.click(header('Item'));
    expect(column(container, 0)).toEqual(['Step 1', 'step 2', 'Step 9', 'Step 10']);
    fireEvent.click(header('Owner'));
    expect(header('Item')).not.toHaveAttribute('aria-sort');
    expect(column(container, 1)).toEqual(['Claude', 'Lin', 'Sam', 'sam']);
  });

  it('keeps the sort while a streaming message adds rows; new rows join the order', () => {
    const { container, rerender } = render(<MarkdownRenderer content={table(...ROWS)} />);
    fireEvent.click(header('Files'));
    rerender(<MarkdownRenderer content={table(...ROWS, '| Step 11 | Ada | 50 |')} />);
    expect(header('Files')).toHaveAttribute('aria-sort', 'ascending');
    expect(column(container, 2)).toEqual(['3', '36', '50', '158', '1,029']);
  });

  it('ignores a header click that ends a text selection in it, but not its sort button', () => {
    const { container } = render(<MarkdownRenderer content={table(...ROWS)} />);
    const files = header('Files');
    window.getSelection()!.selectAllChildren(files);
    fireEvent.click(files);
    expect(files).not.toHaveAttribute('aria-sort');
    expect(column(container, 2)).toEqual(['36', '1,029', '3', '158']);

    fireEvent.click(within(files).getByRole('button', { name: 'Sort by Files' }));
    expect(files).toHaveAttribute('aria-sort', 'ascending');
  });

  it('ignores clicks React bubbles up from a portal inside a header', () => {
    const node = hastSection(
      'table',
      hastSection('thead', hastRow('th', 'N')),
      hastSection('tbody', hastRow('td', '2'), hastRow('td', '1'))
    );
    render(
      <MarkdownTable node={node}>
        <thead>
          <tr>
            <th>N{createPortal(<div data-testid="preview-backdrop" />, document.body)}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>2</td>
          </tr>
          <tr>
            <td>1</td>
          </tr>
        </tbody>
      </MarkdownTable>
    );
    const n = screen.getByRole('columnheader', { name: /N/ });
    fireEvent.click(screen.getByTestId('preview-backdrop'));
    expect(n).not.toHaveAttribute('aria-sort');
    fireEvent.click(n);
    expect(n).toHaveAttribute('aria-sort', 'ascending');
  });

  it('keeps double-clicks on headers and the bar from reaching the surface around it', () => {
    const onSurfaceDoubleClick = vi.fn();
    render(
      <div onDoubleClick={onSurfaceDoubleClick}>
        <MarkdownRenderer content={`Intro line.\n\n${table(...ROWS)}`} />
      </div>
    );
    fireEvent.doubleClick(header('Files'));
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Copy table' }));
    fireEvent.doubleClick(screen.getByText('4 rows'));
    expect(onSurfaceDoubleClick).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByText('Intro line.'));
    expect(onSurfaceDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('renders unsorted with no sort affordance when the rows disagree with the source', () => {
    // The source says two body rows; the rendered children carry one.
    const node = hastSection(
      'table',
      hastSection('thead', hastRow('th', 'N')),
      hastSection('tbody', hastRow('td', '2'), hastRow('td', '1'))
    );
    render(
      <MarkdownTable node={node}>
        <thead>
          <tr>
            <th>N</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>2</td>
          </tr>
        </tbody>
      </MarkdownTable>
    );
    const n = screen.getByRole('columnheader', { name: 'N' });
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.click(n);
    expect(n).not.toHaveAttribute('aria-sort');
    expect(screen.getAllByRole('cell').map((td) => td.textContent)).toEqual(['2']);
  });
});

describe('MarkdownTable: hover bar placement', () => {
  const frame = () => screen.getByRole('table').closest(`.${styles.frame}`);

  it('sits above the table when something comes before it', () => {
    render(<MarkdownRenderer content={`Here is the queue:\n\n${table(...ROWS)}`} />);
    expect(frame()).not.toHaveClass(styles.barBelow);
    expect(frame()).not.toHaveClass(styles.barRoom);
  });

  it('sits below the table, never over its headers, when the table opens the markdown', () => {
    render(<MarkdownRenderer content={`${table(...ROWS)}\n\nWant me to start?`} />);
    expect(frame()).toHaveClass(styles.barBelow);
    expect(frame()).not.toHaveClass(styles.barRoom);
  });

  it('counts what comes before an enclosing block, not just the table’s siblings', () => {
    const quoted = table(...ROWS)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    const { rerender } = render(<MarkdownRenderer content={`${quoted}\n\nAfter.`} />);
    expect(frame()).toHaveClass(styles.barBelow);
    rerender(<MarkdownRenderer content={`Before.\n\n${quoted}\n\nAfter.`} />);
    expect(frame()).not.toHaveClass(styles.barBelow);
  });

  it('keeps its room under a table that is the whole markdown, until more streams in', () => {
    const { rerender } = render(<MarkdownRenderer content={table(...ROWS)} />);
    expect(frame()).toHaveClass(styles.barBelow);
    expect(frame()).toHaveClass(styles.barRoom);
    rerender(<MarkdownRenderer content={`${table(...ROWS)}\n\nWant me to start?`} />);
    expect(frame()).toHaveClass(styles.barBelow);
    expect(frame()).not.toHaveClass(styles.barRoom);
  });
});

describe('MarkdownTable: hover bar', () => {
  function stubClipboard({ rich }: { rich: boolean }) {
    const clipboard = {
      write: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    if (rich)
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor(readonly items: Record<string, Blob>) {}
        }
      );
    else vi.stubGlobal('ClipboardItem', undefined);
    return clipboard;
  }

  function listenForToasts() {
    const toasts: string[] = [];
    const onToast = (event: Event) =>
      toasts.push((event as CustomEvent<ToastDetail>).detail.message);
    window.addEventListener(TOAST_EVENT_NAME, onToast);
    return { toasts, stop: () => window.removeEventListener(TOAST_EVENT_NAME, onToast) };
  }

  it('shows the row count and labels its buttons for the table', () => {
    render(<MarkdownRenderer content={table(...ROWS)} />);
    expect(screen.getByText('4 rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy table' })).toHaveTextContent('Copy');
    expect(screen.getByRole('button', { name: 'Expand table' })).toHaveTextContent('Expand');
  });

  it('says "1 row" for a single row', () => {
    render(<MarkdownRenderer content={table(ROWS[0])} />);
    expect(screen.getByText('1 row')).toBeInTheDocument();
  });

  it('copies TSV (header first, rows in the sorted order) and HTML, then confirms', async () => {
    const clipboard = stubClipboard({ rich: true });
    const { toasts, stop } = listenForToasts();
    render(<MarkdownRenderer content={table(...ROWS)} />);
    fireEvent.click(header('Files'));
    fireEvent.click(header('Files'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    });
    stop();

    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const [item] = clipboard.write.mock.calls[0][0] as Array<{ items: Record<string, Blob> }>;
    expect(await item.items['text/plain'].text()).toBe(
      [
        'Item\tOwner\tFiles',
        'Step 9\tsam\t1,029',
        'Step 1\tClaude\t158',
        'Step 10\tSam\t36',
        'step 2\tLin\t3',
      ].join('\n')
    );
    const html = await item.items['text/html'].text();
    expect(html).toContain('<thead><tr><th>Item</th><th>Owner</th><th>Files</th></tr></thead>');
    expect(html).toContain('<tr><td>Step 9</td><td>sam</td><td>1,029</td></tr>');
    expect(toasts).toEqual(['Copied 4 rows']);
  });

  it('falls back to plain-text TSV when the clipboard takes no rich items', async () => {
    const clipboard = stubClipboard({ rich: false });
    render(<MarkdownRenderer content={table(ROWS[2], '| a <b> & "c" | x | 1 |')} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy table' }));
    });
    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith(
      'Item\tOwner\tFiles\nstep 2\tLin\t3\n"a <b> & ""c"""\tx\t1'
    );
  });

  it('expands into a dialog with a filter, a count and the same sort; Esc closes it', async () => {
    render(<MarkdownRenderer content={table(...ROWS)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));

    const dialog = await screen.findByRole('dialog', { name: 'Expanded table' });
    const filter = within(dialog).getByRole('textbox', { name: 'Filter rows' });
    expect(filter).toHaveAttribute('placeholder', 'Filter rows…');
    expect(filter).toHaveFocus();
    expect(within(dialog).getByRole('status')).toHaveTextContent('4 rows');

    fireEvent.change(filter, { target: { value: 'SAM' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 of 4 rows');
    expect(column(dialog, 0)).toEqual(['Step 10', 'Step 9']);

    // Sorting in the dialog is the inline table's sort.
    fireEvent.click(within(dialog).getByRole('columnheader', { name: /Files/ }));
    expect(column(dialog, 2)).toEqual(['36', '1,029']);
    expect(within(dialog).getByRole('columnheader', { name: /Files/ })).toHaveAttribute(
      'aria-sort',
      'ascending'
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(header('Files')).toHaveAttribute('aria-sort', 'ascending');
  });
});
