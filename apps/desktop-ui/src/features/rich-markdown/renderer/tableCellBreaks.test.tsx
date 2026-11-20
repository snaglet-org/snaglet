/**
 * Read views (docs, chat, previews) show a `<br>` inside a table cell as a
 * line break, matching the rich editor, instead of the literal text `<br>`.
 * `<br>` outside a table stays text, as in the editor.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkdownRenderer } from './MarkdownRenderer';
import { readTableText } from './markdownTableData';

const TABLE =
  '| Case | Why<br>(short) |\n| --- | --- |\n| A | • first reason<br>• second reason<br/>• third <BR> end |';

describe('line breaks in rendered table cells', () => {
  it('renders <br> forms in body and header cells as line breaks', () => {
    const { container } = render(<MarkdownRenderer content={TABLE} />);
    const cell = container.querySelectorAll('tbody td')[1]!;
    expect(cell.querySelectorAll('br')).toHaveLength(3);
    // react-markdown follows each <br> with a newline in the text.
    expect(cell.textContent?.replace(/\n/g, '')).toBe('• first reason• second reason• third end');
    expect(container.querySelector('th:nth-child(2)')?.querySelectorAll('br')).toHaveLength(1);
    expect(container.textContent).not.toContain('<br');
  });

  it('keeps <br> in inline code, and outside tables, as text', () => {
    const { container } = render(
      <MarkdownRenderer content={'one<br>two\n\n| A |\n| --- |\n| `x<br>y` |'} />
    );
    expect(container.querySelector('p')?.textContent).toBe('one<br>two');
    expect(container.querySelector('td code')?.textContent).toBe('x<br>y');
  });

  it('reads a broken cell as separate lines when the table is copied', () => {
    const { container } = render(<MarkdownRenderer content={TABLE} />);
    expect(container.querySelector('table')).not.toBeNull();
    const text = readTableText({
      type: 'element',
      tagName: 'table',
      properties: {},
      children: [
        {
          type: 'element',
          tagName: 'tbody',
          properties: {},
          children: [
            {
              type: 'element',
              tagName: 'tr',
              properties: {},
              children: [
                {
                  type: 'element',
                  tagName: 'td',
                  properties: {},
                  children: [
                    { type: 'text', value: 'one' },
                    { type: 'element', tagName: 'br', properties: {}, children: [] },
                    { type: 'text', value: 'two' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(text.rows).toEqual([['one\ntwo']]);
  });
});
