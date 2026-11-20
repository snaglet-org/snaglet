/**
 * ToolIcon — the shovel that marks a Tool everywhere (Tools rail tab, tool
 * rows, command palette, selection header, link preview).
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolIcon } from './ToolIcon';

describe('ToolIcon', () => {
  it('is a decorative outline glyph on the 24 grid, like the other outline icons', () => {
    const { container } = render(<ToolIcon />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('data-icon')).toBe('tool');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('stroke-linecap')).toBe('round');
    expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
  });

  it('draws a handle, a shaft and a solid blade, tipped 45° with the blade at the lower left', () => {
    const { container } = render(<ToolIcon />);
    expect(container.querySelector('g')?.getAttribute('transform')).toBe('rotate(45 12 12)');
    const paths = container.querySelectorAll('path');
    expect(paths).toHaveLength(3);
    // Only the blade is filled; the handle and shaft stay outlines.
    const filled = [...paths].filter((path) => path.getAttribute('fill') === 'currentColor');
    expect(filled).toEqual([paths[2]]);
  });

  it('defaults to 18px and takes a size', () => {
    const { container } = render(
      <>
        <ToolIcon />
        <ToolIcon size={20} />
      </>
    );
    const [row, rail] = container.querySelectorAll('svg');
    expect(row?.getAttribute('width')).toBe('18');
    expect(row?.getAttribute('height')).toBe('18');
    expect(rail?.getAttribute('width')).toBe('20');
    expect(rail?.getAttribute('height')).toBe('20');
  });
});
