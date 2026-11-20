/**
 * Where a calendar surface opens: beside an item in a Week / Day grid (so it
 * covers neither the item nor the hours under it), below anything else.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnchoredSurface } from './AnchoredSurface';

const anchors: HTMLElement[] = [];

/** An anchor at x 100–250, y 300–340 (jsdom's window is 1024 × 768), optionally in a time grid. */
function anchor(inTimeGrid: boolean): HTMLElement {
  const host = document.createElement('div');
  if (inTimeGrid) host.dataset.timeGrid = '';
  const el = document.createElement('button');
  host.append(el);
  document.body.append(host);
  anchors.push(host);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 300, 150, 40));
  return el;
}

function placed() {
  const style = screen.getByRole('dialog', { name: 'Test surface' }).style;
  return { left: Number.parseFloat(style.left), top: Number.parseFloat(style.top) };
}

afterEach(() => {
  for (const host of anchors.splice(0)) host.remove();
  vi.restoreAllMocks();
});

describe('AnchoredSurface side', () => {
  it('opens right of an item in a time grid, top-aligned with it', () => {
    render(
      <AnchoredSurface anchor={anchor(true)} label="Test surface" onDismiss={vi.fn()}>
        <p>Body</p>
      </AnchoredSurface>
    );
    expect(placed()).toEqual({ left: 254, top: 300 });
  });

  it('opens below anything else', () => {
    render(
      <AnchoredSurface anchor={anchor(false)} label="Test surface" onDismiss={vi.fn()}>
        <p>Body</p>
      </AnchoredSurface>
    );
    expect(placed()).toEqual({ left: 100, top: 344 });
  });

  it('an explicit side wins', () => {
    render(
      <AnchoredSurface anchor={anchor(true)} label="Test surface" side="below" onDismiss={vi.fn()}>
        <p>Body</p>
      </AnchoredSurface>
    );
    expect(placed()).toEqual({ left: 100, top: 344 });
  });
});
