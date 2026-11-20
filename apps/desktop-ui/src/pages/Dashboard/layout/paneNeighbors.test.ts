import { describe, expect, it } from 'vitest';
import { paneInDirection, paneInOrder, type PaneBox } from './paneNeighbors';

function box(id: string, left: number, top: number, right: number, bottom: number): PaneBox {
  return { id, left, top, right, bottom };
}

// ┌──────┬──────┐
// │      │  b   │
// │  a   ├──────┤
// │      │  c   │
// ├──────┴──────┤
// │      d      │
// └─────────────┘
const layout: PaneBox[] = [
  box('a', 0, 0, 400, 400),
  box('b', 400, 0, 800, 200),
  box('c', 400, 200, 800, 400),
  box('d', 0, 400, 800, 600),
];

describe('paneInDirection', () => {
  it('moves to the pane beside, picking the one most in line', () => {
    expect(paneInDirection(layout, 'b', 'left')).toBe('a');
    expect(paneInDirection(layout, 'c', 'left')).toBe('a');
    expect(paneInDirection(layout, 'a', 'down')).toBe('d');
    expect(paneInDirection(layout, 'b', 'down')).toBe('c');
    expect(paneInDirection(layout, 'c', 'up')).toBe('b');
  });

  it('takes the first in reading order when two panes are equally in line', () => {
    expect(paneInDirection(layout, 'd', 'up')).toBe('a');
    expect(paneInDirection(layout, 'a', 'right')).toBe('b');
  });

  it('prefers a pane level with this one over a nearer one off to the side', () => {
    const panes = [
      box('here', 0, 0, 100, 100),
      box('near-below', 110, 200, 200, 300),
      box('far-level', 300, 0, 400, 100),
    ];
    expect(paneInDirection(panes, 'here', 'right')).toBe('far-level');
  });

  it('stops at the edge of the layout instead of wrapping', () => {
    expect(paneInDirection(layout, 'a', 'left')).toBeNull();
    expect(paneInDirection(layout, 'b', 'up')).toBeNull();
    expect(paneInDirection(layout, 'd', 'down')).toBeNull();
  });

  it('tolerates the divider between panes', () => {
    const split = [box('left', 0, 0, 399, 300), box('right', 403, 0, 800, 300)];
    expect(paneInDirection(split, 'left', 'right')).toBe('right');
    expect(paneInDirection(split, 'right', 'left')).toBe('left');
  });

  it('returns null for a pane it does not know', () => {
    expect(paneInDirection(layout, 'missing', 'right')).toBeNull();
  });
});

describe('paneInOrder', () => {
  const ids = ['a', 'b', 'c'];

  it('steps through panes in reading order, wrapping at the ends', () => {
    expect(paneInOrder(ids, 'a', 1)).toBe('b');
    expect(paneInOrder(ids, 'c', 1)).toBe('a');
    expect(paneInOrder(ids, 'a', -1)).toBe('c');
  });

  it('starts from the first pane when none is active', () => {
    expect(paneInOrder(ids, null, 1)).toBe('a');
    expect(paneInOrder(ids, 'gone', -1)).toBe('c');
  });

  it('has nowhere to go with a single pane', () => {
    expect(paneInOrder(['a'], 'a', 1)).toBeNull();
  });
});
