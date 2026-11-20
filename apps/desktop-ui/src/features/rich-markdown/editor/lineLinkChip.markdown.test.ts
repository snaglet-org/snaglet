import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import { ChipNode } from './ChipNode';
import { markdownToDoc, docToMarkdown } from './markdown';
import { richMarkdownToDoc, docToRichMarkdown } from './richMarkdown';

// Doc line links parse into the same chip a plain doc link does, in both the
// paragraphs-and-chips fields and the rich editor, and save back intact. A
// range written the way the chip label reads saves in the canonical form.
const ID = 'doc-1794864925672-y0r38dfw5';
const LINK = `[Getting Started Worksheet › L3–5](${ID}#L3-L5)`;
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
] as const)('%s line link chips', (_, schema, parse, serialize) => {
  it('parses a line link into a doc chip and saves it back exactly', () => {
    const doc = parse(`see ${LINK} and [Other › L7](${ID}#L7)`, schema);
    expect(chips(doc)).toEqual([
      expect.objectContaining({
        kind: 'doc',
        href: `${ID}#L3-L5`,
        title: 'Getting Started Worksheet › L3–5',
      }),
      expect.objectContaining({ kind: 'doc', href: `${ID}#L7` }),
    ]);
    expect(serialize(asEditor(doc))).toBe(`see ${LINK} and [Other › L7](${ID}#L7)`);
  });

  it.each(['#L3–5', '#L3-5', '#L3–L5'])('saves a `%s` range as `#L3-L5`', (fragment) => {
    const doc = parse(`[Getting Started Worksheet › L3–5](${ID}${fragment})`, schema);
    expect(chips(doc)).toHaveLength(1);
    expect(serialize(asEditor(doc))).toBe(LINK);
  });
});
