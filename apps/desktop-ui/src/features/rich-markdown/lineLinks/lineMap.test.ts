import { describe, expect, it, vi } from 'vitest';
import { getSchema } from '@tiptap/core';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { ChipNode } from '@desktop/features/rich-markdown/editor/ChipNode';
import { richMarkdownToDoc } from '@desktop/features/rich-markdown/editor/richMarkdown';
import { sliceLineRef } from '@snaglet/shared/utils';
import {
  headingBlockPositions,
  headingLineAtPos,
  linesForSelection,
  linesForSourceSelection,
  markdownBlockLines,
  rangeForLines,
  sourceOffsetsForLines,
  textblocks,
} from './lineMap';

// Mirrors ChipEditableInput's richBlocks schema.
const schema = getSchema([
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    underline: false,
    link: { autolink: false, openOnClick: false },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  ChipNode.configure({ showIncludeToggle: true, parseBareIds: true }),
]);

const MD = [
  '# Scraping', //               1
  '', //                         2
  'Firecrawl handles the crawl', // 3
  'and returns markdown.', //    4
  '', //                         5
  '## Rate limits', //           6
  '', //                         7
  '- 10 requests per minute', // 8
  '- back off on 429', //        9
  '', //                         10
  '```ts', //                    11
  'await crawl(url);', //        12
  '```', //                      13
  '', //                         14
  '| plan | rpm |', //           15
  '| ---- | --- |', //           16
  '| free | 10 |', //            17
].join('\n');

const doc = () => richMarkdownToDoc(MD, schema, { parseBareIds: true });
const text = (from: number, to: number) => doc().textBetween(from, to, '\n');

describe('markdownBlockLines', () => {
  it('lines up 1:1 with the editor textblocks, tables and lists included', () => {
    const map = markdownBlockLines(MD);
    const blocks = textblocks(doc());
    expect(map.length).toBe(blocks.length);
    expect(map.slice(0, 5)).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 4 },
      { start: 6, end: 6 },
      { start: 8, end: 8 },
      { start: 9, end: 9 },
    ]);
    expect(map[5]).toEqual({ start: 11, end: 13 });
  });

  it('counts the empty paragraph the editor puts in an empty list item', () => {
    // The worksheet's blank answers (`1. ` …) are list items with no text;
    // the editor still gives each one a paragraph, so later headings keep
    // their own lines.
    const md = [
      '## Q2', //          1
      '', //               2
      '1. ', //            3
      '2. ', //            4
      '3. ', //            5
      '', //               6
      '- - nested', //     7
      '', //               8
      '>', //              9
      '', //               10
      '## Q3', //          11
      '', //               12
      'Body.', //          13
    ].join('\n');
    const parsed = richMarkdownToDoc(md, schema, { parseBareIds: true });
    const map = markdownBlockLines(md);
    const blocks = textblocks(parsed);
    expect(map.length).toBe(blocks.length);
    const q3 = blocks.findIndex((block) => block.node.textContent === 'Q3');
    expect(map[q3]).toEqual({ start: 11, end: 11 });
    const r = rangeForLines(parsed, md, { startLine: 11, endLine: 11 })!;
    expect(parsed.textBetween(r.from, r.to, '\n')).toBe('Q3');
  });
});

describe('markdownBlockLines with task lines in table cells', () => {
  const tableDoc = (cell: string) =>
    [
      '| Done | Task |', //   1
      '| --- | --- |', //    2
      `| ${cell} | t |`, //  3
      '', //                 4
      'Para one', //         5
      '', //                 6
      'Para two', //         7
    ].join('\n');

  it.each([
    ['two task lines', '[ ] a<br>[ ] b'],
    ['a single task', '[x] a'],
    ['text, then a task', 'note<br>[ ] a'],
  ])('keeps one line entry per editor block for %s', (_name, cell) => {
    const md = tableDoc(cell);
    const parsed = richMarkdownToDoc(md, schema, { parseBareIds: true });
    const map = markdownBlockLines(md);
    expect(map.length).toBe(textblocks(parsed).length);
    const r = rangeForLines(parsed, md, { startLine: 7, endLine: 7 })!;
    expect(parsed.textBetween(r.from, r.to, '\n')).toBe('Para two');

    let para: { from: number; to: number } | null = null;
    parsed.descendants((node, pos) => {
      if (!para && node.isText && node.text === 'Para two')
        para = { from: pos, to: pos + node.text.length };
    });
    expect(linesForSelection(parsed, md, para!.from, para!.to)).toEqual({
      startLine: 7,
      endLine: 7,
    });
  });
});

describe('rangeForLines (link → editor highlight)', () => {
  it('covers whole blocks for a line span', () => {
    const r = rangeForLines(doc(), MD, { startLine: 6, endLine: 9 })!;
    expect(text(r.from, r.to)).toBe('Rate limits\n10 requests per minute\nback off on 429');
  });

  it('a line inside a multi-line paragraph selects that paragraph', () => {
    const r = rangeForLines(doc(), MD, { startLine: 4, endLine: 4 })!;
    expect(text(r.from, r.to)).toBe('Firecrawl handles the crawl and returns markdown.');
  });

  it('char-precise links select just that text', () => {
    // "handles the crawl" = line 3, chars 11..27
    const r = rangeForLines(doc(), MD, { startLine: 3, endLine: 3, startChar: 11, endChar: 27 })!;
    expect(text(r.from, r.to)).toBe('handles the crawl');
    const across = rangeForLines(doc(), MD, {
      startLine: 3,
      endLine: 4,
      startChar: 23,
      endChar: 11,
    })!;
    expect(text(across.from, across.to)).toBe('crawl and returns');
  });

  it('returns null past the end of the doc', () => {
    expect(rangeForLines(doc(), MD, { startLine: 99, endLine: 120 })).toBeNull();
  });
});

describe('linesForSelection (editor selection → link)', () => {
  const find = (needle: string) => {
    const d = doc();
    let hit: { from: number; to: number } | null = null;
    d.descendants((node, pos) => {
      if (hit || !node.isText) return;
      const i = node.text!.indexOf(needle);
      if (i >= 0) hit = { from: pos + i, to: pos + i + needle.length };
    });
    return hit!;
  };

  it('whole blocks give a plain line span', () => {
    const d = doc();
    const blocks = textblocks(d);
    const from = blocks[2].pos + 1; // "Rate limits"
    const to = blocks[4].pos + blocks[4].node.nodeSize - 1; // "back off on 429"
    expect(linesForSelection(d, MD, from, to)).toEqual({ startLine: 6, endLine: 9 });
  });

  it('part of a line gives char-precise ends that slice back to the same text', () => {
    const { from, to } = find('handles the crawl');
    const lines = linesForSelection(doc(), MD, from, to)!;
    expect(lines).toEqual({ startLine: 3, endLine: 3, startChar: 11, endChar: 27 });
    expect(sliceLineRef(MD, lines).text).toBe('handles the crawl');
  });

  it('round-trips selection → link → highlight for text inside a list and code', () => {
    for (const needle of ['requests per', 'crawl(url)']) {
      const { from, to } = find(needle);
      const lines = linesForSelection(doc(), MD, from, to)!;
      expect(sliceLineRef(MD, lines).text).toBe(needle);
      const r = rangeForLines(doc(), MD, lines)!;
      expect(text(r.from, r.to)).toBe(needle);
    }
  });
});

describe('source mode', () => {
  it('maps textarea offsets to exact lines/chars and back', () => {
    const start = MD.indexOf('handles');
    const end = start + 'handles the crawl'.length;
    const lines = linesForSourceSelection(MD, start, end)!;
    expect(lines).toEqual({ startLine: 3, endLine: 3, startChar: 11, endChar: 27 });
    expect(sourceOffsetsForLines(MD, lines)).toEqual([start, end]);
  });

  it('full lines drop the char part', () => {
    const start = MD.indexOf('## Rate');
    const end = MD.indexOf('429') + 3;
    expect(linesForSourceSelection(MD, start, end)).toEqual({ startLine: 6, endLine: 9 });
  });
});

describe('repeated text and inline markup', () => {
  const md2 = ['the cat and the **cat** sat', '', '- the cat', '- the cat again'].join('\n');
  const d2 = () => richMarkdownToDoc(md2, schema, { parseBareIds: true });

  it('picks the right copy of a repeated phrase in both directions', () => {
    const d = d2();
    const block = textblocks(d)[0];
    const text0 = block.node.textContent; // "the cat and the cat sat"
    const second = text0.indexOf('cat', 5);
    const from = block.pos + 1 + second;
    const lines = linesForSelection(d, md2, from, from + 3)!;
    const r = rangeForLines(d, md2, lines)!;
    expect(r.from).toBe(from);
    expect(d.textBetween(r.from, r.to)).toBe('cat');
  });

  it('highlights the second list item, not the first', () => {
    const d = d2();
    const r = rangeForLines(d, md2, { startLine: 4, endLine: 4, startChar: 3, endChar: 9 })!;
    expect(d.textBetween(r.from, r.to)).toBe('the cat');
    expect(r.from).toBeGreaterThan(textblocks(d)[1].pos);
  });
});

describe('headingLineAtPos (hover a heading → its source line)', () => {
  it('maps heading blocks to their line and ignores other blocks', () => {
    const d = doc();
    const blocks = textblocks(d);
    expect(headingLineAtPos(d, MD, blocks[0].pos + 1)).toBe(1);
    expect(headingLineAtPos(d, MD, blocks[2].pos + 1)).toBe(6);
    expect(headingLineAtPos(d, MD, blocks[1].pos + 1)).toBeNull();
  });
});

describe('headingBlockPositions (outline line → editor heading)', () => {
  it('maps each heading line to its block and skips a transcluded doc', () => {
    const md = [
      '# Plan', //                                    1
      '', //                                          2
      '![Other](doc-2222222222222-bbbbbbbbb)', //     3
      '', //                                          4
      '## Goals', //                                  5
    ].join('\n');
    const d = richMarkdownToDoc(md, schema, { parseBareIds: true });
    const positions = headingBlockPositions(d, md);
    expect([...positions.keys()]).toEqual([1, 5]);
    expect(d.nodeAt(positions.get(1)!)?.textContent).toBe('Plan');
    expect(d.nodeAt(positions.get(5)!)?.textContent).toBe('Goals');
    expect(positions.has(3)).toBe(false);
  });
});
