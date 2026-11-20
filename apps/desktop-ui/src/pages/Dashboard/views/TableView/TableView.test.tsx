import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTableResponse,
  RenameTableResponse,
  TableCatalogEntry,
  TableDetailResponse,
} from '@snaglet/shared/types';
import { emitTableEvent, subscribeTableEvents, type TableEvent } from '@desktop/features/database';
import { __resetTableNameCacheForTests } from '@desktop/features/database/tableNameCache';
import { __resetTableHistoryForTests } from '@desktop/features/database/tableHistory';
import { __resetProjectListForTests } from '@desktop/features/database/projectList';
import { onArchivedDrawerRequest } from '../archivedDrawerRequest';
import { TableDraftView } from './TableDraftView';
import { TableView } from './TableView';

import type { ChipEditableInputProps } from '@desktop/features/rich-markdown/editor/ChipEditableInput';

vi.mock('@desktop/features/rich-markdown/editor', () => ({
  ChipEditableInput: ({
    value,
    onChange,
    ariaLabel,
    disabled,
    autoFocus,
    ariaInvalid,
    ariaDescribedBy,
    onSubmit,
  }: ChipEditableInputProps) => (
    <textarea
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      autoFocus={autoFocus}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onSubmit?.();
        }
      }}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  fields: vi.fn(),
  entries: vi.fn(),
  history: vi.fn(),
  stepHistory: vi.fn(),
}));
const listTree = vi.hoisted(() => vi.fn());

vi.mock('@desktop/utils/api', async () => {
  const core =
    await vi.importActual<typeof import('@desktop/utils/api/core')>('@desktop/utils/api/core');
  return { tablesApi: api, containersApi: { listTree }, FetchError: core.FetchError };
});

const DRAFT_ID = 'table-1111111111111-aaaaaaaaa';

const customTable: TableCatalogEntry = {
  id: DRAFT_ID,
  name: 'reading_list',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const builtinTable: TableCatalogEntry = {
  id: 'table-builtin-docs',
  name: 'Docs',
  origin: 'builtin',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let events: TableEvent[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  __resetTableNameCacheForTests();
  __resetTableHistoryForTests();
  __resetProjectListForTests();
  listTree.mockReset().mockResolvedValue([]);
  api.history
    .mockReset()
    .mockResolvedValue({ actor: null, steps: [], undo: null, redo: null, depth: 100 });
  api.stepHistory.mockReset();
  api.list.mockReset().mockResolvedValue({ tables: [customTable, builtinTable] });
  api.get.mockReset();
  api.create.mockReset();
  api.rename.mockReset();
  api.fields.mockReset().mockResolvedValue({ fields: [] });
  api.entries.mockReset().mockResolvedValue({
    entries: [],
    fields: [],
    totalCount: 0,
    page: 1,
    pageSize: 25,
    schemaVersion: 'a'.repeat(64),
  });
  events = [];
  stop = subscribeTableEvents((event) => events.push(event));
});

afterEach(() => stop());

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TableDraftView', () => {
  it('opens with the name input focused and no network traffic', () => {
    render(<TableDraftView draftId={DRAFT_ID} />);
    expect(screen.getByRole('textbox', { name: 'Table name' })).toHaveFocus();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('creates exactly once under Enter spam and double-click, then announces the table', async () => {
    const pending = deferred<CreateTableResponse>();
    api.create.mockReturnValue(pending.promise);
    render(<TableDraftView draftId={DRAFT_ID} />);
    const input = screen.getByRole('textbox', { name: 'Table name' });
    await userEvent.type(input, '  reading_list  ');

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    const create = screen.getByRole('button', { name: /Creat/ });
    fireEvent.click(create);
    fireEvent.click(create);

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith({ id: DRAFT_ID, name: 'reading_list' });
    expect(create).toBeDisabled();

    pending.resolve({ table: customTable });
    await waitFor(() => expect(events).toEqual([{ type: 'table.created', table: customTable }]));
  });

  it('keeps the draft, the typed name and the id after a server error, and retries with the same id', async () => {
    api.create.mockRejectedValueOnce(new Error('A table named "reading_list" already exists'));
    render(<TableDraftView draftId={DRAFT_ID} />);
    const input = screen.getByRole('textbox', { name: 'Table name' });
    await userEvent.type(input, 'reading_list{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(input).toHaveValue('reading_list');
    expect(events).toEqual([]);

    api.create.mockResolvedValueOnce({ table: customTable });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2));
    expect(api.create).toHaveBeenLastCalledWith({ id: DRAFT_ID, name: 'reading_list' });
  });

  it('blocks empty and too-long names without calling the server', async () => {
    render(<TableDraftView draftId={DRAFT_ID} />);
    const input = screen.getByRole('textbox', { name: 'Table name' });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a table name.');

    fireEvent.change(input, { target: { value: 'x'.repeat(64) } });
    expect(screen.getByRole('alert')).toHaveTextContent('at most 63 characters');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Create table' })).toBeDisabled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('creates the table in its project and names the project in the header', async () => {
    const projectId = 'container-1111111111111-aaaaaaaaa';
    listTree.mockResolvedValue([
      {
        kind: 'container',
        id: projectId,
        parentId: null,
        name: 'Test project',
        sortOrder: 0,
        category: 'project',
        folderPath: null,
        githubUrl: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        children: [],
      },
    ]);
    const linked: TableCatalogEntry = { ...customTable, projectId, sortOrder: 3 };
    api.create.mockResolvedValue({ table: linked });
    render(<TableDraftView draftId={DRAFT_ID} projectId={projectId} />);
    const form = screen.getByRole('form', { name: 'New table' });
    expect(await within(form).findByText('New table · Test project')).toBeInTheDocument();

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Table name' }),
      'reading_list{Enter}'
    );
    expect(api.create).toHaveBeenCalledWith({ id: DRAFT_ID, name: 'reading_list', projectId });
    await waitFor(() => expect(events).toEqual([{ type: 'table.created', table: linked }]));
  });

  it('keeps an unlinked draft workspace-wide, without asking for projects', async () => {
    api.create.mockResolvedValue({ table: customTable });
    render(<TableDraftView draftId={DRAFT_ID} projectId={null} />);
    expect(
      within(screen.getByRole('form', { name: 'New table' })).getByText('New table')
    ).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Table name' }),
      'reading_list{Enter}'
    );
    expect(api.create).toHaveBeenCalledWith({ id: DRAFT_ID, name: 'reading_list' });
    expect(listTree).not.toHaveBeenCalled();
  });

  it('discards on Escape without calling the server', async () => {
    render(<TableDraftView draftId={DRAFT_ID} />);
    const input = screen.getByRole('textbox', { name: 'Table name' });
    await userEvent.type(input, 'Half typed{Escape}');
    expect(events).toEqual([{ type: 'draft.discarded', draftId: DRAFT_ID }]);
    expect(api.create).not.toHaveBeenCalled();
  });

  it.each([
    'Tasks & Ideas',
    'Test-Table',
    'Tasks 😀',
    '___',
    '2026 Projects',
    'Work Experience',
    'order',
  ])('keeps invalid name %j editable and blocks submission until corrected', async (name) => {
    api.create.mockResolvedValue({ table: customTable });
    render(<TableDraftView draftId={DRAFT_ID} />);
    const input = screen.getByRole('textbox', { name: 'Table name' });
    fireEvent.change(input, { target: { value: name } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue(name);
    expect(screen.getByRole('button', { name: 'Create table' })).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(screen.getByRole('form', { name: 'New table' }));
    expect(api.create).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'test_table_2026' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create table' })).toBeEnabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith({ id: DRAFT_ID, name: 'test_table_2026' })
    );
  });
});

describe('TableView', () => {
  it('retries a failed metadata load without reopening the pane', async () => {
    api.get.mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValueOnce({
      table: builtinTable,
      columns: [],
      rowCount: 42,
    } satisfies TableDetailResponse);
    render(<TableView tableId={builtinTable.id} initial={builtinTable} />);
    expect(await screen.findByText('HTTP 502')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading table' }));
    expect(await screen.findByText('42 entries')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('HTTP 502')).not.toBeInTheDocument();
  });

  it('leads with the custom table name and keeps locked system fields visible', async () => {
    const detail: TableDetailResponse = {
      table: customTable,
      columns: [
        { name: 'id', dataType: 'text', nullable: false, managed: true },
        {
          name: 'created_at',
          dataType: 'timestamp with time zone',
          nullable: false,
          managed: true,
        },
      ],
      rowCount: 0,
    };
    api.get.mockResolvedValue(detail);
    render(<TableView tableId={DRAFT_ID} initial={customTable} />);

    expect(screen.getByRole('heading', { name: 'reading_list' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Insert first row' })).toBeEnabled()
    );
    expect(screen.queryByText('Your table')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /created_at/ })).toHaveAttribute(
      'aria-description',
      'Timestamp with time zone · Managed by Snaglet'
    );
    expect(screen.getByRole('columnheader', { name: 'id' })).toHaveAttribute(
      'aria-description',
      'Text · Managed by Snaglet'
    );
    expect(screen.queryByRole('button', { name: /system fields/i })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(DRAFT_ID);
  });

  it('marks built-ins as Snaglet managed and shows their row count only', async () => {
    api.get.mockResolvedValue({
      table: builtinTable,
      columns: [{ name: 'title', dataType: 'text', nullable: true, managed: false }],
      rowCount: 42,
    } satisfies TableDetailResponse);
    render(<TableView tableId={builtinTable.id} />);

    expect(await screen.findByText('42 entries')).toBeInTheDocument();
    expect(screen.getByText('Snaglet managed')).toBeInTheDocument();
    expect(screen.getByText(/Browsing its entries comes later/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add field' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit field/ })).not.toBeInTheDocument();
    expect(api.fields).not.toHaveBeenCalled();
  });

  it('shows an unavailable state for an unknown table', async () => {
    const { FetchError } = await import('@desktop/utils/api');
    api.get.mockRejectedValue(new FetchError('Table not found', 404));
    render(<TableView tableId="table-9999999999999-zzzzzzzzz" />);
    expect(await screen.findByText('Table unavailable')).toBeInTheDocument();
  });
});

describe('TableView title rename', () => {
  const customDetail: TableDetailResponse = { table: customTable, columns: [], rowCount: 0 };
  const renamed: TableCatalogEntry = { ...customTable, name: 'reading_notes' };

  async function openCustom() {
    api.get.mockResolvedValue(customDetail);
    render(<TableView tableId={DRAFT_ID} initial={customTable} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Insert first row' })).toBeEnabled()
    );
    return screen.getByRole('button', { name: 'reading_list' });
  }

  it('renames a custom table in place with one PATCH under Enter spam', async () => {
    const pending = deferred<RenameTableResponse>();
    api.rename.mockReturnValue(pending.promise);
    await userEvent.dblClick(await openCustom());

    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('reading_list');
    await userEvent.clear(input);
    await userEvent.type(input, 'reading_notes');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(api.rename).toHaveBeenCalledTimes(1);
    expect(api.rename).toHaveBeenCalledWith(DRAFT_ID, {
      name: 'reading_notes',
      expectedName: 'reading_list',
    });
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('aria-busy', 'true');

    await act(async () => pending.resolve({ table: renamed }));
    expect(screen.getByRole('heading', { name: 'reading_notes' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'reading_notes' })).toHaveFocus();
    expect(events).toEqual([{ type: 'table.updated', table: renamed }]);
  });

  it('autosaves on blur without Save or Cancel buttons', async () => {
    api.rename.mockResolvedValue({ table: renamed });
    await userEvent.dblClick(await openCustom());
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(screen.queryByRole('button', { name: 'Save name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel rename' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'reading_notes' } });
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(api.rename).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'reading_notes' })).toBeInTheDocument();
  });

  it('keeps single-click quiet and opens from F2 with the existing name selected', async () => {
    const title = await openCustom();
    expect(title).toHaveAttribute('title', 'Double-click to rename');
    await userEvent.click(title);
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    fireEvent.keyDown(title, { key: 'F2' });
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Rename' });
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('reading_list'.length);
  });

  it('cancels on Escape and treats an unchanged name as a no-op', async () => {
    const title = await openCustom();
    await userEvent.dblClick(title);
    const input = screen.getByRole('textbox', { name: 'Rename' });
    await userEvent.type(input, ' draft{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'reading_list' })).toBeInTheDocument();

    await userEvent.dblClick(screen.getByRole('button', { name: 'reading_list' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename' }), { key: 'Enter' });
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument();
    expect(api.rename).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('blocks invalid names and keeps the typed text after a server conflict', async () => {
    const { FetchError } = await import('@desktop/utils/api');
    api.rename.mockRejectedValueOnce(new FetchError('A table named "budget" already exists', 409));
    await userEvent.dblClick(await openCustom());
    const input = screen.getByRole('textbox', { name: 'Rename' });

    fireEvent.change(input, { target: { value: 'Tasks & Ideas' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Use only lowercase letters');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(api.rename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'budget' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(input).toHaveValue('budget');
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
    expect(events).toEqual([]);

    // Escape after the failure leaves the saved name untouched.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'reading_list' })).toBeInTheDocument();
  });

  it('keeps Snaglet table titles plain text with no rename affordance', async () => {
    api.get.mockResolvedValue({
      table: builtinTable,
      columns: [],
      rowCount: 3,
    } satisfies TableDetailResponse);
    render(<TableView tableId={builtinTable.id} initial={builtinTable} />);
    await screen.findByText('3 entries');

    const heading = screen.getByRole('heading', { name: 'Docs' });
    expect(within(heading).queryByRole('button')).not.toBeInTheDocument();
    await userEvent.click(heading);
    fireEvent.keyDown(heading, { key: 'F2' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('patches the open title from table.updated for its own table only', async () => {
    await openCustom();
    act(() => {
      emitTableEvent({ type: 'table.updated', table: { ...builtinTable, name: 'Other' } });
      emitTableEvent({ type: 'table.updated', table: renamed });
    });
    expect(screen.getByRole('heading', { name: 'reading_notes' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('keeps a rename heard while the detail was still loading', async () => {
    const pending = deferred<TableDetailResponse>();
    api.get.mockReturnValue(pending.promise);
    render(<TableView tableId={DRAFT_ID} initial={customTable} />);
    act(() => emitTableEvent({ type: 'table.updated', table: renamed }));
    await act(async () => pending.resolve(customDetail));

    expect(await screen.findByRole('button', { name: 'reading_notes' })).toBeInTheDocument();
  });

  it('uses the live catalog name over restored selection and late stale detail metadata', async () => {
    const pending = deferred<TableDetailResponse>();
    api.get.mockReturnValue(pending.promise);
    api.list.mockResolvedValue({ tables: [renamed] });
    render(<TableView tableId={DRAFT_ID} initial={customTable} />);

    expect(screen.getByRole('heading', { name: 'reading_list' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'reading_notes' })).toBeInTheDocument();
    await act(async () => pending.resolve(customDetail));

    await userEvent.dblClick(await screen.findByRole('button', { name: 'reading_notes' }));
    expect(screen.getByRole('textbox', { name: 'Rename' })).toHaveValue('reading_notes');
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('recovers a missed rename on catalog invalidation and begins from the live name', async () => {
    await openCustom();
    api.list.mockResolvedValue({ tables: [renamed] });
    act(() => emitTableEvent({ type: 'tables.invalidated' }));

    await userEvent.dblClick(await screen.findByRole('button', { name: 'reading_notes' }));
    const input = screen.getByRole('textbox', { name: 'Rename' });
    expect(input).toHaveValue('reading_notes');
    api.rename.mockResolvedValue({ table: { ...renamed, name: 'book_notes' } });
    fireEvent.change(input, { target: { value: 'book_notes' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await screen.findByRole('heading', { name: 'book_notes' });
    expect(api.rename).toHaveBeenCalledWith(DRAFT_ID, {
      name: 'book_notes',
      expectedName: 'reading_notes',
    });
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});

describe('TableView when its table is archived', () => {
  const customDetail: TableDetailResponse = { table: customTable, columns: [], rowCount: 0 };

  async function openCustom(onClosePane?: () => void) {
    api.get.mockResolvedValue(customDetail);
    render(<TableView tableId={DRAFT_ID} initial={customTable} onClosePane={onClosePane} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Insert first row' })).toBeEnabled()
    );
  }

  it('turns an open pane into the archived notice, which opens the Archived drawer', async () => {
    const openDrawer = vi.fn();
    const stopHost = onArchivedDrawerRequest(openDrawer);
    const onClosePane = vi.fn();
    try {
      await openCustom(onClosePane);
      act(() => emitTableEvent({ type: 'table.removed', tableId: DRAFT_ID, state: 'archived' }));

      expect(screen.getByText('This table is archived')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Insert first row' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Open Archived' }));
      expect(openDrawer).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByRole('button', { name: 'Close pane' }));
      expect(onClosePane).toHaveBeenCalledTimes(1);
    } finally {
      stopHost();
    }
  });

  it('ignores another table being archived', async () => {
    await openCustom();
    act(() =>
      emitTableEvent({
        type: 'table.removed',
        tableId: 'table-2222222222222-bbbbbbbbb',
        state: 'archived',
      })
    );
    expect(screen.getByRole('button', { name: 'Insert first row' })).toBeEnabled();
  });

  it('shows the archived notice for a table that loads archived, without an unreachable drawer button', async () => {
    api.get.mockResolvedValue({
      ...customDetail,
      table: { ...customTable, state: 'archived', archivedAt: '2026-01-02T00:00:00.000Z' },
    });
    render(<TableView tableId={DRAFT_ID} initial={customTable} />);

    expect(await screen.findByText('This table is archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Archived' })).not.toBeInTheDocument();
    expect(api.fields).not.toHaveBeenCalled();
  });

  it('comes back in place, under its new name, when the table is restored', async () => {
    await openCustom();
    act(() => emitTableEvent({ type: 'table.removed', tableId: DRAFT_ID, state: 'archived' }));
    expect(screen.getByText('This table is archived')).toBeInTheDocument();

    const renamed = { ...customTable, name: 'reading_list_old' };
    api.get.mockClear().mockResolvedValue({ ...customDetail, table: renamed });
    act(() => emitTableEvent({ type: 'table.restored', table: renamed }));

    expect(await screen.findByRole('button', { name: 'reading_list_old' })).toBeInTheDocument();
    expect(screen.queryByText('This table is archived')).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(DRAFT_ID);
  });

  it('offers Undo archive when archiving this table is the next undo step', async () => {
    const archiveStep = {
      id: 'step-1',
      actor: { kind: 'user', id: 'user-test' },
      kind: 'table.archive',
      label: 'Archive table reading_list',
      tableIds: [DRAFT_ID],
      state: 'done',
      seq: 1,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    await openCustom();
    api.history.mockResolvedValue({
      actor: archiveStep.actor,
      steps: [archiveStep],
      undo: archiveStep,
      redo: null,
      depth: 100,
    });
    api.stepHistory.mockResolvedValue({ step: archiveStep, undo: null, redo: archiveStep });
    act(() => emitTableEvent({ type: 'table.removed', tableId: DRAFT_ID, state: 'archived' }));
    act(() =>
      emitTableEvent({ type: 'table.history.changed', stack: { kind: 'user', id: 'user-test' } })
    );
    const undo = await screen.findByRole('button', { name: 'Undo archive' });
    expect(undo).toHaveAttribute('title', 'Undo archive table reading_list');
    await userEvent.click(undo);
    await waitFor(() => expect(api.stepHistory).toHaveBeenCalledWith('undo', { stepId: 'step-1' }));

    // The server's own `table.restored` brings the table back in place.
    act(() => emitTableEvent({ type: 'table.restored', table: customTable }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Insert first row' })).toBeEnabled()
    );
  });

  it('reads as unavailable once the table is deleted for good', async () => {
    await openCustom();
    act(() => emitTableEvent({ type: 'table.removed', tableId: DRAFT_ID, state: 'deleted' }));
    expect(screen.getByText('Table unavailable')).toBeInTheDocument();
  });
});
