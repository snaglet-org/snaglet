/**
 * DocOutline — the Outline group in the doc's Properties panel: the doc's
 * headings as a keyboard-friendly list of buttons that jump to them, with
 * the heading in view marked.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  createDocOutlineStore,
  outlineEntries,
} from '@desktop/features/rich-markdown/outline/docOutline';
import { DocOutline } from './DocOutline';

const MD = [
  '## Overview',
  '### Goals',
  '#### A very long heading that will not fit in a narrow properties panel at all',
  '### Goals',
  '## Plan',
].join('\n\n');

function setup(markdown = MD) {
  const store = createDocOutlineStore();
  store.setEntries(outlineEntries(markdown));
  const onJump = vi.fn();
  render(<DocOutline store={store} onJump={onJump} />);
  return { store, onJump };
}

const items = () =>
  within(screen.getByRole('navigation', { name: 'Outline' })).getAllByRole('button');

describe('DocOutline', () => {
  it('lists the headings in order, indented by level from the shallowest one', () => {
    setup();
    expect(items().map((b) => b.textContent)).toEqual([
      'Overview',
      'Goals',
      'A very long heading that will not fit in a narrow properties panel at all',
      'Goals',
      'Plan',
    ]);
    expect(items().map((b) => b.getAttribute('data-depth'))).toEqual(['0', '1', '2', '1', '0']);
    expect(items().map((b) => b.getAttribute('data-level'))).toEqual(['2', '3', '4', '3', '2']);
  });

  it('gives every entry its full text as a tooltip', () => {
    setup();
    expect(items()[2]).toHaveAttribute(
      'title',
      'A very long heading that will not fit in a narrow properties panel at all'
    );
  });

  it('jumps to the clicked heading, the right one of two with the same name', async () => {
    const { store, onJump } = setup();
    await userEvent.click(items()[3]!);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(store.getState().entries[3]);
    // Marked at once and held there while the doc scrolls to it.
    expect(items()[3]).toHaveAttribute('aria-current', 'location');
    expect(store.isHeld()).toBe(true);
  });

  it('marks the heading in view as the doc scrolls', () => {
    const { store } = setup();
    expect(items().some((b) => b.hasAttribute('aria-current'))).toBe(false);
    act(() => store.setActive(1));
    expect(items()[1]).toHaveAttribute('aria-current', 'location');
    act(() => store.setActive(4));
    expect(items()[1]).not.toHaveAttribute('aria-current');
    expect(items()[4]).toHaveAttribute('aria-current', 'location');
  });

  it('updates as the headings change', () => {
    const { store } = setup();
    act(() => {
      store.setEntries(outlineEntries('# Fresh start\n\n## Next'));
    });
    expect(items().map((b) => b.textContent)).toEqual(['Fresh start', 'Next']);
  });

  it('says so when the doc has no headings', () => {
    const { store } = setup('Only a paragraph.');
    expect(screen.getByText('No headings yet')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Outline' })).toBeNull();
    act(() => {
      store.setEntries(outlineEntries('# Now one'));
    });
    expect(screen.queryByText('No headings yet')).toBeNull();
    expect(items().map((b) => b.textContent)).toEqual(['Now one']);
  });

  it('is one tab stop; arrow keys, Home and End move between entries and Enter jumps', async () => {
    const { store, onJump } = setup();
    act(() => store.setActive(1));
    // The tab stop follows the heading in view.
    expect(items().map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1]);

    await userEvent.tab();
    expect(items()[1]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items()[2]).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(items()[4]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(items()[4]).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(items()[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items()[0]).toHaveFocus();
    expect(items().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    await userEvent.keyboard('{Enter}');
    expect(onJump).toHaveBeenCalledWith(store.getState().entries[0]);
  });

  it('keeps the entry in view visible in a long outline', () => {
    const md = Array.from({ length: 300 }, (_, i) => `## Section ${i}`).join('\n\n');
    const { store } = setup(md);
    const list = screen.getByRole('list');
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 300 * 24 });
    list.querySelectorAll('li').forEach((li, i) => {
      Object.defineProperty(li, 'offsetTop', { configurable: true, value: i * 24 });
      Object.defineProperty(li, 'offsetHeight', { configurable: true, value: 24 });
    });

    act(() => store.setActive(150));
    expect(list.scrollTop).toBe(150 * 24 + 24 - 200);
    act(() => store.setActive(10));
    expect(list.scrollTop).toBe(10 * 24);
  });

  it('can be shown without jumping (a version preview is open)', () => {
    const store = createDocOutlineStore();
    store.setEntries(outlineEntries(MD));
    const onJump = vi.fn();
    render(<DocOutline store={store} onJump={onJump} disabled />);
    fireEvent.click(items()[0]!);
    expect(onJump).not.toHaveBeenCalled();
    expect(items()[0]).toBeDisabled();
  });
});
