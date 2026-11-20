/**
 * Tool chips in id-only (`passIdOnly`) inputs.
 *
 * An id-only input stores a tool chip as its `tool:<slug id>` href and must
 * read that bare value back as the same chip. Prose inputs chip only
 * `[Title](tool:<id>)` links, never bare `tool:` text.
 */
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
import { docToMarkdown, markdownToDoc } from './markdown';
import { docToRichMarkdown, richMarkdownToDoc } from './richMarkdown';

const chipNode = ChipNode.configure({ parseBareIds: true });
const plainSchema = getSchema([StarterKit, chipNode]);
// Mirrors ChipEditableInput's `richBlocks` node set, which the rich parser needs.
const richSchema = getSchema([
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  chipNode,
]);
const asEditor = (doc: ReturnType<typeof markdownToDoc>) =>
  ({ state: { doc } }) as unknown as Editor;

function chipsOf(doc: ReturnType<typeof markdownToDoc>) {
  const chips: Array<Record<string, unknown>> = [];
  doc.descendants((node) => {
    if (node.type.name === 'chip') chips.push(node.attrs);
  });
  return chips;
}

const parsers = [
  ['plain', plainSchema, markdownToDoc, docToMarkdown],
  ['rich', richSchema, richMarkdownToDoc, docToRichMarkdown],
] as const;

describe('id-only tool chip markdown', () => {
  it.each(parsers)(
    '%s: a stored `tool:<slug id>` reads as a tool chip and serializes back',
    (_, schema, toDoc, toMd) => {
      const doc = toDoc('tool:weather_today', schema, {
        parseBareIds: true,
        parseBareTableIds: true,
      });
      expect(chipsOf(doc)).toEqual([
        expect.objectContaining({ href: 'tool:weather_today', kind: 'tool', include: false }),
      ]);
      expect(toMd(asEditor(doc), { passIdOnly: true })).toBe('tool:weather_today');
    }
  );

  it.each(parsers)(
    '%s: `tool:` inside a longer token stays text even in an id-only input',
    (_, schema, toDoc) => {
      const doc = toDoc('stool:sample socket:tool:create', schema, {
        parseBareIds: true,
        parseBareTableIds: true,
      });
      expect(chipsOf(doc)).toEqual([]);
    }
  );

  it.each(parsers)(
    '%s: prose keeps bare `tool:` text and chips only `tool:` links',
    (_, schema, toDoc, toMd) => {
      const prose = 'Hooks fire on tool:create events.';
      const proseDoc = toDoc(prose, schema, { parseBareIds: true });
      expect(chipsOf(proseDoc)).toEqual([]);
      expect(toMd(asEditor(proseDoc))).toBe(prose);

      const link = '[Weather](tool:weather)';
      const linkDoc = toDoc(link, schema, { parseBareIds: true });
      expect(chipsOf(linkDoc)).toEqual([
        expect.objectContaining({ href: 'tool:weather', kind: 'tool', title: 'Weather' }),
      ]);
      expect(toMd(asEditor(linkDoc))).toBe(link);
    }
  );
});
