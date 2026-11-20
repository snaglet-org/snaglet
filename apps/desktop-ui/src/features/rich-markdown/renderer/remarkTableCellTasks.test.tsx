import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { toggleMarkdownCheckbox } from '@desktop/utils/toggleMarkdownCheckbox';
import { MarkdownRenderer } from './MarkdownRenderer';

const DOC_ID = 'doc-1111111111111-9gqbtkgh1';
const table = (...cells: string[]) =>
  [
    '| Done | Task |',
    '| --- | --- |',
    ...cells.map((cell, i) => `| ${cell} | task ${i + 1} |`),
  ].join('\n');

/** The first column's cells: `☐` / `☑` for a checkbox, then the cell's text. */
function firstColumn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map((row) => {
    const cell = row.querySelector('td')!;
    const boxes = Array.from(cell.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    return `${boxes.map((box) => (box.checked ? '☑' : '☐')).join('')}${cell.textContent?.replace(/more$/, '')}`;
  });
}

describe('task markers in rendered table cells', () => {
  it('shows [ ], [x] and the older ☐ / ☑ at a cell line start as read-only checkboxes', () => {
    const { container } = render(
      <MarkdownRenderer
        content={table('[ ]', '[x] done', '[X]', '☐ milk', '☑', '[ ] a<br>[x] b<br>note')}
      />
    );
    expect(firstColumn(container)).toEqual(['☐', '☑done', '☑', '☐milk', '☑', '☐☑a\nb\nnote']);
    for (const box of container.querySelectorAll('td input[type="checkbox"]'))
      expect(box).toBeDisabled();
  });

  it('leaves [ ] elsewhere in a cell, escaped, in code, or in a link as it is', () => {
    const { container } = render(
      <MarkdownRenderer
        content={table(
          'a [ ] b',
          '`[ ]` code',
          `[site](https://example.com) and [Spec](${DOC_ID})`,
          '\\[ \\] escaped',
          '[ ]**bold**'
        )}
      />
    );
    expect(container.querySelectorAll('td input[type="checkbox"]')).toHaveLength(0);
    expect(within(container).getByRole('link', { name: 'site' })).toBeInTheDocument();
    expect(firstColumn(container)[0]).toBe('a [ ] b');
    expect(firstColumn(container)[3]).toBe('[ ] escaped');
  });

  it('copies and sorts a checkbox column by its marker', async () => {
    render(<MarkdownRenderer content={table('[x] b', '[ ] a', '[x]')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    const dialog = await screen.findByRole('dialog', { name: 'Expanded table' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Filter rows' }), {
      target: { value: '[x]' },
    });
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 of 3 rows');
    expect(dialog.querySelectorAll('td input[type="checkbox"]:checked')).toHaveLength(2);
  });

  it('toggles a [ ] cell checkbox in a host that toggles task checkboxes', () => {
    const content = table('[ ] a', '☐ legacy');
    const onToggle = vi.fn();
    const { container } = render(
      <MarkdownRenderer content={content} onCheckboxToggle={onToggle} />
    );
    const [box, legacy] = Array.from(
      container.querySelectorAll<HTMLInputElement>('td input[type="checkbox"]')
    );
    expect(box).toBeEnabled();
    expect(legacy).toBeDisabled();
    fireEvent.click(box!);
    expect(onToggle).toHaveBeenCalledTimes(1);
    const [offset] = onToggle.mock.calls[0] as [number];
    expect(toggleMarkdownCheckbox(content, offset)).toBe(table('[x] a', '☐ legacy'));
  });

  it('reads spaces before a marker after a break as a task, as the editor does', () => {
    const content = table('a<br> [ ] b');
    const onToggle = vi.fn();
    const { container } = render(
      <MarkdownRenderer content={content} onCheckboxToggle={onToggle} />
    );
    expect(firstColumn(container)).toEqual(['☐a\nb']);
    fireEvent.click(container.querySelector('td input[type="checkbox"]')!);
    const [offset] = onToggle.mock.calls[0] as [number];
    expect(toggleMarkdownCheckbox(content, offset)).toBe(table('a<br> [x] b'));
  });

  it('leaves a marker inside bold or a link as text', () => {
    const { container } = render(
      <MarkdownRenderer content={table('**a<br>[ ] b**', '[a<br>[ ] b](https://example.com)')} />
    );
    expect(container.querySelectorAll('td input[type="checkbox"]')).toHaveLength(0);
    expect(container.querySelectorAll('td a')).toHaveLength(1);
  });
});
