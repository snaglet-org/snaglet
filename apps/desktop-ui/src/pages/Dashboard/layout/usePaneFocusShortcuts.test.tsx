import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetPaneFocus, rememberPaneFocus } from './paneFocus';
import type { LayoutLeaf, LayoutNode } from './paneTree';
import { usePaneFocusShortcuts } from './usePaneFocusShortcuts';

function leaf(id: string): LayoutLeaf {
  return { kind: 'leaf', id, selection: null, history: { entries: [], index: -1 } };
}

// Three panes side by side: a | b | c.
const LAYOUT: LayoutNode = {
  kind: 'split',
  id: 'split-1',
  direction: 'horizontal',
  ratios: [33.3, 33.3, 33.4],
  children: [leaf('a'), leaf('b'), leaf('c')],
};

/** A pane as PaneChrome draws it: a chrome zone with a button, and a text field in the body. */
function mountPane(id: string, left: number): { field: HTMLTextAreaElement; chrome: HTMLElement } {
  const pane = document.createElement('div');
  pane.dataset.leafId = id;
  pane.getBoundingClientRect = () =>
    ({ left, top: 0, right: left + 300, bottom: 400, width: 300, height: 400 }) as DOMRect;
  const zone = document.createElement('div');
  zone.dataset.paneChromeZone = 'left';
  const disabled = document.createElement('button');
  disabled.disabled = true;
  const chrome = document.createElement('button');
  chrome.textContent = `${id} chrome`;
  zone.append(disabled, chrome);
  const field = document.createElement('textarea');
  pane.append(zone, field);
  document.body.appendChild(pane);
  return { field, chrome };
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const RIGHT = { key: 'ArrowRight', metaKey: true, altKey: true };
const LEFT = { key: 'ArrowLeft', metaKey: true, altKey: true };

let panes: Record<string, { field: HTMLTextAreaElement; chrome: HTMLElement }>;

beforeEach(() => {
  panes = { a: mountPane('a', 0), b: mountPane('b', 300), c: mountPane('c', 600) };
});

afterEach(() => {
  for (const id of ['a', 'b', 'c']) forgetPaneFocus(id);
  document.body.innerHTML = '';
});

function renderShortcuts(activeLeafId: string | null, layout: LayoutNode = LAYOUT) {
  const onSelectLeaf = vi.fn();
  renderHook(() => usePaneFocusShortcuts(layout, activeLeafId, onSelectLeaf));
  return onSelectLeaf;
}

describe('usePaneFocusShortcuts', () => {
  it('moves to the pane on the right on ⌘⌥→, from inside a text field too', () => {
    const onSelectLeaf = renderShortcuts('a');
    panes.a.field.focus();
    expect(press(RIGHT, panes.a.field).defaultPrevented).toBe(true);
    expect(onSelectLeaf).toHaveBeenCalledWith('b');
    // Nothing focused there yet: the pane's first enabled chrome control.
    expect(panes.b.chrome).toHaveFocus();
  });

  it('puts focus back where it last was in the pane it moves to', () => {
    rememberPaneFocus('a', panes.a.field);
    const onSelectLeaf = renderShortcuts('b');
    press(LEFT);
    expect(onSelectLeaf).toHaveBeenCalledWith('a');
    expect(panes.a.field).toHaveFocus();
  });

  it('stays put at the edge of the layout', () => {
    const onSelectLeaf = renderShortcuts('a');
    press(LEFT);
    expect(onSelectLeaf).not.toHaveBeenCalled();
  });

  it('cycles through panes in reading order on ⌃Tab and back on ⌃⇧Tab', () => {
    const onSelectLeaf = renderShortcuts('c');
    press({ key: 'Tab', ctrlKey: true });
    expect(onSelectLeaf).toHaveBeenLastCalledWith('a');
    press({ key: 'Tab', ctrlKey: true, shiftKey: true });
    expect(onSelectLeaf).toHaveBeenLastCalledWith('b');
  });

  it('leaves the key to a control that handled it (the code editor adds a cursor on ⌘⌥↑)', () => {
    const onSelectLeaf = renderShortcuts('a');
    panes.a.field.addEventListener('keydown', (event) => event.preventDefault());
    press({ key: 'ArrowRight', metaKey: true, altKey: true }, panes.a.field);
    expect(onSelectLeaf).not.toHaveBeenCalled();
  });

  it('does nothing behind an open modal dialog', () => {
    const onSelectLeaf = renderShortcuts('a');
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('aria-modal', 'true');
    press(RIGHT);
    expect(onSelectLeaf).not.toHaveBeenCalled();
  });

  it('leaves the keys alone with a single pane', () => {
    const onSelectLeaf = renderShortcuts('a', leaf('a'));
    expect(press({ key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onSelectLeaf).not.toHaveBeenCalled();
  });
});
