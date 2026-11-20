import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { describe, expect, it } from 'vitest';
import { nodeToChipMarkdown } from '@desktop/utils/nodeChip';
import { ChipNode } from './ChipNode';
import { markdownToDoc, docToMarkdown } from './markdown';
import { richMarkdownToDoc, docToRichMarkdown } from './richMarkdown';

// A file chip carries an absolute path behind the `file:` scheme. markdown-it
// refuses `file:` links by default; the doc editor must still read one back
// as a chip, or a saved file reference reopens as literal markdown.
const path = '/projects/example/episodes/2026-01-01/show.mp3';
const plain = getSchema([StarterKit, ChipNode]);
const rich = getSchema([
  StarterKit,
  TaskList,
  TaskItem,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  ChipNode,
]);
const asEditor = (doc: ReturnType<typeof markdownToDoc>) =>
  ({ state: { doc } }) as unknown as Editor;

function chips(doc: ReturnType<typeof markdownToDoc>) {
  const result: Record<string, unknown>[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'chip') result.push(node.attrs);
  });
  return result;
}

describe.each([
  ['plain', plain, markdownToDoc, docToMarkdown],
  ['rich', rich, richMarkdownToDoc, docToRichMarkdown],
] as const)('%s file chip markdown', (_, schema, parse, serialize) => {
  it.each([
    ['a plain path', path],
    ['a path with spaces', '/projects/example/episodes/Morning show.mp3'],
  ])('round-trips a file chip to %s', (_label, filePath) => {
    const markdown = nodeToChipMarkdown({ kind: 'file', id: filePath, title: 'show.mp3' });
    const doc = parse(markdown, schema);
    expect(chips(doc)).toEqual([
      expect.objectContaining({
        kind: 'file',
        href: markdown.slice(markdown.indexOf('(') + 1, -1),
      }),
    ]);
    expect(serialize(asEditor(doc))).toBe(markdown);
  });

  it('reads a hand-written file reference inside prose as a chip', () => {
    const doc = parse(`Today's episode: [show.mp3](file:${path}) is ready.`, schema);
    expect(chips(doc)).toEqual([
      expect.objectContaining({ kind: 'file', href: `file:${path}`, title: 'show.mp3' }),
    ]);
  });
});

// Only hrefs parseNodeRef accepts bypass markdown-it's link check; every other
// href it refuses stays refused, as neither a reference nor a link, and its
// source survives as text. `file:%2F%2Fhost/x` decodes to a `//host` authority,
// so it is refused like `file://host/x`.
describe.each([
  ['plain', plain, markdownToDoc],
  ['rich', rich, richMarkdownToDoc],
] as const)('%s editor link safety', (_, schema, parse) => {
  it.each([
    '[x](file://host/share/x.mp3)',
    '[x](FILE://host/x)',
    '[x](file:%2F%2Fhost/x)',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,hello)',
    '[x](vbscript:msgbox)',
    '<javascript:alert(1)>',
    '![](file://host/x)',
  ])('keeps %s as plain text', (source) => {
    const doc = parse(source, schema);
    expect(chips(doc)).toEqual([]);
    let linked = false;
    doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === 'link')) linked = true;
    });
    expect(linked).toBe(false);
    expect(doc.textContent).toBe(source);
  });
});
