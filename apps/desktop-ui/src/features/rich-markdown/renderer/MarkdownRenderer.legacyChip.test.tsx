/**
 * Chips of retired kinds (`sketch-…`, `post-…`) in stored content render as a
 * labeled pill (never raw text or a dead external link), marked unavailable,
 * and never blank when written with no label (`![](sketch-…)`).
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

vi.mock('./useWorkspaceAncestors', () => ({ useWorkspaceAncestors: () => [] }));

const SKETCH_ID = 'sketch-1700000000000-abc123';
const POST_ID = 'post-1700000000000-def456';

function chipIn(content: string, kind: string): Element {
  const { container } = render(<MarkdownRenderer content={content} />);
  expect(container.querySelector('a[target="_blank"]')).toBeNull();
  const chip = container.querySelector(`.md-chip.md-chip-${kind}`);
  expect(chip).not.toBeNull();
  return chip as Element;
}

describe.each([
  ['sketch', SKETCH_ID, 'Sketch'],
  ['post', POST_ID, 'Post'],
])('legacy %s chip', (kind, id, defaultTitle) => {
  it('[T](id) keeps its title and renders as an unavailable chip', () => {
    const chip = chipIn(`See [T](${id}) here.`, kind);
    expect(chip.getAttribute('data-node-id')).toBe(id);
    expect(chip.querySelector('.md-chip-title')?.textContent).toBe('T');
    expect(chip).toHaveClass('md-chip-unavailable');
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    expect(chip).toHaveAttribute('title', `This ${kind} no longer exists`);
  });

  it(`![](id) shows the default title "${defaultTitle}" instead of a blank pill`, () => {
    const chip = chipIn(`![](${id})`, kind);
    expect(chip.querySelector('.md-chip-title')?.textContent).toBe(defaultTitle);
    expect(chip).toHaveClass('md-chip-unavailable');
  });
});
