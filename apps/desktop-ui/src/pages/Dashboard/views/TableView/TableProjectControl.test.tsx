import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SetTableProjectResponse,
  TableCatalogEntry,
  TableDetailResponse,
} from '@snaglet/shared/types';
import { emitTableEvent, subscribeTableEvents, type TableEvent } from '@desktop/features/database';
import { __resetProjectListForTests } from '@desktop/features/database/projectList';
import { __resetTableNameCacheForTests } from '@desktop/features/database/tableNameCache';
import { __resetTableHistoryForTests } from '@desktop/features/database/tableHistory';
import type { ContainerTreeNode } from '@desktop/utils/api';
import { TableView } from './TableView';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  setProject: vi.fn(),
  fields: vi.fn(),
  entries: vi.fn(),
  history: vi.fn(),
  listTree: vi.fn(),
}));

vi.mock('@desktop/utils/api', async () => {
  const actual = await vi.importActual<typeof import('@desktop/utils/api')>('@desktop/utils/api');
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: api.listTree },
    tablesApi: {
      ...actual.tablesApi,
      list: api.list,
      get: api.get,
      setProject: api.setProject,
      fields: api.fields,
      entries: api.entries,
      history: api.history,
    },
  };
});

const timestamp = '2026-01-01T00:00:00.000Z';
const TABLE_ID = 'table-1111111111111-aaaaaaaaa';

const customTable: TableCatalogEntry = {
  id: TABLE_ID,
  name: 'companies',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: timestamp,
};

const builtinTable: TableCatalogEntry = {
  id: 'table-builtin-docs',
  name: 'Docs',
  origin: 'builtin',
  projectId: null,
  sortOrder: 0,
  createdAt: timestamp,
};

const project = (id: string, name: string): ContainerTreeNode => ({
  kind: 'container',
  id,
  parentId: null,
  name,
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  children: [],
  category: 'project',
  folderPath: null,
  githubUrl: null,
});

const launch = project('container-3333333333333-project1', 'Launch');
const sales = project('container-4444444444444-project2', 'Sales');

const detail = (table: TableCatalogEntry): TableDetailResponse => ({
  table,
  columns: [],
  rowCount: 0,
});

let events: TableEvent[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  __resetProjectListForTests();
  __resetTableNameCacheForTests();
  __resetTableHistoryForTests();
  api.list.mockReset().mockResolvedValue({ tables: [customTable, builtinTable] });
  api.get.mockReset().mockResolvedValue(detail(customTable));
  api.setProject.mockReset();
  api.fields.mockReset().mockResolvedValue({ fields: [] });
  api.entries.mockReset().mockResolvedValue({
    entries: [],
    fields: [],
    totalCount: 0,
    page: 1,
    pageSize: 25,
    schemaVersion: 'a'.repeat(64),
  });
  api.history
    .mockReset()
    .mockResolvedValue({ actor: null, steps: [], undo: null, redo: null, depth: 100 });
  api.listTree.mockReset().mockResolvedValue([sales, launch]);
  events = [];
  stop = subscribeTableEvents((event) => events.push(event));
});

afterEach(() => stop());

const control = (label: string) => screen.findByRole('button', { name: `Project: ${label}` });

async function openPicker(label: string) {
  await userEvent.click(await control(label));
  return screen.getByRole('menu', { name: 'Table project' });
}

describe('TableProjectControl', () => {
  it('reads Workspace for an unlinked table and lists Workspace then projects by name', async () => {
    render(<TableView tableId={TABLE_ID} initial={customTable} />);
    const menu = await openPicker('Workspace');

    await within(menu).findByRole('menuitemradio', { name: 'Sales' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['Workspace', 'Launch', 'Sales']);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    expect(items[0]).toHaveFocus();
    expect(items[1]).toHaveAttribute('aria-checked', 'false');
  });

  it('links the table from the picker, announces the entry and relabels', async () => {
    const moved = { ...customTable, projectId: launch.id };
    api.setProject.mockResolvedValue({ table: moved } satisfies SetTableProjectResponse);
    render(<TableView tableId={TABLE_ID} initial={customTable} />);
    const menu = await openPicker('Workspace');

    await userEvent.click(await within(menu).findByRole('menuitemradio', { name: 'Launch' }));

    expect(api.setProject).toHaveBeenCalledWith(TABLE_ID, launch.id);
    expect(await control('Launch')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(events).toEqual([{ type: 'table.updated', table: moved }]);
  });

  it('unlinks back to Workspace and treats the current choice as a no-op', async () => {
    api.get.mockResolvedValue(detail({ ...customTable, projectId: launch.id }));
    api.setProject.mockResolvedValue({
      table: customTable,
    } satisfies SetTableProjectResponse);
    render(<TableView tableId={TABLE_ID} />);

    let menu = await openPicker('Launch');
    await userEvent.click(await within(menu).findByRole('menuitemradio', { name: 'Launch' }));
    expect(api.setProject).not.toHaveBeenCalled();

    menu = await openPicker('Launch');
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Workspace' }));
    expect(api.setProject).toHaveBeenCalledWith(TABLE_ID, null);
    expect(await control('Workspace')).toBeInTheDocument();
  });

  it('shows the server message inline and keeps the current label after a refusal', async () => {
    const { FetchError } = await import('@desktop/utils/api');
    api.setProject.mockRejectedValue(new FetchError('Project not found', 404));
    render(<TableView tableId={TABLE_ID} initial={customTable} />);
    const menu = await openPicker('Workspace');

    await userEvent.click(await within(menu).findByRole('menuitemradio', { name: 'Sales' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Project not found');
    const trigger = await control('Workspace');
    expect(trigger).toHaveAttribute('aria-describedby', alert.id);
    expect(events).toEqual([]);

    // The next attempt clears the message.
    api.setProject.mockResolvedValue({
      table: { ...customTable, projectId: sales.id },
    } satisfies SetTableProjectResponse);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Sales' }));
    await control('Sales');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('relabels from a table.updated heard from elsewhere, for its own table only', async () => {
    render(<TableView tableId={TABLE_ID} initial={customTable} />);
    await control('Workspace');

    act(() => {
      emitTableEvent({
        type: 'table.updated',
        table: { ...customTable, id: 'table-2222222222222-bbbbbbbbb', projectId: sales.id },
      });
    });
    expect(await control('Workspace')).toBeInTheDocument();

    act(() =>
      emitTableEvent({ type: 'table.updated', table: { ...customTable, projectId: sales.id } })
    );
    expect(await control('Sales')).toBeInTheDocument();
  });

  it('names an unlisted project as archived and offers nothing for Snaglet tables', async () => {
    api.get.mockResolvedValue(
      detail({ ...customTable, projectId: 'container-9999999999999-gone0001' })
    );
    render(<TableView tableId={TABLE_ID} />);
    expect(await control('Archived project')).toBeInTheDocument();
  });

  it('renders no project control for a Snaglet table', async () => {
    api.get.mockResolvedValue({ ...detail(builtinTable), rowCount: 3 });
    render(<TableView tableId={builtinTable.id} initial={builtinTable} />);
    await screen.findByText('3 entries');
    expect(screen.queryByRole('button', { name: /^Project:/ })).not.toBeInTheDocument();
    expect(api.listTree).not.toHaveBeenCalled();
  });

  it('moves through the picker with arrow keys and closes on Escape, returning focus', async () => {
    render(<TableView tableId={TABLE_ID} initial={customTable} />);
    const menu = await openPicker('Workspace');
    await within(menu).findByRole('menuitemradio', { name: 'Sales' });

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Launch' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Sales' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(await control('Workspace')).toHaveFocus();
    expect(api.setProject).not.toHaveBeenCalled();
  });
});
