import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TableEntriesQuery,
  TableEntriesResponse,
  TableEntry,
  TableEntryResponse,
  TableField,
  UpdateTableEntryRequest,
} from '@snaglet/shared/types';
import { TableEntriesGrid } from './TableEntriesGrid';

const api = vi.hoisted(() => ({
  entries: vi.fn<(id: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
  entry: vi.fn<(id: string, entryId: string) => Promise<TableEntryResponse>>(),
  fields: vi.fn(),
  updateEntry:
    vi.fn<
      (id: string, entryId: string, request: UpdateTableEntryRequest) => Promise<TableEntryResponse>
    >(),
}));
vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, ...api },
    agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) },
  };
});
vi.mock('@desktop/utils/api/tableRepeats', () => ({
  tableRepeatsApi: { list: vi.fn(async () => ({ rows: [] })) },
}));
const toast = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./repeatAdvanceToast', () => ({ noteRepeatAdvance: toast }));

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = '00000000-0000-4000-8000-000000000001';
const schemaVersion = 'a'.repeat(64);
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
const due: TableField = {
  ...name,
  id: 'field-1111111111111-due',
  columnName: 'due',
  name: 'Due',
  type: 'date',
  nullable: true,
  defaultValue: null,
  isTitle: false,
  position: 2,
  recurrence: {
    statusFieldId: status.id,
    doneOptionIds: ['opt-done'],
    resetOptionId: 'opt-todo',
  },
};
const fields = [name, status, due];
let saved: TableEntry;

const response = (): TableEntryResponse => ({
  entry: saved,
  schemaVersion,
  relatedEntries: {},
  relatedItems: {},
});
const row = () => document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)!;
const statusCell = () =>
  within(row()).getByRole('button', { name: 'Edit Status in entry Pay rent' });
const dueShown = () => row().querySelector('time')?.getAttribute('datetime');

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  saved = {
    id: entryId,
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: 'b'.repeat(64),
    values: { [name.id]: 'Pay rent', [status.id]: 'To do', [due.id]: '2026-10-05' },
  };
  api.entries.mockImplementation(async (_id, query) => ({
    entries: [saved],
    fields,
    totalCount: 1,
    page: 1,
    pageSize: query.pageSize ?? 25,
    schemaVersion,
    relatedEntries: {},
    relatedItems: {},
  }));
  api.entry.mockImplementation(async () => response());
  api.fields.mockImplementation(async () => ({ fields }));
  // The server's done-advance: Done moves Due one week on and resets Status.
  api.updateEntry.mockImplementation(async (_id, _entryId, request) => {
    const done = request.values[status.id] === 'Done';
    saved = {
      ...saved,
      revision: 'c'.repeat(64),
      values: {
        ...saved.values,
        ...request.values,
        ...(done ? { [status.id]: 'To do', [due.id]: '2026-10-12' } : {}),
      },
    };
    return response();
  });
});

afterEach(async () => {
  await act(async () => cleanup());
  vi.restoreAllMocks();
});

describe('TableEntriesGrid: a repeating row set to Done', () => {
  it('shows the advanced date and the reset status as soon as the save returns', async () => {
    render(<TableEntriesGrid tableId={tableId} columns={[]} fields={fields} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(dueShown()).toBe('2026-10-05');
    // Any reload from here never answers: what shows comes from the save's response.
    api.entries.mockImplementation(() => new Promise(() => undefined));
    api.entry.mockImplementation(() => new Promise(() => undefined));
    await userEvent.click(statusCell());
    await userEvent.click(await screen.findByRole('option', { name: 'Done' }));
    await waitFor(() => expect(api.updateEntry).toHaveBeenCalledTimes(1));
    expect(api.updateEntry.mock.calls[0]![2].values).toEqual({ [status.id]: 'Done' });
    await waitFor(() => expect(dueShown()).toBe('2026-10-12'));
    expect(statusCell()).toHaveTextContent('To do');
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { [status.id]: 'Done' }, after: saved })
    );
    expect(api.updateEntry).toHaveBeenCalledTimes(1);
  });
});
