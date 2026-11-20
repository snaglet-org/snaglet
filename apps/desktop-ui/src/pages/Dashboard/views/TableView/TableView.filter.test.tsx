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
import { readTableFilter, writeTableFilter } from './boardViewPreference';

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
const statusFunnel = () =>
  statusHeader().querySelector<HTMLButtonElement>('[data-filter-toggle]') as HTMLButtonElement;
const lastWhere = () => api.entries.mock.lastCall?.[1]?.where;

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

describe('TableView header filter', () => {
  it('writes the same remembered filter the Filter control and filter bar show', async () => {
    render(<TableView tableId={tableId} initial={table} />);
    await waitFor(() => expect(statusFunnel()).not.toBeNull());
    expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument();

    fireEvent.click(statusFunnel());
    const panel = await screen.findByRole('dialog', { name: 'Filter Status' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));

    const expected = [{ fieldId: status.id, operator: 'is', value: 'Done' }];
    expect(readTableFilter(tableId, 'grid')).toEqual(expected);
    expect(readTableFilter(tableId, 'board')).toEqual([]);
    const bar = await screen.findByRole('list', { name: 'Active filters' });
    expect(within(bar).getByText('Status')).toBeInTheDocument();
    await waitFor(() => expect(lastWhere()).toEqual(expected));
    expect(screen.getByRole('button', { name: 'Filter · 1' })).toBeInTheDocument();

    // The Filter control lists it; changing it there shows on the header.
    fireEvent.click(screen.getByRole('button', { name: 'Filter · 1' }));
    const control = await screen.findByRole('dialog', { name: 'Filter entries' });
    const value = within(control).getByRole('combobox', { name: 'Filter 1 value' });
    expect(value).toHaveValue('Done');
    fireEvent.change(value, { target: { value: 'To do' } });
    await waitFor(() =>
      expect(statusFunnel()).toHaveAccessibleName('Status filter: is To do. Change filter')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter · 1' }));

    // Clearing from the header clears it everywhere.
    fireEvent.click(within(statusHeader()).getByRole('button', { name: 'Clear Status filter' }));
    expect(readTableFilter(tableId, 'grid')).toEqual([]);
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument()
    );
    expect(statusFunnel()).not.toHaveAttribute('data-active');
    await waitFor(() => expect(lastWhere() ?? []).toEqual([]));
  });

  it('opens with a stored filter shown on its header, and clearing it keeps the others', async () => {
    writeTableFilter(tableId, 'grid', [
      { fieldId: name.id, operator: 'contains', value: 'plan' },
      { fieldId: status.id, operator: 'is_empty' },
    ]);
    render(<TableView tableId={tableId} initial={table} />);
    await waitFor(() => expect(statusFunnel()).toHaveAttribute('data-active', 'true'));
    expect(statusFunnel()).toHaveAccessibleName('Status filter: is empty. Change filter');
    fireEvent.click(within(statusHeader()).getByRole('button', { name: 'Clear Status filter' }));
    expect(readTableFilter(tableId, 'grid')).toEqual([
      { fieldId: name.id, operator: 'contains', value: 'plan' },
    ]);
  });
});
