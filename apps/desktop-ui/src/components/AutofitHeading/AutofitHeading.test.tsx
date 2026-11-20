/**
 * AutofitHeading — the Layer-2 fit-to-box heading. These specs pin two
 * things: bounds are pulled from TYPE_SCALE (never raw numbers) per
 * variant, and alignment stays with CSS
 * unless the caller explicitly opts into hook-controlled placement.
 *
 * `autofit-text` is mocked so we can capture the options the component hands
 * the hook without a real layout pass (jsdom can't measure text).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { fitOptions } = vi.hoisted(() => ({
  fitOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('autofit-text', () => ({
  useAutofitText: (_textRef: unknown, _boxRef: unknown, options: Record<string, unknown>) => {
    fitOptions.push(options);
    return { refit: () => {} };
  },
}));

import { AutofitHeading, type AutofitHeadingVariant } from './AutofitHeading';
import { TYPE_SCALE } from '@desktop/styles/typeScale';

function lastOptions(): Record<string, unknown> {
  return fitOptions[fitOptions.length - 1];
}

describe('AutofitHeading', () => {
  it('renders its children inside the requested element tag', () => {
    render(
      <AutofitHeading as="h1" className="viewTitle">
        Providers
      </AutofitHeading>
    );
    const heading = screen.getByText('Providers');
    expect(heading.tagName).toBe('H1');
    expect(heading).toHaveClass('viewTitle');
  });

  it('pulls bounds from TYPE_SCALE per variant', () => {
    const cases: Array<[AutofitHeadingVariant, number, number]> = [
      ['hero', TYPE_SCALE.heroMin, TYPE_SCALE.heroMax],
      ['title', TYPE_SCALE.titleMin, TYPE_SCALE.titleMax],
      ['header', TYPE_SCALE.headerMin, TYPE_SCALE.headerMax],
    ];
    for (const [variant, min, max] of cases) {
      render(<AutofitHeading variant={variant}>Fit me</AutofitHeading>);
      const opts = lastOptions();
      expect(opts.minFontSize).toBe(min);
      expect(opts.maxFontSize).toBe(max);
    }
  });

  it('defaults to the title variant', () => {
    render(<AutofitHeading>Default</AutofitHeading>);
    const opts = lastOptions();
    expect(opts.minFontSize).toBe(TYPE_SCALE.titleMin);
    expect(opts.maxFontSize).toBe(TYPE_SCALE.titleMax);
  });

  it('stays in normal flow (no align) unless the caller opts in', () => {
    render(<AutofitHeading variant="header">Flowed</AutofitHeading>);
    expect(lastOptions().alignX).toBeUndefined();
    expect(lastOptions().alignY).toBeUndefined();

    render(
      <AutofitHeading variant="header" alignX="left" alignY="center">
        Aligned
      </AutofitHeading>
    );
    expect(lastOptions().alignX).toBe('left');
    expect(lastOptions().alignY).toBe('center');
  });
});
