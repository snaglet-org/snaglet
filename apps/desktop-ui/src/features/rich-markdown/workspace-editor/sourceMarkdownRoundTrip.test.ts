import { describe, expect, it, vi } from 'vitest';
import { getSchema } from '@tiptap/core';

// richMarkdown → agentMentionCache pulls in the `@desktop/utils/api`
// barrel, whose config module throws at import time without a runtime
// env. Stub the vars before the import graph evaluates (canonical pattern
// used by the other api-touching suites).
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

import { ChipNode } from '@desktop/features/rich-markdown/editor/ChipNode';
import {
  docToRichMarkdown,
  richMarkdownToDoc,
} from '@desktop/features/rich-markdown/editor/richMarkdown';

/**
 * Source mode shares the rich editor's markdown string, which is only
 * re-serialized when the user edits in rendered mode. These tests pin that
 * path (markdown → richMarkdownToDoc → docToRichMarkdown → markdown) so common
 * constructs stay lossless. The schema mirrors ChipEditableInput's
 * `richBlocks` extensions; a bare `{ state: { doc } }` stands in for an Editor.
 */
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

function roundTrip(markdown: string): string {
  const doc = richMarkdownToDoc(markdown, schema, { parseBareIds: true });
  const fakeEditor = { state: { doc } } as unknown as Editor;
  return docToRichMarkdown(fakeEditor);
}

function chipsIn(markdown: string): Array<Record<string, unknown>> {
  const chips: Array<Record<string, unknown>> = [];
  richMarkdownToDoc(markdown, schema, { parseBareIds: true }).descendants((node) => {
    if (node.type.name === 'chip') chips.push(node.attrs);
  });
  return chips;
}

describe('source-mode markdown round-trip (rendered → doc → raw)', () => {
  // A realistic workspace node id so `parseNodeRef` recognizes the chip.
  const DOC_ID = 'doc-1111111111111-9gqbtkgh1';
  const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it.each([
    ['plain paragraph', 'Hello world.'],
    ['two paragraphs', 'First paragraph.\n\nSecond paragraph.'],
    ['heading', '# Title'],
    ['sub-heading', '### Deep heading'],
    ['wiki-link chip', `[Project Overview](${DOC_ID})`],
    ['transclusion chip', `![](${DOC_ID})`],
    ['chip inline in prose', `See [Overview](${DOC_ID}) for details.`],
    ['tool chip with a slug id', '[Weather today](tool:weather_today)'],
    ['bold', '**bold text**'],
    ['italic', '*italic text*'],
    ['strikethrough', '~~struck text~~'],
    ['inline code', '`const x = 1`'],
    ['bullet list', '- one\n- two\n- three'],
    ['ordered list', '1. one\n2. two\n3. three'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['blockquote', '> a quoted line'],
    ['fenced code block', '```ts\nconst x = 1;\n```'],
    ['line link chip', `[Getting Started Worksheet › L3–5](${DOC_ID}#L3-L5)`],
    ['single-line link chip', `[Getting Started Worksheet › L7](${DOC_ID}#L7)`],
    ['line links in a list', `- [Doc › L3–5](${DOC_ID}#L3-L5) and [Doc › L7](${DOC_ID}#L7)`],
  ])('round-trips %s identically', (_label, input) => {
    expect(roundTrip(input)).toBe(input);
  });

  it('round-trips a combined document with mixed constructs identically', () => {
    const doc = [
      '# Design notes',
      '',
      'Intro paragraph with **bold**, *italic*, and `code`.',
      '',
      `Linked to [Spec](${DOC_ID}).`,
      '',
      '- first',
      '- second',
      '',
      '1. step one',
      '2. step two',
      '',
      '- [ ] open task',
      '- [x] done task',
      '',
      '> a quote',
      '',
      '```js',
      'const answer = 42;',
      '```',
    ].join('\n');
    expect(roundTrip(doc)).toBe(doc);
  });

  it('round-trips a table whose cells hold several lines (`<br>`) identically', () => {
    const table = [
      '| Case | Why<br>(short) |',
      '| --- | --- |',
      '| A | • first reason<br>• second reason<br>• third reason |',
      `| B | **bold**<br>[Spec](${DOC_ID})<br> |`,
      '',
    ].join('\n');
    expect(roundTrip(table)).toBe(table);
  });

  it('parses a hand-written line range into a line link chip and saves the canonical range', () => {
    expect(chipsIn(`[Doc › L3–5](${DOC_ID}#L3–5)`)).toEqual([
      expect.objectContaining({ kind: 'doc', href: `${DOC_ID}#L3-L5` }),
    ]);
    expect(roundTrip(`[Doc › L3–5](${DOC_ID}#L3-5)`)).toBe(`[Doc › L3–5](${DOC_ID}#L3-L5)`);
  });

  it('parses a slug tool reference into a tool chip, not a plain link', () => {
    expect(chipsIn('[weather](tool:weather)')).toEqual([
      expect.objectContaining({ kind: 'tool', href: 'tool:weather' }),
    ]);
    expect(roundTrip('[weather](tool:weather)')).toBe('[weather](tool:weather)');
    expect(roundTrip('Ask [Weather](tool:weather) first.')).toBe(
      'Ask [Weather](tool:weather) first.'
    );
  });

  // Only `[Title](tool:<id>)` links take the slug grammar; prose that merely
  // contains `tool:` stays text.
  it.each([
    ['an event name', 'Hooks fire on tool:create events.'],
    ['a longer word', 'stool:sample'],
    ['a socket event', 'socket:tool:confirmation_request'],
  ])('keeps %s with `tool:` in prose as text', (_label, input) => {
    expect(chipsIn(input)).toEqual([]);
    expect(roundTrip(input)).toBe(input);
  });

  it('keeps a bracketed `[tool:policy]` tag as text', () => {
    expect(chipsIn('[tool:policy] blocked it')).toEqual([]);
    // The serializer escapes brackets in all plain text (`[policy]` too); no chip.
    expect(roundTrip('[tool:policy] blocked it')).toBe('\\[tool:policy\\] blocked it');
  });

  it('keeps the fragment on a bare `tool:<uuid>#L2`', () => {
    const input = `tool:${UUID}#L2 here`;
    expect(roundTrip(input)).toBe(input);
  });

  it('preserves the chip title text verbatim when serializing back', () => {
    const out = roundTrip(`[My Doc Title](${DOC_ID})`);
    expect(out).toContain('My Doc Title');
    expect(out).toContain(DOC_ID);
  });
});
