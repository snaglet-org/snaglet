import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableEntriesQuery,
  TableEntriesResponse,
  TableEntry,
  TableEntryResponse,
  TableField,
  UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import { __resetSnagletItemTitlesForTests } from '@desktop/features/table-entries/snagletItemTitles';
import { NODE_CHIP_MIME, setActiveDragChip, type NodeChipData } from '@desktop/utils/nodeChip';
import { TableEntriesGrid } from './TableEntriesGrid';

const api = vi.hoisted(() => ({
  entries: vi.fn<(id: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
  entry: vi.fn(),
  fields: vi.fn(),
  createEntry: vi.fn(),
  updateEntry:
    vi.fn<
      (id: string, entryId: string, input: UpdateTableEntryRequest) => Promise<TableEntryResponse>
    >(),
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return {
    tablesApi: api,
    agentsApi: { list: async () => [] },
    containersApi: { listTree: async () => [] },
    FetchError: core.FetchError,
  };
});
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = '00000000-0000-4000-8000-000000000001';
const schemaVersion = 'a'.repeat(64);
const DOC = 'doc-1111111111111-aaaaaaaaa';
const ARCHIVED_DOC = 'doc-1111111111111-bbbbbbbbb';
const NEW_DOC = 'doc-1111111111111-ddddddddd';
const PURGED_AGENT = 'test-agent-z';
const field = (over: Partial<TableField> & Pick<TableField, 'id' | 'name'>): TableField => ({
  range: false,
  tableId,
  columnName: over.name,
  description: null,
  type: 'text',
  nullable: true,
  defaultValue: null,
  referenceTableId: null,
  referenceKind: null,
  position: 2,
  managed: false,
  collapsed: false,
  isTitle: false,
  multiple: false,
  options: null,
  revision: 1,
  ...over,
});
const title = field({ id: 'field-1111111111111-aaaaaaaaa', name: 'name', isTitle: true });
const brief = field({
  id: 'field-1111111111111-bbbbbbbbb',
  name: 'brief',
  type: 'relation',
  referenceKind: 'doc',
});
const owners = field({
  id: 'field-1111111111111-ccccccccc',
  name: 'owners',
  type: 'relation',
  referenceKind: 'agent',
  multiple: true,
  nullable: false,
  defaultValue: [],
});
let rows: TableEntry[];

function drop(element: HTMLElement, value: NodeChipData) {
  const dataTransfer = {
    types: [NODE_CHIP_MIME],
    getData: (type: string) => (type === NODE_CHIP_MIME ? JSON.stringify(value) : ''),
    dropEffect: 'copy',
    files: [],
  };
  fireEvent.dragOver(element, { dataTransfer });
  return fireEvent.drop(element, { dataTransfer, clientX: 0, clientY: 0 });
}

function cell(fieldName: string): HTMLTableCellElement {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`);
  if (!row) throw new Error('Missing row');
  const button = within(row).getByRole('button', {
    name: new RegExp(`^Edit ${fieldName} in entry `),
  });
  const td = button.closest('td');
  if (!td) throw new Error('Missing cell');
  return td;
}

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});
beforeEach(() => {
  vi.resetAllMocks();
  __resetSnagletItemTitlesForTests();
  localStorage.clear();
  rows = [
    {
      id: entryId,
      createdAt: '2026-01-01T00:00:00.000000Z',
      revision: 'b'.repeat(64),
      values: {
        [title.id]: 'First',
        [brief.id]: ARCHIVED_DOC,
        [owners.id]: ['test-agent-a', PURGED_AGENT],
      },
    },
  ];
  api.searchEntries.mockResolvedValue({ results: [], hasMore: false });
  api.resolveEntries.mockResolvedValue({ entries: [] });
  api.fields.mockResolvedValue({ fields: [title, brief, owners] });
  api.entries.mockImplementation((_id, query) =>
    Promise.resolve({
      entries: [...rows],
      fields: [title, brief, owners],
      totalCount: rows.length,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 25,
      schemaVersion,
      relatedEntries: {},
      relatedItems: {
        doc: {
          [DOC]: { title: 'Launch brief', archived: false },
          [ARCHIVED_DOC]: { title: 'Old brief', archived: true },
          [NEW_DOC]: { title: 'Fresh doc', archived: false },
        },
        agent: { 'test-agent-a': { title: 'Test Agent A', archived: false } },
      },
    })
  );
  api.updateEntry.mockImplementation((_id, id, input) => {
    const original = rows.find((row) => row.id === id);
    if (!original) throw new Error('Missing entry fixture');
    const entry = {
      ...original,
      revision: 'c'.repeat(64),
      values: { ...original.values, ...input.values },
    };
    rows = [entry];
    return Promise.resolve({ entry, schemaVersion, relatedEntries: {}, relatedItems: {} });
  });
});
afterEach(async () => {
  await act(async () => cleanup());
  setActiveDragChip(null);
  __resetSnagletItemTitlesForTests();
});

describe('TableEntriesGrid relations to Snaglet items', () => {
  it('shows item chips from relatedItems: archived muted, purged unavailable', async () => {
    render(<TableEntriesGrid tableId={tableId} columns={[]} fields={[title, brief, owners]} />);
    const archived = await screen.findByText('Old brief');
    expect(archived.closest('.md-chip')).toHaveClass('md-chip-archived');
    expect(archived.closest('.md-chip')).toHaveAttribute('title', 'This doc is archived');
    const ownerCell = within(cell('owners'));
    expect(ownerCell.getByText('Test Agent A')).toBeInTheDocument();
    expect(ownerCell.getByText('Unavailable').closest('.md-chip')).toHaveClass(
      'md-chip-unavailable'
    );
  });

  it('links a dropped doc chip and shows its title', async () => {
    render(<TableEntriesGrid tableId={tableId} columns={[]} fields={[title, brief, owners]} />);
    await screen.findByText('Old brief');
    drop(cell('brief'), { id: NEW_DOC, kind: 'doc', title: 'Fresh doc' });
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(
        tableId,
        entryId,
        expect.objectContaining({ values: { [brief.id]: NEW_DOC } })
      )
    );
    // The drop opens the cell's picker; its chip reads the item's title.
    expect(await screen.findByText('Fresh doc')).toBeInTheDocument();
  });

  it('refuses a chip of another kind with a reason and writes nothing', async () => {
    render(<TableEntriesGrid tableId={tableId} columns={[]} fields={[title, brief, owners]} />);
    await screen.findByText('Old brief');
    drop(cell('brief'), { id: 'thread-1111111111111-aaaaaaaaa', kind: 'thread', title: 'Chat' });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This field links to docs. Drop a doc here.'
    );
    expect(api.updateEntry).not.toHaveBeenCalled();
  });
});
