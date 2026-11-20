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

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const id = `${tableId}/${entryId}`;
const href = `entry:${id}`;
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
] as const)('%s entry markdown', (_, schema, parse, serialize) => {
  it.each(['', 'A name', '[Draft] \\ path'])(
    'round-trips the label %j as one entry chip',
    (title) => {
      const markdown = nodeToChipMarkdown({ kind: 'entry', id, title });
      const doc = parse(markdown, schema, { parseBareIds: true, parseBareTableIds: true });
      expect(chips(doc)).toEqual([expect.objectContaining({ kind: 'entry', href, title })]);
      expect(serialize(asEditor(doc))).toBe(markdown);
      expect(serialize(asEditor(doc), { passIdOnly: true })).toBe(href);
    }
  );

  it('never chips the table part of an entry href in an id-only surface', () => {
    const doc = parse(href, schema, { parseBareIds: true, parseBareTableIds: true });
    expect(chips(doc)).toEqual([expect.objectContaining({ kind: 'entry', href })]);
    expect(serialize(asEditor(doc), { passIdOnly: true })).toBe(href);
    const invalid = parse(`entry:${tableId}/bad-id`, schema, {
      parseBareIds: true,
      parseBareTableIds: true,
    });
    expect(chips(invalid)).toEqual([]);
  });
});

describe('rich ordinary links', () => {
  it('leave ids inside their text as link text rather than chips', () => {
    const markdown = `[see ${href}](https://example.com/notes)`;
    const doc = richMarkdownToDoc(markdown, rich, { parseBareIds: true, parseBareTableIds: true });
    expect(chips(doc)).toEqual([]);
    expect(doc.textContent).toBe(`see ${href}`);
  });
});
