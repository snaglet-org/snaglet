import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableEntryRequest,
  TableDetailResponse,
  TableEntriesQuery,
  TableEntriesResponse,
  TableEntry,
  TableEntryResponse,
  TableField,
  TableFieldResponse,
  UpdateTableEntryRequest,
  UpdateTableFieldRequest,
} from '@snaglet/shared/types';
import { emitTableEvent, subscribeTableEvents } from '@desktop/features/database';
import { FetchError } from '@desktop/utils/api';
import { NODE_CHIP_MIME, setActiveDragChip } from '@desktop/utils/nodeChip';
import { CustomTableFields } from './CustomTableFields';
import { TableEntriesGrid } from './TableEntriesGrid';

const api = vi.hoisted(() => ({
  get: vi.fn<(id: string) => Promise<TableDetailResponse>>(),
  entries: vi.fn<(id: string, query: TableEntriesQuery) => Promise<TableEntriesResponse>>(),
  entry: vi.fn<(id: string, entryId: string) => Promise<TableEntryResponse>>(),
  fields: vi.fn(),
  updateField:
    vi.fn<
      (id: string, fieldId: string, request: UpdateTableFieldRequest) => Promise<TableFieldResponse>
    >(),
  updateEntry:
    vi.fn<
      (id: string, entryId: string, request: UpdateTableEntryRequest) => Promise<TableEntryResponse>
    >(),
  createEntry:
    vi.fn<(id: string, request: CreateTableEntryRequest) => Promise<TableEntryResponse>>(),
}));
vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, ...api },
    agentsApi: { ...actual.agentsApi, list: vi.fn(async () => []) },
  };
});

const tableId = 'table-1111111111111-aaaaaaaaa';
const entryId = '00000000-0000-4000-8000-000000000001';
const originalSchema = 'a'.repeat(64);
const changedSchema = 'c'.repeat(64);
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
    { id: 'opt-progress', label: 'In progress', color: 'blue' },
    { id: 'opt-done', label: 'Done', color: 'green' },
  ],
};
let fields: TableField[];
let saved: TableEntry;
let schemaVersion: string;
let operations: string[];
let writes: number;
let createdRows: TableEntry[];

function response(): TableEntryResponse {
  return { entry: saved, schemaVersion, relatedEntries: {}, relatedItems: {} };
}
function cell() {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`);
  if (!row) throw new Error('Missing fixture row');
  return within(row).getByRole('button', { name: 'Edit Status in entry Test entry' });
}
function setup() {
  const paneDrop = vi.fn();
  const view = render(
    <div onDrop={paneDrop}>
      <TableEntriesGrid tableId={tableId} columns={[]} fields={fields} />
    </div>
  );
  return { paneDrop, ...view };
}
async function openCell() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  await userEvent.click(cell());
  return screen.findByRole('combobox', { name: 'Find Status' });
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  fields = [name, status];
  saved = {
    id: entryId,
    createdAt: '2026-01-01T00:00:00.000000Z',
    revision: 'b'.repeat(64),
    values: { [name.id]: 'Test entry', [status.id]: null },
  };
  schemaVersion = originalSchema;
  operations = [];
  writes = 0;
  createdRows = [];
  api.entries.mockImplementation(async (_id, query) => {
    operations.push(query.pageSize === 1 ? 'read schema' : 'read page');
    return {
      entries: [saved, ...createdRows],
      fields,
      totalCount: 1 + createdRows.length,
      page: 1,
      pageSize: query.pageSize ?? 25,
      schemaVersion,
      relatedEntries: {},
      relatedItems: {},
    };
  });
  api.entry.mockImplementation(async (_id, entryId) => {
    operations.push('read entry');
    if (entryId !== saved.id) {
      const entry = createdRows.find((row) => row.id === entryId);
      if (!entry) throw new FetchError('Entry not found', 404);
      return { entry, schemaVersion, relatedEntries: {}, relatedItems: {} };
    }
    return response();
  });
  api.fields.mockImplementation(async () => {
    operations.push('read fields');
    return { fields };
  });
  api.updateField.mockImplementation(async (_id, fieldId, request) => {
    operations.push('patch field');
    const current = fields.find((field) => field.id === fieldId);
    if (!current) throw new FetchError('Field not found', 404);
    if (request.expectedRevision !== current.revision)
      throw new FetchError('Field changed elsewhere', 409);
    const next: TableField = {
      ...current,
      revision: current.revision + 1,
      options:
        request.options?.map((option) => ({
          id: option.id ?? 'opt-created',
          label: option.label,
          color: option.color ?? 'purple',
        })) ?? null,
    };
    fields = fields.map((field) => (field.id === fieldId ? next : field));
    schemaVersion = changedSchema;
    saved = { ...saved, revision: 'd'.repeat(64) };
    return { field: next };
  });
  api.updateEntry.mockImplementation(async (_id, _entryId, request) => {
    operations.push('patch entry');
    if (request.schemaVersion !== schemaVersion)
      throw new FetchError('Schema changed elsewhere', 409);
    if (request.expectedRevision !== saved.revision)
      throw new FetchError('Entry changed elsewhere', 409);
    writes += 1;
    saved = {
      ...saved,
      revision: (100 + writes).toString(16).padStart(64, '0'),
      values: { ...saved.values, ...request.values },
    };
    return response();
  });
  api.createEntry.mockImplementation(async (_id, request) => {
    operations.push('create entry');
    if (request.schemaVersion !== schemaVersion)
      throw new FetchError('Schema changed elsewhere', 409);
    const entry: TableEntry = {
      id: request.id,
      createdAt: '2026-01-01T00:00:00.000000Z',
      revision: 'e'.repeat(64),
      values: request.values,
    };
    createdRows.push(entry);
    return { entry, schemaVersion, relatedEntries: {}, relatedItems: {} };
  });
});

afterEach(async () => {
  await act(async () => cleanup());
  setActiveDragChip(null);
  vi.restoreAllMocks();
});

describe('TableEntriesGrid with the real Select picker', () => {
  it('autosaves an exact single option label, closes the cell and returns focus', async () => {
    setup();
    await openCell();
    await userEvent.click(screen.getByRole('option', { name: 'In progress' }));
    await waitFor(() =>
      expect(api.updateEntry, operations.join(' → ')).toHaveBeenCalledWith(tableId, entryId, {
        values: { [status.id]: 'In progress' },
        schemaVersion: originalSchema,
        expectedRevision: 'b'.repeat(64),
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Find Status' })).not.toBeInTheDocument()
    );
    expect(cell()).toHaveTextContent('In progress');
    expect(cell()).toHaveFocus();
    expect(api.updateField).not.toHaveBeenCalled();
  });

  it('autosaves ordered multi-select choices while keeping the picker open until Tab', async () => {
    fields = [name, { ...status, multiple: true, nullable: false, defaultValue: [] }];
    saved = { ...saved, values: { ...saved.values, [status.id]: [] } };
    setup();
    const input = await openCell();
    await userEvent.click(screen.getByRole('option', { name: 'Done' }));
    await userEvent.click(screen.getByRole('option', { name: 'To do' }));
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(
        tableId,
        entryId,
        expect.objectContaining({ values: { [status.id]: ['Done', 'To do'] } })
      )
    );
    expect(input).toBeInTheDocument();
    expect(saved.values[status.id]).toEqual(['Done', 'To do']);
    await userEvent.tab();
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Find Status' })).not.toBeInTheDocument()
    );
    expect(cell().textContent).toBe('DoneTo do');
  });

  it('creates the option, reloads schema and entry, then writes with the fresh schema and revision', async () => {
    setup();
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() =>
      expect(api.updateEntry, operations.join(' → ')).toHaveBeenCalledWith(tableId, entryId, {
        values: { [status.id]: 'Review' },
        schemaVersion: changedSchema,
        expectedRevision: 'd'.repeat(64),
      })
    );
    expect(api.updateField).toHaveBeenCalledWith(
      tableId,
      status.id,
      expect.objectContaining({
        expectedRevision: 1,
        options: [
          ...(status.options ?? []),
          { id: expect.stringMatching(/^opt-/), label: 'Review' },
        ],
      })
    );
    const fieldPatch = operations.indexOf('patch field');
    const schemaRead = operations.indexOf('read schema', fieldPatch);
    const entryRead = operations.indexOf('read entry', schemaRead);
    const entryPatch = operations.indexOf('patch entry', entryRead);
    expect(fieldPatch).toBeGreaterThan(-1);
    expect(schemaRead).toBeGreaterThan(fieldPatch);
    expect(entryRead).toBeGreaterThan(schemaRead);
    expect(entryPatch).toBeGreaterThan(entryRead);
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Find Status' })).not.toBeInTheDocument()
    );
    expect(cell()).toHaveTextContent('Review');
  });

  it('leaves the existing value untouched after option creation fails, then retries safely', async () => {
    saved = { ...saved, values: { ...saved.values, [status.id]: 'Done' } };
    api.updateField.mockRejectedValueOnce(new FetchError('Field changed elsewhere', 409));
    setup();
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((alert) => alert.textContent?.includes('Field changed elsewhere'))
      ).toBe(true)
    );
    expect(saved.values[status.id]).toBe('Done');
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(input).toHaveValue('Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() => expect(saved.values[status.id]).toBe('Review'));
    expect(api.updateField).toHaveBeenCalledTimes(2);
    expect(api.fields).toHaveBeenCalledTimes(2);
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });

  it('does not write a created option until the fresh entry revision finishes loading', async () => {
    let finishRead: (response: TableEntryResponse) => void = () => undefined;
    api.entry.mockImplementationOnce(async () => {
      operations.push('read entry');
      return new Promise<TableEntryResponse>((resolve) => {
        finishRead = resolve;
      });
    });
    setup();
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() => expect(api.entry).toHaveBeenCalledWith(tableId, entryId));
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('readonly');
    expect(saved.values[status.id]).toBeNull();
    await act(async () => finishRead(response()));
    await waitFor(() =>
      expect(api.updateEntry).toHaveBeenCalledWith(
        tableId,
        entryId,
        expect.objectContaining({
          schemaVersion: changedSchema,
          expectedRevision: 'd'.repeat(64),
          values: { [status.id]: 'Review' },
        })
      )
    );
  });

  it('never selects a newly created option after Escape cancels the pending cell', async () => {
    let finishRead: (response: TableEntryResponse) => void = () => undefined;
    api.entry.mockImplementationOnce(
      async () =>
        new Promise<TableEntryResponse>((resolve) => {
          finishRead = resolve;
        })
    );
    setup();
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() => expect(api.entry).toHaveBeenCalledWith(tableId, entryId));
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => finishRead(response()));
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Find Status' })).not.toBeInTheDocument()
    );
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(saved.values[status.id]).toBeNull();
    expect(
      fields
        .find((field) => field.id === status.id)
        ?.options?.some((option) => option.label === 'Review')
    ).toBe(true);
  });

  it('creates an option from a required ghost Select before creating that row exactly once', async () => {
    fields = [name, { ...status, nullable: false }];
    saved = { ...saved, values: { ...saved.values, [status.id]: 'To do' } };
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'New entry: Status' }));
    const input = await screen.findByRole('combobox', { name: 'Find Status' });
    expect(api.createEntry).not.toHaveBeenCalled();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() =>
      expect(api.createEntry).toHaveBeenCalledWith(
        tableId,
        expect.objectContaining({
          schemaVersion: changedSchema,
          values: { [name.id]: '', [status.id]: 'Review' },
        })
      )
    );
    expect(api.createEntry).toHaveBeenCalledOnce();
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(operations.indexOf('patch field')).toBeLessThan(operations.indexOf('create entry'));
    expect(operations.indexOf('read entry')).toBeLessThan(operations.indexOf('create entry'));
    expect(createdRows[0]?.values[status.id]).toBe('Review');
  });

  it('does not lose a ghost selection when the realtime page refresh is slower than the schema rebase', async () => {
    fields = [name, { ...status, nullable: false }];
    saved = { ...saved, values: { ...saved.values, [status.id]: 'To do' } };
    const read = api.entries.getMockImplementation();
    if (!read) throw new Error('Missing entries mock');
    const pendingReads: Array<() => void> = [];
    let allowPageRefresh = false;
    api.entries.mockImplementation(async (id, query) => {
      const result = await read(id, query);
      if (query.pageSize === 1 || result.schemaVersion === originalSchema || allowPageRefresh)
        return result;
      return new Promise<TableEntriesResponse>((resolve) =>
        pendingReads.push(() => resolve(result))
      );
    });
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'New entry: Status' }));
    const input = await screen.findByRole('combobox', { name: 'Find Status' });
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    try {
      await waitFor(() => expect(pendingReads.length).toBeGreaterThan(0));
      expect(api.createEntry).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('readonly');
      allowPageRefresh = true;
      await act(async () => {
        for (const release of pendingReads) release();
      });
      await waitFor(() =>
        expect(api.createEntry, operations.join(' → ')).toHaveBeenCalledWith(
          tableId,
          expect.objectContaining({
            schemaVersion: changedSchema,
            values: { [name.id]: '', [status.id]: 'Review' },
          })
        )
      );
      expect(api.createEntry).toHaveBeenCalledOnce();
      expect(api.updateEntry).not.toHaveBeenCalled();
    } finally {
      allowPageRefresh = true;
      await act(async () => {
        for (const release of pendingReads) release();
      });
    }
  });

  it('writes a created option even while a parent schema reload is still blocking the grid', async () => {
    /** Disables editing from the schema change until its own reload finishes (here: never). */
    function BlockingParent() {
      const [reloading, setReloading] = useState(false);
      useEffect(
        () =>
          subscribeTableEvents((event) => {
            if (event.type === 'table.fields.changed') setReloading(true);
          }),
        []
      );
      return (
        <TableEntriesGrid
          tableId={tableId}
          columns={[]}
          fields={fields}
          editingDisabled={reloading}
        />
      );
    }
    render(<BlockingParent />);
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() =>
      expect(api.updateEntry, operations.join(' → ')).toHaveBeenCalledWith(tableId, entryId, {
        values: { [status.id]: 'Review' },
        schemaVersion: changedSchema,
        expectedRevision: 'd'.repeat(64),
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Find Status' })).not.toBeInTheDocument()
    );
    expect(saved.values[status.id]).toBe('Review');
    expect(screen.queryByText('The option was not added. Try again.')).not.toBeInTheDocument();
  });

  it('adds a created option to a multi-select while a parent schema reload blocks the grid', async () => {
    fields = [name, { ...status, multiple: true, nullable: false, defaultValue: [] }];
    saved = { ...saved, values: { ...saved.values, [status.id]: ['Done'] } };
    function BlockingParent() {
      const [reloading, setReloading] = useState(false);
      useEffect(
        () =>
          subscribeTableEvents((event) => {
            if (event.type === 'table.fields.changed') setReloading(true);
          }),
        []
      );
      return (
        <TableEntriesGrid
          tableId={tableId}
          columns={[]}
          fields={fields}
          editingDisabled={reloading}
        />
      );
    }
    render(<BlockingParent />);
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() => expect(saved.values[status.id]).toEqual(['Done', 'Review']));
    expect(api.updateEntry).toHaveBeenCalledOnce();
  });

  it('keeps a created option when the fields panel is still reloading the changed schema', async () => {
    const detail: TableDetailResponse = {
      table: {
        id: tableId,
        name: 'Tasks',
        origin: 'custom',
        projectId: null,
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      columns: [
        { name: name.columnName, dataType: 'text', nullable: false, managed: false },
        { name: status.columnName, dataType: 'select', nullable: true, managed: false },
      ],
      rowCount: 1,
    };
    // The first detail read loads the panel; the one the option's schema change
    // starts never finishes, so the panel stays mid-reload throughout.
    api.get.mockResolvedValueOnce(detail).mockReturnValue(new Promise(() => undefined));
    render(<CustomTableFields detail={detail} />);
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() => expect(saved.values[status.id]).toBe('Review'));
    expect(api.get).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByRole('combobox', { name: 'Find Status' })).not.toBeInTheDocument()
    );
    expect(cell()).toHaveTextContent('Review');
  });

  it('accepts a newer realtime page when the server echo supersedes the barrier refresh', async () => {
    const read = api.entries.getMockImplementation();
    if (!read) throw new Error('Missing entries mock');
    // Hold the two page reads the option's schema change starts (the local event
    // reload and the grid's barrier refresh) so the server's echo finishes first.
    const held: Array<() => void> = [];
    api.entries.mockImplementation(async (id, query) => {
      const result = await read(id, query);
      if (query.pageSize === 1 || !operations.includes('patch field') || held.length >= 2)
        return result;
      return new Promise<TableEntriesResponse>((resolve) => held.push(() => resolve(result)));
    });
    setup();
    const input = await openCell();
    await userEvent.type(input, 'Review');
    await userEvent.click(screen.getByRole('option', { name: 'Create “Review”' }));
    await waitFor(() => expect(held).toHaveLength(2));
    const pageReads = operations.filter((operation) => operation === 'read page').length;
    act(() => emitTableEvent({ type: 'table.fields.changed', tableId }));
    await waitFor(() =>
      expect(operations.filter((operation) => operation === 'read page')).toHaveLength(
        pageReads + 1
      )
    );
    expect(api.updateEntry).not.toHaveBeenCalled();
    await act(async () => {
      for (const release of held) release();
    });
    await waitFor(() =>
      expect(api.updateEntry, operations.join(' → ')).toHaveBeenCalledWith(tableId, entryId, {
        values: { [status.id]: 'Review' },
        schemaVersion: changedSchema,
        expectedRevision: 'd'.repeat(64),
      })
    );
    expect(screen.queryByText('The option was not added. Try again.')).not.toBeInTheDocument();
  });

  it('rejects reference chips in closed cells and the open search without splitting a pane', async () => {
    const { paneDrop } = setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    const dataTransfer = {
      types: [NODE_CHIP_MIME],
      getData: () => JSON.stringify({ kind: 'table', id: tableId, title: 'Table reference' }),
      files: [],
      dropEffect: 'copy',
    };
    expect(fireEvent.drop(cell(), { dataTransfer })).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose an option for this Select cell.');
    const input = await openCell();
    expect(fireEvent.drop(input, { dataTransfer })).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose an option for this Select cell.');
    expect(paneDrop).not.toHaveBeenCalled();
    expect(api.updateEntry).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
  });
});
