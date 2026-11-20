import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WHEEL_SCROLL_X_ATTR } from '@desktop/utils/horizontalWheelScroll';

import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * The wheel behavior is tested in `utils/horizontalWheelScroll.test.ts`. Every
 * markdown surface renders through this component, so these tests pin its
 * wiring: emitted regions are marked and the delegated listener is attached.
 */

/** jsdom has no layout — install the overflow the wheel logic reads. */
function makeHorizontallyScrollable(el: Element, clientWidth = 200, scrollWidth = 900): void {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  let current = 0;
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => current,
    set: (next: number) => {
      current = Math.min(scrollWidth - clientWidth, Math.max(0, next));
    },
  });
}

function wheelOver(el: Element, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: 0,
    deltaY: 120,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

const MARKED = `[${WHEEL_SCROLL_X_ATTR}]`;

describe('MarkdownRenderer horizontal wheel regions', () => {
  it('marks the renderer root, code blocks and table wrappers as wheel-scroll regions', () => {
    const { container } = render(
      <MarkdownRenderer
        content={'```\nvery wide code line\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'}
      />
    );

    const root = container.firstElementChild!;
    expect(root.hasAttribute(WHEEL_SCROLL_X_ATTR)).toBe(true);
    expect(container.querySelector(`pre${MARKED}`)).not.toBeNull();
    // The table's scroll wrapper, not the <table> itself.
    const tableWrap = container.querySelector(`div${MARKED} > table`)?.parentElement;
    expect(tableWrap).not.toBeNull();
  });

  it('scrolls a wide code block sideways from a plain vertical wheel', () => {
    const { container } = render(<MarkdownRenderer content={'```\nnpm run something\n```'} />);
    const codeBlock = container.querySelector('pre')!;
    makeHorizontallyScrollable(codeBlock);

    const event = wheelOver(codeBlock.querySelector('code') ?? codeBlock);

    expect(codeBlock.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it('scrolls a wide table from a wheel over one of its cells', () => {
    const { container } = render(
      <MarkdownRenderer content={'| a | b |\n| - | - |\n| one | two |\n'} />
    );
    const tableWrap = container.querySelector('table')!.parentElement!;
    makeHorizontallyScrollable(tableWrap);

    wheelOver(container.querySelector('td')!, { deltaY: -60 });
    expect(tableWrap.scrollLeft).toBe(0); // already at the left boundary

    wheelOver(container.querySelector('td')!, { deltaY: 60 });
    expect(tableWrap.scrollLeft).toBe(60);
  });

  it('scrolls the root itself when the host surface owns the overflow (chat bubble)', () => {
    // MessageRow styles the renderer root `overflow-x: auto`, so the bubble
    // body is the scroll region for anything that overflows inside it.
    const { container } = render(<MarkdownRenderer content="a long line of prose" />);
    const root = container.firstElementChild as HTMLElement;
    makeHorizontallyScrollable(root);

    const event = wheelOver(root.querySelector('p')!);

    expect(root.scrollLeft).toBe(120);
    expect(event.defaultPrevented).toBe(true);
  });

  it('releases the wheel at the boundary so the page keeps scrolling vertically', () => {
    const { container } = render(<MarkdownRenderer content={'```\nnpm run something\n```'} />);
    const codeBlock = container.querySelector('pre')!;
    makeHorizontallyScrollable(codeBlock);
    codeBlock.scrollLeft = 700; // clamps to max

    const event = wheelOver(codeBlock, { deltaY: 120 });

    expect(codeBlock.scrollLeft).toBe(700);
    expect(event.defaultPrevented).toBe(false);
  });

  it('detaches its listener when the surface unmounts', () => {
    const { container, unmount } = render(
      <MarkdownRenderer content={'```\nnpm run something\n```'} />
    );
    const codeBlock = container.querySelector('pre')!;
    makeHorizontallyScrollable(codeBlock);

    // The detached subtree survives the unmount, so a listener that was never
    // removed would still scroll the code block here.
    unmount();
    const event = wheelOver(codeBlock);

    expect(codeBlock.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});
