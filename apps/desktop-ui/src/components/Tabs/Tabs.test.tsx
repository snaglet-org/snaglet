import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from './Tabs';

const scss = readFileSync(join(__dirname, 'Tabs.module.scss'), 'utf8');
function block(selector: string): string {
  const start = scss.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`No ${selector} rule`);
  return scss.slice(start, scss.indexOf('\n}', start));
}

const LABELS = ['Overview', 'Behavior', 'Capabilities', 'Memories', 'Direct messages', 'Logs'];

function strip(value: string, orientation: 'horizontal' | 'vertical' = 'horizontal') {
  return (
    <Tabs value={value} onChange={vi.fn()} orientation={orientation} aria-label="Agent settings">
      {LABELS.map((label) => (
        <Tabs.Tab key={label} value={label}>
          {label}
        </Tabs.Tab>
      ))}
    </Tabs>
  );
}

/**
 * jsdom has no layout: give the strip a 200px window onto six 90px tabs
 * spaced 100px apart (600px of tabs), and a working scrollLeft.
 */
function layOut(list: HTMLElement) {
  let left = 0;
  Object.defineProperties(list, {
    clientWidth: { configurable: true, get: () => 200 },
    scrollWidth: { configurable: true, get: () => 600 },
    scrollLeft: {
      configurable: true,
      get: () => left,
      set: (next: number) => {
        left = Math.max(0, Math.min(400, next));
      },
    },
  });
  screen.getAllByRole('tab').forEach((tab, index) => {
    Object.defineProperties(tab, {
      offsetLeft: { configurable: true, get: () => index * 100 },
      offsetWidth: { configurable: true, get: () => 90 },
    });
  });
}

describe('Tabs, horizontal strip that does not fit', () => {
  it('is a sideways scroll container with no scrollbar and no wrapping', () => {
    const horizontal = block('.orientationHorizontal');
    expect(horizontal).toMatch(/overflow-x: auto;/);
    expect(horizontal).toMatch(/overflow-y: hidden;/);
    expect(horizontal).toMatch(/@include layout-scrollbar-hidden;/);
    expect(horizontal).not.toMatch(/flex-wrap: wrap/);
    expect(block('.tab')).toMatch(/white-space: nowrap;/);
    expect(block('.tab')).toMatch(/flex-shrink: 0;/);
  });

  it('scrolls the newly active tab into view and flags the faded ends', () => {
    const { rerender } = render(strip('Overview'));
    const list = screen.getByRole('tablist', { name: 'Agent settings' });
    layOut(list);

    rerender(strip('Memories'));
    // Memories ends at 390px: shown clear of the right edge's chevron band
    // and fade (20px + 24px).
    expect(list.scrollLeft).toBe(390 + 44 - 200);
    expect(list).toHaveAttribute('data-overflow-start');
    expect(list).toHaveAttribute('data-overflow-end');

    rerender(strip('Logs'));
    // The last tab takes the strip to its end.
    expect(list.scrollLeft).toBe(400);
    expect(list).toHaveAttribute('data-overflow-start');
    expect(list).not.toHaveAttribute('data-overflow-end');

    rerender(strip('Overview'));
    expect(list.scrollLeft).toBe(0);
    expect(list).not.toHaveAttribute('data-overflow-start');
    expect(list).toHaveAttribute('data-overflow-end');
  });

  it('scrolls a tab reached from the keyboard into view', () => {
    render(strip('Overview'));
    const list = screen.getByRole('tablist', { name: 'Agent settings' });
    layOut(list);
    const first = screen.getByRole('tab', { name: 'Overview' });
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveFocus();
    expect(list.scrollLeft).toBe(400);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(first).toHaveFocus();
    expect(list.scrollLeft).toBe(0);
  });

  it('lets a vertical wheel scroll it sideways while it can still move', () => {
    render(strip('Overview'));
    const list = screen.getByRole('tablist', { name: 'Agent settings' });
    layOut(list);
    const down = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list.dispatchEvent(down);
    expect(list.scrollLeft).toBe(120);
    expect(down.defaultPrevented).toBe(true);

    list.scrollLeft = 400;
    const atEnd = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    list.dispatchEvent(atEnd);
    // At the end the wheel goes on to scroll the page.
    expect(atEnd.defaultPrevented).toBe(false);
  });

  it('shows a chevron at each end with tabs past it, outside the tablist, that pages the strip', () => {
    const { container, rerender } = render(strip('Overview'));
    const list = screen.getByRole('tablist', { name: 'Agent settings' });
    layOut(list);
    rerender(strip('Memories'));

    const start = container.querySelector<HTMLElement>('[data-tabs-scroll="start"]');
    const end = container.querySelector<HTMLElement>('[data-tabs-scroll="end"]');
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    // Only tabs belong in the tablist, and the chevrons stay out of tab order.
    expect(list.contains(start)).toBe(false);
    expect(end).toHaveAttribute('tabindex', '-1');

    // jsdom has no smooth scrolling: page through scrollLeft.
    Object.defineProperty(list, 'scrollTo', { configurable: true, value: undefined });
    const before = list.scrollLeft;
    fireEvent.click(end!);
    expect(list.scrollLeft).toBe(Math.min(400, before + 140));
    fireEvent.click(container.querySelector<HTMLElement>('[data-tabs-scroll="start"]')!);
    expect(list.scrollLeft).toBe(before);

    rerender(strip('Overview'));
    expect(container.querySelector('[data-tabs-scroll="start"]')).toBeNull();
    expect(container.querySelector('[data-tabs-scroll="end"]')).not.toBeNull();
  });

  it('leaves a vertical tab list alone', () => {
    const { container } = render(strip('Logs', 'vertical'));
    const list = screen.getByRole('tablist', { name: 'Agent settings' });
    expect(list).not.toHaveAttribute('data-overflow-start');
    expect(list).not.toHaveAttribute('data-overflow-end');
    expect(container.querySelector('[data-tabs-scroll]')).toBeNull();
  });
});
