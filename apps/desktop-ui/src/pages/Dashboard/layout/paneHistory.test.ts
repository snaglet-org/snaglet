import { describe, expect, it } from 'vitest';
import type { DetailSelection } from '../selection/types';
import {
  createLeaf,
  goBackInLeaf,
  historyMenuRows,
  jumpToHistoryEntry,
  replaceLeafSelection,
  type LayoutLeaf,
  type LayoutNode,
} from './paneTree';

function asLeaf(node: LayoutNode): LayoutLeaf {
  if (node.kind !== 'leaf') throw new Error('expected a single leaf');
  return node;
}

/** Open each selection in turn in one pane and return that pane. */
function visit(...selections: DetailSelection[]): LayoutLeaf {
  const [first, ...rest] = selections;
  let layout: LayoutNode = createLeaf(first);
  const leafId = layout.id;
  for (const selection of rest) layout = replaceLeafSelection(layout, leafId, selection);
  return asLeaf(layout);
}

const image = (id: string): DetailSelection => ({ kind: 'image', image_id: id });

describe('pane history', () => {
  it('records each image as its own stop and dedupes reopening the same one', () => {
    const leaf = visit(
      image('image-1111111111111-aaaaaaaaa'),
      image('image-2222222222222-bbbbbbbbb'),
      // A fresh copy of the current image, not the same object.
      { kind: 'image', image_id: 'image-2222222222222-bbbbbbbbb' }
    );

    expect(leaf.history.entries).toEqual([
      image('image-1111111111111-aaaaaaaaa'),
      image('image-2222222222222-bbbbbbbbb'),
    ]);
    expect(leaf.history.index).toBe(1);

    const back = asLeaf(goBackInLeaf(leaf, leaf.id));
    expect(back.selection).toEqual(image('image-1111111111111-aaaaaaaaa'));
  });

  it('keeps singleton surfaces deduped and distinct ids distinct', () => {
    const leaf = visit(
      { kind: 'theme' },
      { kind: 'theme' },
      { kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' },
      { kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' },
      { kind: 'doc', doc_id: 'doc-2222222222222-bbbbbbbbb' }
    );

    expect(leaf.history.entries).toHaveLength(3);
  });
});

describe('Recently visited rows', () => {
  const doc = (id: string): DetailSelection => ({ kind: 'doc', doc_id: id });
  const DOC_A = 'doc-1111111111111-aaaaaaaaa';
  const DOC_B = 'doc-2222222222222-bbbbbbbbb';
  const DOC_C = 'doc-3333333333333-ccccccccc';

  /** Each row as `id index current?` for compact assertions. */
  function describeRows(leaf: LayoutLeaf): string[] {
    return historyMenuRows(leaf.history).map(
      (row) =>
        `${row.entry.kind === 'doc' ? row.entry.doc_id : row.entry.kind} ${row.index}${row.isCurrent ? ' current' : ''}`
    );
  }

  it('lists each place once, most recent first, while back and forward keep every stop', () => {
    const leaf = visit(doc(DOC_A), doc(DOC_B), doc(DOC_A), doc(DOC_C), doc(DOC_A));

    expect(leaf.history.entries).toHaveLength(5);
    expect(describeRows(leaf)).toEqual([`${DOC_A} 4 current`, `${DOC_C} 3`, `${DOC_B} 1`]);

    // Back still steps through the revisit, not just the distinct places.
    const back = asLeaf(goBackInLeaf(leaf, leaf.id));
    expect(back.selection).toEqual(doc(DOC_C));
  });

  it('marks the place being shown even when it also sits further up the stack', () => {
    const leaf = visit(doc(DOC_A), doc(DOC_B), doc(DOC_A), doc(DOC_C));
    // Step back to the first visit of A: the A row is current and jumps nowhere.
    const atFirstA = asLeaf(jumpToHistoryEntry(leaf, leaf.id, 0));

    expect(describeRows(atFirstA)).toEqual([`${DOC_C} 3`, `${DOC_A} 0 current`, `${DOC_B} 1`]);
  });

  it('has no rows for an empty pane', () => {
    expect(historyMenuRows({ entries: [], index: -1 })).toEqual([]);
  });
});

describe('calendar pane history', () => {
  it('is a singleton stop: reopening the Calendar pushes no new entry', () => {
    const leaf = visit(
      { kind: 'calendar' },
      { kind: 'calendar' },
      image('image-1111111111111-aaaaaaaaa'),
      { kind: 'calendar' }
    );
    expect(leaf.history.entries.map((e) => e.kind)).toEqual(['calendar', 'image', 'calendar']);
  });

  const view = (
    zoom: 'month' | 'week' | 'day' | 'year',
    anchor = '2026-10-21'
  ): DetailSelection => ({
    kind: 'calendar',
    view: { zoom, anchor },
  });

  it('each view is its own stop: Week, then Day, then Month steps back through them', () => {
    const leaf = visit(view('week'), view('day'), view('month'), view('year'));
    expect(leaf.history.entries.map((e) => (e?.kind === 'calendar' ? e.view?.zoom : null))).toEqual(
      ['week', 'day', 'month', 'year']
    );
    const back = asLeaf(goBackInLeaf(goBackInLeaf(leaf, leaf.id), leaf.id));
    expect(back.selection).toEqual(view('day'));
  });

  it('moving to another day within a view updates the stop instead of adding one', () => {
    const leaf = visit(
      view('week', '2026-10-21'),
      view('week', '2026-10-28'),
      view('week', '2026-11-04')
    );
    expect(leaf.history.entries).toHaveLength(1);
    expect(leaf.history.entries[0]).toEqual(view('week', '2026-11-04'));
  });

  it('keeps each stop on the day it was left on', () => {
    const leaf = visit(
      view('month', '2026-10-21'),
      view('day', '2026-10-21'),
      view('day', '2026-10-22')
    );
    expect(leaf.history.entries).toEqual([view('month', '2026-10-21'), view('day', '2026-10-22')]);
  });

  it('a fresh open with no view yet takes the first reported view in place', () => {
    const leaf = visit({ kind: 'calendar' }, view('week'));
    expect(leaf.history.entries).toEqual([view('week')]);
  });

  it('a view of the Calendar sits between other panes in the same history', () => {
    const leaf = visit(view('day'), image('image-1111111111111-aaaaaaaaa'), view('day'));
    expect(leaf.history.entries.map((e) => e?.kind)).toEqual(['calendar', 'image', 'calendar']);
  });
});
