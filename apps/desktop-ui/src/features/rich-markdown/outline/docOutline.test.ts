/**
 * The doc outline: which headings it lists, which one is in view, and the
 * store the editor and the Properties panel share.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveDocAnchor } from '@snaglet/shared/utils';
import {
  activeHeadingIndex,
  createDocOutlineStore,
  outlineEntries,
  type OutlineEntry,
} from './docOutline';

const DOC = [
  '# Plan', //                          1
  '', //                                2
  'Intro text.', //                     3
  '', //                                4
  '## Goals', //                        5
  '### Detail', //                      6
  '#### Four', //                       7
  '##### Five', //                      8
  '###### Six', //                      9
  '', //                                10
  '## Goals', //                        11
  '', //                                12
  '![Other doc](doc-2222222222222-bbbbbbbbb)', // 13
  '', //                                14
  '```md', //                           15
  '# Not a heading', //                 16
  '```', //                             17
  '', //                                18
  '## See [the spec](doc-3333333333333-ccccccccc)', // 19
].join('\n');

const summary = (entries: OutlineEntry[]) => entries.map((e) => [e.level, e.text, e.line]);

describe('outlineEntries', () => {
  it('lists H1 to H6 in document order with their levels and lines', () => {
    expect(summary(outlineEntries(DOC))).toEqual([
      [1, 'Plan', 1],
      [2, 'Goals', 5],
      [3, 'Detail', 6],
      [4, 'Four', 7],
      [5, 'Five', 8],
      [6, 'Six', 9],
      [2, 'Goals', 11],
      [2, 'See the spec', 19],
    ]);
  });

  it('gives repeated headings distinct links that each resolve to their own heading', () => {
    const goals = outlineEntries(DOC).filter((e) => e.text === 'Goals');
    expect(goals).toHaveLength(2);
    expect(goals[0]!.ref).not.toEqual(goals[1]!.ref);
    for (const entry of goals) {
      expect(resolveDocAnchor(DOC, { heading: entry.ref }).lines?.startLine).toBe(entry.line);
    }
  });

  it("skips a transcluded doc's headings, fenced code and empty headings", () => {
    // The transclusion is one `![…](doc-…)` line here; the other doc's
    // headings live in that doc, not in this markdown.
    const md =
      '# Mine\n\n![Other](doc-2222222222222-bbbbbbbbb)\n\n```\n## code\n```\n\n##\n\n## Also mine';
    expect(outlineEntries(md).map((e) => e.text)).toEqual(['Mine', 'Also mine']);
  });

  it('is empty for a doc with no headings', () => {
    expect(outlineEntries('Just a paragraph.\n\n- and a list')).toEqual([]);
    expect(outlineEntries('')).toEqual([]);
  });

  it('handles hundreds of headings', () => {
    const md = Array.from({ length: 600 }, (_, i) => `## Section ${i % 50}\n\ntext`).join('\n\n');
    const entries = outlineEntries(md);
    expect(entries).toHaveLength(600);
    expect(new Set(entries.map((e) => JSON.stringify(e.ref))).size).toBe(600);
  });
});

describe('activeHeadingIndex', () => {
  const tops = (values: number[]) => (i: number) => values[i]!;

  it('picks the last heading at or above the offset', () => {
    expect(activeHeadingIndex(4, tops([-300, -20, 30, 400]), 48, 600)).toBe(2);
    expect(activeHeadingIndex(4, tops([-300, -20, 60, 400]), 48, 600)).toBe(1);
    expect(activeHeadingIndex(4, tops([-900, -800, -700, -600]), 48, 600)).toBe(3);
  });

  it('falls back to the first heading while it is on screen, else to none', () => {
    expect(activeHeadingIndex(2, tops([200, 500]), 48, 600)).toBe(0);
    expect(activeHeadingIndex(2, tops([700, 900]), 48, 600)).toBe(-1);
    expect(activeHeadingIndex(0, tops([]), 48, 600)).toBe(-1);
  });

  it('reads only a handful of tops in a long doc', () => {
    const topAt = vi.fn((i: number) => i * 40 - 8000);
    expect(activeHeadingIndex(1000, topAt, 48, 600)).toBe(201);
    expect(topAt.mock.calls.length).toBeLessThan(15);
  });
});

describe('createDocOutlineStore', () => {
  const entries = outlineEntries('# A\n\n## B\n\n## C');

  it('notifies only when the headings change', () => {
    const store = createDocOutlineStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.setEntries(entries)).toBe(true);
    expect(store.setEntries(outlineEntries('# A\n\n## B\n\n## C'))).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().entries).toBe(entries);
  });

  it('follows scrolling, except while a jump holds the heading it landed on', () => {
    const store = createDocOutlineStore();
    store.setEntries(entries);
    store.setActive(1);
    expect(store.getState().active).toBe(1);

    store.hold(2);
    expect(store.getState().active).toBe(2);
    expect(store.isHeld()).toBe(true);
    store.setActive(0);
    expect(store.getState().active).toBe(2);

    store.release();
    store.setActive(0);
    expect(store.getState().active).toBe(0);
  });

  it('lets go of a hold when the headings change', () => {
    const store = createDocOutlineStore();
    store.setEntries(entries);
    store.hold(2);
    store.setEntries(outlineEntries('# A\n\n## B'));
    expect(store.isHeld()).toBe(false);
    expect(store.getState().active).toBe(-1);
  });
});
