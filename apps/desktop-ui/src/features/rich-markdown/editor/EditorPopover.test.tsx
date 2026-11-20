/**
 * The @ / slash menu card orients by its measured height: below the caret
 * when it fits, else above, else the roomier side (scrolling), never over
 * the caret's line. jsdom's window is 1024 × 768; the card's content height
 * is stubbed through `data-h` (jsdom has no layout).
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPopover } from './EditorPopover';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Number(this.dataset.h ?? 0);
  });
});
afterEach(() => vi.restoreAllMocks());

function card(anchorTop: number, contentHeight: number, maxHeight?: number) {
  render(
    <EditorPopover
      anchor={{ left: 100, top: anchorTop, bottom: anchorTop + 20 }}
      ariaLabel="Suggestions"
      maxHeight={maxHeight}
    >
      <div data-h={contentHeight} />
    </EditorPopover>
  );
  const style = screen.getByRole('listbox', { name: 'Suggestions' }).style;
  return { top: Number.parseFloat(style.top), maxHeight: Number.parseFloat(style.maxHeight) };
}

describe('EditorPopover placement', () => {
  it('opens below the caret when it fits there', () => {
    expect(card(100, 200).top).toBe(128);
  });

  it('flips above, hugging the caret, when only above holds it whole', () => {
    // 128 below, 580 above: the 300px card ends 8px over the caret line.
    expect(card(600, 300).top).toBe(292);
  });

  it('takes the roomier side and scrolls when neither holds it, never covering the caret', () => {
    // 428 below, 280 above for a 500px card: below, capped to the room there.
    expect(card(300, 500, 600)).toEqual({ top: 328, maxHeight: 428 });
  });
});
