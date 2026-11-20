import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Segmented } from './Segmented';
import styles from './Segmented.module.scss';

// jsdom lays nothing out and vitest does not inject CSS modules, so the
// corner contract is checked two ways: the markup carries the classes, and
// the stylesheet gives those classes square corners. A rounded container
// with a rectangular active rim left the rim's corner poking past the curve
// whenever the first or last option was selected.
const scss = readFileSync(join(__dirname, 'Segmented.module.scss'), 'utf8');
const block = (selector: string): string => {
  const start = scss.indexOf(`\n${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return scss.slice(start, scss.indexOf('\n}', start));
};

function renderGroup(value = 'day') {
  return render(
    <Segmented value={value} onChange={() => {}} aria-label="Zoom">
      <Segmented.Option value="day">Day</Segmented.Option>
      <Segmented.Option value="week">Week</Segmented.Option>
      <Segmented.Option value="year">Year</Segmented.Option>
    </Segmented>
  );
}

describe('Segmented corners', () => {
  it('container and every option carry the square-corner classes', () => {
    renderGroup('year');
    const group = screen.getByRole('radiogroup', { name: 'Zoom' });
    expect(group).toHaveClass(styles.group);
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(3);
    for (const option of options) expect(option).toHaveClass(styles.option);
    expect(screen.getByRole('radio', { name: 'Year' })).toHaveClass(styles.optionActive);
  });

  it('stylesheet gives the container and the options border-radius 0', () => {
    expect(block('.group')).toMatch(/border-radius: 0;/);
    expect(block('.group')).not.toMatch(/border-radius: var\(/);
    expect(block('.option')).toMatch(/border-radius: 0;/);
    expect(block('.option')).not.toMatch(/border-radius: var\(/);
  });

  it('active rim and focus ring are inset so overflow: hidden never clips them', () => {
    expect(block('.group')).toMatch(/overflow: hidden;/);
    expect(block('.optionActive')).toMatch(/box-shadow: inset 0 0 0 1px/);
    const option = block('.option');
    expect(option).toMatch(/&:focus-visible \{[^}]*box-shadow: inset 0 0 0 1px/);
    expect(option).toMatch(/&:focus-visible \{[^}]*outline: none;/);
  });
});
