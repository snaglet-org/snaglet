/**
 * ProviderIcon — pins that DeepSeek and xAI render their own branded mark
 * rather than the generic first-letter fallback, and that unknown ids (such
 * as `groq`) still get that fallback.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProviderIcon } from './ProviderIcon';

describe('ProviderIcon', () => {
  it('renders provider marks with the shared monochrome treatment', () => {
    const { container } = render(<ProviderIcon providerId="anthropic" />);

    expect(container.querySelector('svg')).toHaveStyle({
      filter: 'grayscale(1) contrast(1.35)',
    });
  });

  it('renders a branded DeepSeek mark (no letter fallback)', () => {
    const { container } = render(<ProviderIcon providerId="deepseek" />);
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe('#4D6BFE');
    // The fallback path is the only one that renders a <text> glyph.
    expect(container.querySelector('text')).toBeNull();
  });

  it('renders a branded xAI (Grok) mark (no letter fallback)', () => {
    const { container } = render(<ProviderIcon providerId="xai" />);
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe('#000');
    expect(container.querySelector('text')).toBeNull();
  });

  it('falls back to a first-letter glyph for unknown providers', () => {
    const { container } = render(<ProviderIcon providerId="zzz-unknown" />);
    const text = container.querySelector('text');
    expect(text).not.toBeNull();
    expect(text?.textContent).toBe('Z');
  });

  it('has no branded mark for groq', () => {
    const { container } = render(<ProviderIcon providerId="groq" />);
    expect(container.querySelector('text')?.textContent).toBe('G');
  });
});
