/**
 * Read-only markdown (a message, a transcluded doc, a table cell) has no doc
 * view to scroll, so a link to a heading of the same doc (`#h=…`, `#slug`)
 * stays a plain link that goes nowhere: no new window, no change to the
 * app's address. Web links keep opening outside.
 */
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

/** A click as the browser sends it; returns whether the page's default was canceled. */
function click(target: Element): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

it.each(['#h=q4-what-information-do-you-work-with-most', '#next-steps', '#q1'])(
  'renders [Q](%s) as a link that opens nothing',
  (href) => {
    const { container } = render(<MarkdownRenderer content={`Go to [Q](${href}).`} />);
    const link = container.querySelector(`a[href="${href}"]`);
    expect(link).not.toBeNull();
    expect(link).not.toHaveAttribute('target');

    const before = window.location.href;
    expect(click(link!)).toBe(true);
    expect(window.location.href).toBe(before);
  }
);

it('still opens a web link in a new window', () => {
  const { container } = render(<MarkdownRenderer content="See [docs](https://example.org/)." />);
  expect(container.querySelector('a[href="https://example.org/"]')).toHaveAttribute(
    'target',
    '_blank'
  );
});
