import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { TABLE_SELECT_OPTION_COLORS } from '@snaglet/shared/types';
import { describe, expect, it } from 'vitest';
import { SelectOptionTag, selectOptionColorClass } from './SelectOptionTag';
import styles from './SelectOptionTag.module.scss';

const styleSource = readFileSync(
  resolve(process.cwd(), 'src/pages/Dashboard/views/TableView/SelectOptionTag.module.scss'),
  'utf8'
);

describe('SelectOptionTag', () => {
  it.each(TABLE_SELECT_OPTION_COLORS)(
    'renders the %s palette without changing the label',
    (color) => {
      render(<SelectOptionTag label="Ready to review" color={color} />);
      const tag = screen.getByTitle('Ready to review');
      expect(tag.tagName).toBe('SPAN');
      expect(tag).toHaveTextContent('Ready to review');
      expect(tag).toHaveClass(styles.tag, styles.palette, styles[color]);
      expect(selectOptionColorClass(color)).toBe(`${styles.palette} ${styles[color]}`);
    }
  );

  it('uses neutral gray when a color has not been assigned', () => {
    render(<SelectOptionTag label="Unassigned" />);
    expect(screen.getByTitle('Unassigned')).toHaveClass(styles.gray);
    expect(selectOptionColorClass()).toBe(selectOptionColorClass('gray'));
  });

  it('can sit inside a button without nested interactive elements or duplicate labels', () => {
    const view = render(
      <button type="button">
        <SelectOptionTag label="In progress" color="blue" />
      </button>
    );
    expect(screen.getAllByRole('button', { name: 'In progress' })).toHaveLength(1);
    expect(view.container.querySelector('button button, a, [role], [tabindex]')).toBeNull();
  });

  it('keeps a long label intact for assistive technology and the full-title tooltip', () => {
    const label =
      'Review the complete project proposal with the team before approving the next phase';
    render(<SelectOptionTag label={label} color="purple" className="host-tag" />);
    const tag = screen.getByTitle(label);
    expect(tag).toHaveClass('host-tag');
    expect(tag).toHaveTextContent(label);
    expect(tag.firstElementChild).toHaveClass(styles.label);
    expect(styleSource).toContain('max-width: 100%');
    expect(styleSource).toContain('overflow: hidden');
    expect(styleSource).toContain('text-overflow: ellipsis');
    expect(styleSource).toContain('white-space: nowrap');
  });

  it('keeps readable theme foreground over a muted tint without introducing raw colors', () => {
    expect(styleSource).toContain('color: var(--color-text)');
    expect(styleSource).toContain(
      'background: color-mix(in srgb, var(--select-option-accent) 18%, var(--color-background))'
    );
    expect(styleSource).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i);
    for (const color of TABLE_SELECT_OPTION_COLORS) {
      expect(styleSource).toContain(`.${color} {`);
    }
  });
});
