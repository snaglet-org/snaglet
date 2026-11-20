import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  updateEntry: vi.fn(),
  createEntry: vi.fn(),
  entry: vi.fn(),
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
    { name: 'created_at', dataType: 'timestamp with time zone', nullable: false, managed: true },
  ],
  rowCount: 1,
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
const priority: TableField = {
  ...status,
  id: 'field-1111111111111-priority',
  columnName: 'priority',
  name: 'Priority',
  position: 2,
  options: [
    { id: 'opt-low', label: 'Low', color: 'gray' },
    { id: 'opt-high', label: 'High', color: 'red' },
  ],
};
const entryId = '00000000-0000-4000-8000-000000000001';

function page(fields: TableField[]): TableEntriesResponse {
  return {
    entries: [
      {
        id: entryId,
        createdAt: '2026-01-01T00:00:00.000000Z',
        revision: 'rev-1',
        values: { [name.id]: 'Write release notes', [status.id]: 'Done', [priority.id]: 'High' },
      },
    ],
    fields,
    totalCount: 1,
    page: 1,
    pageSize: 25,
    schemaVersion: 'a'.repeat(64),
    relatedEntries: {},
    relatedItems: {},
  };
}

function prime(fields: TableField[]) {
  api.get.mockResolvedValue(detail);
  api.fields.mockResolvedValue({ fields });
  api.entries.mockResolvedValue(page(fields));
}

const viewSwitch = () => screen.getByRole('radiogroup', { name: 'Table view' });
const boardOption = () => within(viewSwitch()).getByRole('radio', { name: 'Board' });

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  __resetTableNameCacheForTests();
  __resetTableHistoryForTests();
  api.history.mockResolvedValue({ actor: null, steps: [], undo: null, redo: null, depth: 100 });
  api.list.mockResolvedValue({ tables: [table] });
});

afterEach(() => localStorage.clear());

describe('TableView Grid | Board switch', () => {
  it('disables Board, with a hint, while the table has no select field', async () => {
    prime([name]);
    render(<TableView tableId={tableId} initial={table} />);
    await waitFor(() => expect(boardOption()).toBeDisabled());
    expect(boardOption()).toHaveAttribute('title', 'Add a select field to use Board');
    expect(screen.getByRole('note')).toHaveTextContent('Add a select field to use Board');
    expect(within(viewSwitch()).getByRole('radio', { name: 'Grid' })).toBeChecked();
    expect(document.querySelector('[data-table-entries-grid]')).not.toBeNull();
  });

  it('switches to the Board grouped by the only select field and remembers it per table', async () => {
    prime([name, status]);
    render(<TableView tableId={tableId} initial={table} />);
    await waitFor(() => expect(boardOption()).toBeEnabled());
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await userEvent.click(boardOption());
    expect(await screen.findByRole('region', { name: 'Done (1)' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'To do (0)' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'No Status (0)' })).toBeVisible();
    expect(document.querySelector('[data-table-entries-grid]')).toBeNull();
    // One select field: no "Group by" picker.
    expect(screen.queryByRole('combobox', { name: 'Group by' })).not.toBeInTheDocument();
    expect(localStorage.getItem(`snaglet.database.table.view:${tableId}`)).toBe('board');

    await userEvent.click(within(viewSwitch()).getByRole('radio', { name: 'Grid' }));
    await waitFor(() => expect(document.querySelector('[data-table-entries-grid]')).not.toBeNull());
    expect(localStorage.getItem(`snaglet.database.table.view:${tableId}`)).toBeNull();
  });

  it('opens in Board when that is remembered, and offers a Group by picker for several selects', async () => {
    localStorage.setItem(`snaglet.database.table.view:${tableId}`, 'board');
    localStorage.setItem(`snaglet.database.table.boardField:${tableId}`, priority.id);
    prime([name, status, priority]);
    render(<TableView tableId={tableId} initial={table} />);
    expect(await screen.findByRole('region', { name: 'High (1)' })).toBeVisible();
    expect(boardOption()).toBeChecked();
    const picker = screen.getByRole('combobox', { name: 'Group by' });
    expect(picker).toHaveValue(priority.id);
    await userEvent.selectOptions(picker, status.id);
    expect(await screen.findByRole('region', { name: 'Done (1)' })).toBeVisible();
    expect(localStorage.getItem(`snaglet.database.table.boardField:${tableId}`)).toBe(status.id);
  });

  it('opens a card in the entry modal inside the pane and keeps the Board', async () => {
    localStorage.setItem(`snaglet.database.table.view:${tableId}`, 'board');
    prime([name, status]);
    const loaded = page([name, status]);
    api.entry.mockResolvedValue({
      entry: loaded.entries[0],
      schemaVersion: loaded.schemaVersion,
      relatedEntries: {},
      relatedItems: {},
    });
    render(<TableView tableId={tableId} initial={table} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open Write release notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Write release notes' });
    expect(dialog.closest('[data-table-entry-modal]')).not.toBeNull();
    expect(await within(dialog).findByText('Status')).toBeVisible();
    expect(api.entry).toHaveBeenCalledWith(tableId, entryId);
    expect(within(viewSwitch()).getByRole('radio', { name: 'Board' })).toBeChecked();
    expect(localStorage.getItem(`snaglet.database.table.view:${tableId}`)).toBe('board');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close entry' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens straight into an entry window when the pane is opened on one, keeping the Board', async () => {
    localStorage.setItem(`snaglet.database.table.view:${tableId}`, 'board');
    prime([name, status]);
    const loaded = page([name, status]);
    api.entry.mockResolvedValue({
      entry: loaded.entries[0],
      schemaVersion: loaded.schemaVersion,
      relatedEntries: {},
      relatedItems: {},
    });
    render(
      <TableView tableId={tableId} initial={table} openEntryId={entryId} focusRequestId={1} />
    );
    const dialog = await screen.findByRole('dialog', { name: 'Write release notes' });
    expect(dialog.closest('[data-table-entry-modal]')).not.toBeNull();
    expect(api.entry).toHaveBeenCalledWith(tableId, entryId);
    // A window, not a grid seek: the remembered Board stays.
    expect(within(viewSwitch()).getByRole('radio', { name: 'Board' })).toBeChecked();
  });
});
