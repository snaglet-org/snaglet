/**
 * Table chips in id-only (`passIdOnly`) inputs.
 *
 * Id-keyed consumers (e.g. a related-table field comparing `table.id ===
 * value`) need the bare catalog id, so an id-only input stores a table chip as
 * `table-…` and must read that bare value back as the same chip. Prose inputs
 * store `[Name](table:<id>)` and never chip a bare `table-…`.
 */
import { useState } from 'react';
import { getSchema } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ list: vi.fn(), agents: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, list: api.list },
    agentsApi: { ...actual.agentsApi, list: api.agents },
  };
});

import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import { ChipNode } from './ChipNode';
import { ChipEditableInput } from './ChipEditableInput';
import { docToMarkdown, markdownToDoc } from './markdown';
import { docToRichMarkdown, richMarkdownToDoc } from './richMarkdown';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const BUILTIN_ID = 'table-builtin-docs';
const table: TableCatalogEntry = {
  id: TABLE_ID,
  name: 'Reading list',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const tableChip: NodeChipData = { id: TABLE_ID, kind: 'table', title: 'Reading list' };

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

describe('id-only table chip markdown', () => {
  it.each([
    ['plain', plainSchema, markdownToDoc, docToMarkdown],
    ['rich', richSchema, richMarkdownToDoc, docToRichMarkdown],
  ] as const)(
    '%s: a bare catalog id reads as a table chip and serializes back bare',
    (_, schema, toDoc, toMd) => {
      for (const id of [TABLE_ID, BUILTIN_ID]) {
        const doc = toDoc(id, schema, { parseBareIds: true, parseBareTableIds: true });
        expect(chipsOf(doc)).toEqual([
          expect.objectContaining({ href: `table:${id}`, kind: 'table', include: false }),
        ]);
        expect(toMd(asEditor(doc), { passIdOnly: true })).toBe(id);
      }
    }
  );

  it.each([
    ['plain', plainSchema, markdownToDoc, docToMarkdown],
    ['rich', richSchema, richMarkdownToDoc, docToRichMarkdown],
  ] as const)(
    '%s: prose keeps a bare catalog id as text and chips only `table:` links',
    (_, schema, toDoc, toMd) => {
      const prose = `Ids like ${TABLE_ID} stay text.`;
      const proseDoc = toDoc(prose, schema, { parseBareIds: true });
      expect(chipsOf(proseDoc)).toEqual([]);
      expect(toMd(asEditor(proseDoc))).toBe(prose);

      const link = `[Reading list](table:${TABLE_ID})`;
      const linkDoc = toDoc(link, schema, { parseBareIds: true });
      expect(chipsOf(linkDoc)).toEqual([
        expect.objectContaining({
          href: `table:${TABLE_ID}`,
          kind: 'table',
          title: 'Reading list',
        }),
      ]);
      expect(toMd(asEditor(linkDoc))).toBe(link);
      // The same chip in an id-only input stores the bare catalog id.
      expect(toMd(asEditor(linkDoc), { passIdOnly: true })).toBe(TABLE_ID);
    }
  );
});

// jsdom has no layout. Stub geometry only; drops run through real ProseMirror handlers.
beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

function drop(element: HTMLElement, value: NodeChipData) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(value) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

function Harness({
  initial,
  passIdOnly,
  onValue,
}: {
  initial: string;
  passIdOnly: boolean;
  onValue: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ChipEditableInput
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
      passIdOnly={passIdOnly}
      ariaLabel="Related table"
      enableNodeMentions={false}
    />
  );
}

describe('ChipEditableInput id-only table chips', () => {
  beforeEach(() => {
    vi.spyOn(EditorView.prototype, 'posAtCoords').mockImplementation(function (this: EditorView) {
      return { pos: this.state.selection.from, inside: -1 };
    });
    api.agents.mockResolvedValue([]);
    api.list.mockResolvedValue({ tables: [table] });
  });
  afterEach(() => {
    setActiveDragChip(null);
    vi.restoreAllMocks();
  });

  it('stores a dropped table chip as its bare catalog id and keeps showing the chip', async () => {
    const onValue = vi.fn();
    render(<Harness initial="" passIdOnly onValue={onValue} />);
    const input = await screen.findByRole('textbox', { name: 'Related table' });
    drop(input, tableChip);
    await waitFor(() => expect(onValue).toHaveBeenLastCalledWith(TABLE_ID));
    await waitFor(() =>
      expect(input.querySelector('.md-chip-table')).toHaveTextContent('Reading list')
    );
  });

  it('re-renders a stored bare catalog id as the table chip with its live name', async () => {
    render(<Harness initial={TABLE_ID} passIdOnly onValue={vi.fn()} />);
    const input = await screen.findByRole('textbox', { name: 'Related table' });
    await waitFor(() =>
      expect(input.querySelector(`[data-node-url="table:${TABLE_ID}"]`)).toHaveTextContent(
        'Reading list'
      )
    );
  });

  it('leaves a bare catalog id as text in a prose input', async () => {
    render(<Harness initial={TABLE_ID} passIdOnly={false} onValue={vi.fn()} />);
    const input = await screen.findByRole('textbox', { name: 'Related table' });
    await waitFor(() => expect(input).toHaveTextContent(TABLE_ID));
    expect(input.querySelector('.md-chip')).toBeNull();
  });

  it('stores a dropped table chip as a `table:` link in a prose input', async () => {
    const onValue = vi.fn();
    render(<Harness initial="" passIdOnly={false} onValue={onValue} />);
    const input = await screen.findByRole('textbox', { name: 'Related table' });
    drop(input, tableChip);
    await waitFor(() =>
      expect(onValue).toHaveBeenLastCalledWith(`[Reading list](table:${TABLE_ID})`)
    );
  });
});
