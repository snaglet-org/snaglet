import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableCatalogEntry,
  TableDetailResponse,
  TableEntriesResponse,
  TableField,
} from '@snaglet/shared/types';
import { __resetTableNameCacheForTests } from '@desktop/features/database/tableNameCache';
import { __resetTableHistoryForTests } from '@desktop/features/database/tableHistory';
import { TableView } from './TableView';
import { readTableSort, writeTableSort } from './boardViewPreference';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: () => <textarea aria-label="cell" />,
}));

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  fields: vi.fn(),
  entries: vi.fn(),
  history: vi.fn(),
  stepHistory: vi.fn(),
}));

vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, FetchError: core.FetchError };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const table: TableCatalogEntry = {
  id: tableId,
  name: 'tasks',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const detail: TableDetailResponse = {
  table,
  columns: [
    { name: 'id', dataType: 'text', nullable: false, managed: true },
    { name: 'name', dataType: 'text', nullable: false, managed: false },
    { name: 'status', dataType: 'select', nullable: true, managed: false },
  ],
  rowCount: 0,
};
const name: TableField = {
  range: false,
  id: 'field-1111111111111-name',
  tableId,
  columnName: 'name',
  name: 'Name',
  description: null,
  type: 'text',
  nullable: false,
  defaultValue: '',
  referenceTableId: null,
  referenceKind: null,
  options: null,
  multiple: false,
  position: 0,
  managed: false,
  collapsed: false,
  isTitle: true,
  revision: 1,
};
const status: TableField = {
  ...name,
  id: 'field-1111111111111-status',
  columnName: 'status',
  name: 'Status',
  type: 'select',
  nullable: true,
  defaultValue: null,
  isTitle: false,
  position: 1,
  options: [
    { id: 'opt-todo', label: 'To do', color: 'gray' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
};
const fields = [name, status];
const page: TableEntriesResponse = {
  entries: [],
  fields,
  totalCount: 0,
  page: 1,
  pageSize: 25,
  schemaVersion: 'a'.repeat(64),
  relatedEntries: {},
  relatedItems: {},
};

const statusHeader = () => screen.getByRole('columnheader', { name: 'Status' });
const statusToggle = () =>
  statusHeader().querySelector<HTMLButtonElement>('[data-sort-toggle]') as HTMLButtonElement;
const lastSortQuery = () => api.entries.mock.lastCall?.[1]?.sort;

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  __resetTableNameCacheForTests();
  __resetTableHistoryForTests();
  api.history.mockResolvedValue({ actor: null, steps: [], undo: null, redo: null, depth: 100 });
  api.list.mockResolvedValue({ tables: [table] });
  api.get.mockResolvedValue(detail);
  api.fields.mockResolvedValue({ fields });
  api.entries.mockResolvedValue(page);
});

afterEach(() => localStorage.clear());

describe('TableView header sort toggle', () => {
  it('drives the same remembered sort as the Sort control and sort bar', async () => {
    render(<TableView tableId={tableId} initial={table} />);
    await waitFor(() => expect(statusToggle()).not.toBeNull());
    expect(screen.queryByRole('list', { name: 'Active sorts' })).not.toBeInTheDocument();

    fireEvent.click(statusToggle());
    expect(readTableSort(tableId, 'grid')).toEqual([{ fieldId: status.id, direction: 'asc' }]);
    const bar = await screen.findByRole('list', { name: 'Active sorts' });
    expect(within(bar).getByText('Option order')).toBeInTheDocument();
    await waitFor(() =>
      expect(lastSortQuery()).toEqual([{ fieldId: status.id, direction: 'asc' }])
    );
    // The Sort control lists the same level.
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    const panel = await screen.findByRole('dialog', { name: 'Sort entries' });
    expect(within(panel).getByRole('combobox', { name: 'Sort 1 field' })).toHaveValue(status.id);
    expect(within(panel).getByRole('combobox', { name: 'Sort 1 direction' })).toHaveValue('asc');
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));

    // Reversing from the sort bar shows on the header toggle.
    fireEvent.click(within(bar).getByRole('button', { name: 'Status, Option order. Reverse' }));
    await waitFor(() => expect(statusToggle()).toHaveAccessibleName(/sorted Reverse order/));
    expect(readTableSort(tableId, 'grid')).toEqual([{ fieldId: status.id, direction: 'desc' }]);

    // The third step clears it everywhere.
    fireEvent.click(statusToggle());
    expect(readTableSort(tableId, 'grid')).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Active sorts' })).not.toBeInTheDocument()
    );
    expect(statusToggle()).not.toHaveAttribute('data-active');
  });

  it('opens with the stored sort shown on the headers and Shift-adds a level to it', async () => {
    writeTableSort(tableId, 'grid', [{ fieldId: name.id, direction: 'desc' }]);
    render(<TableView tableId={tableId} initial={table} />);
    const nameToggle = await waitFor(() => {
      const toggle = screen
        .getByRole('columnheader', { name: 'Name' })
        .querySelector<HTMLButtonElement>('[data-sort-toggle]');
      expect(toggle).toHaveAttribute('data-active', 'true');
      return toggle as HTMLButtonElement;
    });
    expect(nameToggle).toHaveAccessibleName('Name sorted Z → A. Clear sort');

    fireEvent.click(statusToggle(), { shiftKey: true });
    expect(readTableSort(tableId, 'grid')).toEqual([
      { fieldId: name.id, direction: 'desc' },
      { fieldId: status.id, direction: 'asc' },
    ]);
    await waitFor(() => expect(statusToggle()).toHaveTextContent('2'));
    expect(nameToggle).toHaveTextContent('1');
    // The Board keeps its own sort.
    expect(readTableSort(tableId, 'board')).toEqual([]);
  });
});
