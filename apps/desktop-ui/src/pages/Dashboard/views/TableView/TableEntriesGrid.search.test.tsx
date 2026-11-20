import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableEntryRequest,
  TableEntriesQuery,
  TableEntriesResponse,
  TableEntry,
  TableField,
  UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database';
import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import { __resetEntryNameCacheForTests } from '@desktop/features/table-entries/entryNameCache';
import { TableEntriesGrid } from './TableEntriesGrid';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({ value, onChange, ariaLabel, onSubmit }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSubmit?.();
        }
      }}
    />
  ),
}));
vi.mock('@desktop/features/rich-markdown/renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));

const api = vi.hoisted(() => ({
  entries: vi.fn<(tableId: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
  entry: vi.fn(),
  fields: vi.fn(),
  createEntry: vi.fn<(tableId: string, input: CreateTableEntryRequest) => Promise<unknown>>(),
  updateEntry:
    vi.fn<(tableId: string, entryId: string, input: UpdateTableEntryRequest) => Promise<unknown>>(),
  reorderFields: vi.fn(),
  setFieldView: vi.fn(),
  deleteEntries: vi.fn(),
  searchEntries: vi.fn(),
  resolveEntries: vi.fn(),
}));
vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const schemaVersion = 'a'.repeat(64);
const name: TableField = {
  range: false,
  id: 'field-1111111111111-aaaaaaaaa',
  tableId,
  name: 'name',
  columnName: 'name',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: '',
  referenceTableId: null,
  referenceKind: null,
  revision: 1,
  managed: false,
  position: 0,
  collapsed: false,
  isTitle: true,
  multiple: false,
  options: null,
};
const amount: TableField = {
  ...name,
  id: 'field-1111111111111-bbbbbbbbb',
  name: 'amount',
  columnName: 'amount',
  type: 'number',
  nullable: true,
  defaultValue: null,
  position: 1,
  isTitle: false,
};
const fields = [name, amount];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function entry(n: number, title: string, value: string | null = null): TableEntry {
  return {
    id: id(n),
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: 'b'.repeat(64),
    values: { [name.id]: title, [amount.id]: value },
  };
}
let rows: TableEntry[];

/** A server that filters by substring of any value and numbers rows like the real one. */
function response(query: TableEntriesQuery): TableEntriesResponse {
  const pageSize = query.pageSize ?? 25;
  const page = query.page ?? 1;
  const q = query.q?.toLowerCase();
  const numbered = rows.map((row, index) => ({ row, number: index + 1 }));
  const matching = query.where?.length
    ? []
    : q
      ? numbered.filter(
          ({ row }) =>
            query.keep?.includes(row.id) ||
            Object.values(row.values).some((value) =>
              String(value ?? '')
                .toLowerCase()
                .includes(q)
            )
        )
      : numbered;
  const listed = matching.slice((page - 1) * pageSize, page * pageSize);
  return {
    entries: listed.map(({ row }) => row),
    fields,
    totalCount: matching.length,
    page,
    pageSize,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
    ...((q || query.where?.length) && {
      rowNumbers: Object.fromEntries(listed.map(({ row, number }) => [row.id, number])),
    }),
  };
}

function grid(): ReactNode {
  return <TableEntriesGrid tableId={tableId} columns={[]} fields={fields} />;
}
function setup(wrap: (children: ReactNode) => ReactNode = (children) => children) {
  return render(<>{wrap(grid())}</>);
}
const inPane = (children: ReactNode) => <PaneFindProvider isActive>{children}</PaneFindProvider>;
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
}
function searchBox(): HTMLInputElement {
  return screen.getByRole('searchbox', { name: 'Search entries' });
}
function listedIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('tr[data-entry-id]')).map(
    (row) => row.dataset.entryId ?? ''
  );
}
function lastQuery(): TableEntriesQuery | undefined {
  return api.entries.mock.lastCall?.[1];
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetEntryNameCacheForTests();
  localStorage.clear();
  rows = [
    entry(1, 'Alpha one'),
    entry(2, ''),
    entry(3, 'Beta'),
    entry(4, 'Alpha two'),
    entry(5, '', '55'),
  ];
  api.entries.mockImplementation((_id, query) => Promise.resolve(response(query)));
  api.createEntry.mockImplementation((_id, input) => {
    const saved = { ...entry(6, ''), id: input.id };
    saved.values = { ...saved.values, ...input.values };
    rows.push(saved);
    return Promise.resolve({ entry: saved, schemaVersion, relatedEntries: {}, relatedItems: {} });
  });
  api.updateEntry.mockImplementation((_id, entryId, input) => {
    const index = rows.findIndex((row) => row.id === entryId);
    const current = rows[index];
    if (!current) throw new Error('Missing fixture');
    const saved = { ...current, values: { ...current.values, ...input.values } };
    rows[index] = saved;
    return Promise.resolve({ entry: saved, schemaVersion, relatedEntries: {}, relatedItems: {} });
  });
  api.fields.mockResolvedValue({ fields });
});

describe('TableEntriesGrid search', () => {
  it('searches once typing pauses, from the first page, and counts the matches', async () => {
    setup();
    await ready();
    api.entries.mockClear();
    fireEvent.change(searchBox(), { target: { value: 'a' } });
    fireEvent.change(searchBox(), { target: { value: 'al' } });
    fireEvent.change(searchBox(), { target: { value: ' alpha ' } });
    expect(api.entries).not.toHaveBeenCalled();
    await waitFor(() => expect(listedIds()).toEqual([id(1), id(4)]));
    expect(api.entries).toHaveBeenCalledTimes(1);
    expect(lastQuery()).toEqual({ page: 1, pageSize: 25, q: 'alpha' });
    expect(screen.getByText('2 matching')).toBeInTheDocument();
  });

  it('keeps "Untitled N" as the row number in the whole table while filtered', async () => {
    setup();
    await ready();
    expect(screen.getByRole('checkbox', { name: 'Select entry Untitled 5' })).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: '55' } });
    await waitFor(() => expect(listedIds()).toEqual([id(5)]));
    expect(screen.getByRole('checkbox', { name: 'Select entry Untitled 5' })).toBeInTheDocument();
    expect(screen.queryByText('Untitled 1')).not.toBeInTheDocument();
  });

  it('clears with × or Escape, and a second Escape leaves the box', async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    await user.type(searchBox(), 'beta');
    await waitFor(() => expect(listedIds()).toEqual([id(3)]));

    const toolbar = screen.getByRole('toolbar', { name: 'Table actions' });
    await user.click(within(toolbar).getByRole('button', { name: 'Clear search' }));
    expect(searchBox()).toHaveValue('');
    expect(searchBox()).toHaveFocus();
    await waitFor(() => expect(listedIds()).toHaveLength(5));
    expect(lastQuery()).toEqual({ page: 1, pageSize: 25 });

    await user.type(searchBox(), 'beta');
    await waitFor(() => expect(listedIds()).toEqual([id(3)]));
    await user.keyboard('{Escape}');
    expect(searchBox()).toHaveValue('');
    expect(searchBox()).toHaveFocus();
    await waitFor(() => expect(listedIds()).toHaveLength(5));

    await user.keyboard('{Escape}');
    expect(searchBox()).not.toHaveFocus();
  });

  it('shows "No entries match" with a Clear search action instead of the blank row', async () => {
    const user = userEvent.setup();
    setup();
    await ready();
    expect(screen.getByRole('button', { name: 'Insert a row at end' })).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    const empty = await screen.findByText('No entries match “zzz”.');
    expect(listedIds()).toEqual([]);
    expect(screen.queryByRole('button', { name: /Insert (a row at end|first row)/ })).toBeNull();
    await user.click(
      within(empty.parentElement as HTMLElement).getByRole('button', { name: 'Clear search' })
    );
    expect(searchBox()).toHaveValue('');
    await waitFor(() => expect(listedIds()).toHaveLength(5));
    expect(screen.queryByText(/No entries match/)).not.toBeInTheDocument();
  });

  it('says the filters, not a search, hid every entry, and offers to clear them', async () => {
    const onFilterChange = vi.fn();
    const where = [{ fieldId: amount.id, operator: 'gt' as const, value: '100' }];
    render(
      <TableEntriesGrid
        tableId={tableId}
        columns={[]}
        fields={fields}
        where={where}
        viewFilter={where}
        onFilterChange={onFilterChange}
      />
    );
    const empty = await screen.findByText('No entries match the filters.');
    expect(screen.queryByText(/No entries match “/)).toBeNull();
    expect(
      within(empty.parentElement as HTMLElement).queryByRole('button', { name: 'Clear search' })
    ).toBeNull();
    fireEvent.click(
      within(empty.parentElement as HTMLElement).getByRole('button', { name: 'Clear filters' })
    );
    expect(onFilterChange).toHaveBeenCalledWith([]);
  });

  it('keeps a row created while searching listed until the search changes', async () => {
    setup();
    await ready();
    fireEvent.change(searchBox(), { target: { value: 'alpha' } });
    await waitFor(() => expect(listedIds()).toEqual([id(1), id(4)]));
    await userEvent.click(screen.getByRole('button', { name: 'Insert a row at end' }));
    const input = screen.getByRole('textbox', { name: 'name' });
    fireEvent.change(input, { target: { value: 'Gamma' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.createEntry).toHaveBeenCalledOnce());
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'name' })).not.toBeInTheDocument();
    const created = api.createEntry.mock.calls[0]?.[1].id ?? '';
    act(() => emitTableEvent({ type: 'table.entries.changed', tableId, entryId: created }));
    await waitFor(() =>
      expect(lastQuery()).toEqual({ page: 1, pageSize: 25, q: 'alpha', keep: [created] })
    );
    await waitFor(() => expect(listedIds()).toEqual([id(1), id(4), created]));
    expect(screen.getByText('3 matching')).toBeInTheDocument();

    fireEvent.change(searchBox(), { target: { value: 'alph' } });
    await waitFor(() => expect(listedIds()).toEqual([id(1), id(4)]));
    expect(lastQuery()).toEqual({ page: 1, pageSize: 25, q: 'alph' });
  });

  it('focuses the search on Cmd/Ctrl+F in its pane', async () => {
    setup(inPane);
    await ready();
    fireEvent.change(searchBox(), { target: { value: 'beta' } });
    searchBox().blur();
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(searchBox()).toHaveFocus();
    expect(searchBox().selectionStart).toBe(0);
    expect(searchBox().selectionEnd).toBe(4);
    searchBox().blur();
    fireEvent.keyDown(window, { key: 'F', ctrlKey: true });
    expect(searchBox()).toHaveFocus();
  });

  it('remembers the search while its pane stays open', async () => {
    const view = setup(inPane);
    await ready();
    fireEvent.change(searchBox(), { target: { value: 'beta' } });
    await waitFor(() => expect(listedIds()).toEqual([id(3)]));
    view.rerender(<>{inPane(<p>Another view</p>)}</>);
    api.entries.mockClear();
    view.rerender(<>{inPane(grid())}</>);
    expect(searchBox()).toHaveValue('beta');
    await waitFor(() => expect(listedIds()).toEqual([id(3)]));
    expect(api.entries.mock.calls.map(([, query]) => query.q)).toEqual(['beta']);
  });
});
