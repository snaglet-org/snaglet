import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const read = (path: string) => readFileSync(join(__dirname, path), 'utf8');
const selectScss = read('Select.module.scss');
const inputScss = read('../TextInput/TextInput.module.scss');
const tokens = read('../../../../../../packages/ui/styles/_tokens.scss');

/** The body of the first rule whose selector line is exactly `selector`. */
function block(scss: string, selector: string): string {
  const start = scss.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No ${selector} rule`);
  return scss.slice(start, scss.indexOf('\n}', start));
}
const px = (rule: string, property: string) =>
  rule.match(new RegExp(`\\n\\s*${property}: (\\d+)px;`))?.[1];

describe('Select', () => {
  it('stays a native, labeled select with a decorative caret', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Sort" value="a" onChange={onChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>
    );
    const select = screen.getByRole('combobox', { name: 'Sort' });
    expect(select.tagName).toBe('SELECT');
    expect(select.nextElementSibling).toHaveAttribute('aria-hidden');
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('has square corners from the dropdown radius token, which is 0', () => {
    expect(tokens).toMatch(/\n\s*--radius-dropdown: 0;/);
    const select = block(selectScss, '.select');
    expect(select).toMatch(/\$radius: var\(--radius-dropdown\)/);
    expect(select).not.toMatch(/radius-field|border-radius: var\(--radius-(sm|md|lg)\)/);
  });

  it('is as tall as a text input of the same size, with the same type size', () => {
    for (const size of ['Sm', 'Md']) {
      const select = block(selectScss, `.size${size} .select`);
      const input = block(inputScss, `.size${size}`);
      expect(px(select, 'height')).toBe(px(input, 'min-height'));
      expect(px(select, 'font-size')).toBe(px(input, 'font-size'));
    }
  });
});
