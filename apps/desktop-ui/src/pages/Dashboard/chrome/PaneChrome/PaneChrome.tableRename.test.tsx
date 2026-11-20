/**
 * Pane top bar rename for Database tables: double-click the title, Enter or
 * blur saves, Escape reverts — the docs/containers interaction, with no Save
 * or Cancel buttons. Names follow the shared table-name policy; refused,
 * taken and stale names keep the field open with the typed text.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenameTableResponse, TableCatalogEntry } from '@snaglet/shared/types';
import { FetchError } from '@desktop/utils/api';
import { subscribeTableEvents, type TableEvent } from '@desktop/features/database/tableEvents';
import { __resetTableNameCacheForTests } from '@desktop/features/database/tableNameCache';
import type { LayoutLeaf } from '../../layout/paneTree';
import type { NonNullableSelection } from '../../layout/paneTreeTypes';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ list: vi.fn(), rename: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, tablesApi: { ...actual.tablesApi, list: api.list, rename: api.rename } };
});

vi.mock('../../views/DetailRouter.js', () => ({ DetailRouter: () => <div>pane body</div> }));
vi.mock('../PaneHistoryNav/PaneHistoryNav.js', () => ({ PaneHistoryNav: () => null }));

import { PaneChrome } from './PaneChrome';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const BUILTIN_ID = 'table-builtin-docs';

const entry = (
  name: string,
  origin: TableCatalogEntry['origin'] = 'custom',
  id = TABLE_ID
): TableCatalogEntry => ({
  id,
  name,
  origin,
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

function renderPane(table: TableCatalogEntry) {
  const selection: NonNullableSelection = { kind: 'table', table_id: table.id, table };
  const leaf: LayoutLeaf = {
    kind: 'leaf',
    id: 'leaf-1',
    selection,
    history: { entries: [selection], index: 0 },
  };
  return render(
    <PaneChrome
      leaf={leaf}
      isActive
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onDropSelection={vi.fn()}
      onReplaceSelection={vi.fn()}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
      onJumpToHistoryEntry={vi.fn()}
    />
  );
}

async function startRename(name: string) {
  fireEvent.doubleClick(await screen.findByText(name));
  const input = await screen.findByRole('textbox', { name: 'Rename' });
  expect(input).toHaveFocus();
  return input;
}

let events: TableEvent[] = [];
let stop: () => void = () => undefined;

beforeEach(() => {
  __resetTableNameCacheForTests();
  api.list
    .mockReset()
    .mockResolvedValue({ tables: [entry('budget'), entry('Docs', 'builtin', BUILTIN_ID)] });
  api.rename.mockReset();
  events = [];
  stop = subscribeTableEvents((event) => events.push(event));
});

afterEach(() => stop());

describe('PaneChrome table title rename', () => {
  it('renames on double-click and Enter with no Save or Cancel buttons', async () => {
    const renamed = entry('bills');
    api.rename.mockResolvedValue({ table: renamed } satisfies RenameTableResponse);
    renderPane(entry('budget'));

    const title = await screen.findByText('budget');
    expect(title).toHaveAttribute('title', 'Double-click to rename');
    const input = await startRename('budget');
    expect(input).toHaveValue('budget');
    expect(screen.queryByRole('button', { name: /save|cancel/i })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'bills' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(api.rename).toHaveBeenCalledTimes(1);
    expect(api.rename).toHaveBeenCalledWith(TABLE_ID, { name: 'bills', expectedName: 'budget' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('bills')).toBeInTheDocument();
    expect(events).toEqual([{ type: 'table.updated', table: renamed }]);
  });

  it('autosaves on blur', async () => {
    api.rename.mockResolvedValue({ table: entry('bills') } satisfies RenameTableResponse);
    renderPane(entry('budget'));
    const input = await startRename('budget');

    fireEvent.change(input, { target: { value: 'bills' } });
    await act(async () => {
      fireEvent.blur(input);
    });

    expect(api.rename).toHaveBeenCalledTimes(1);
    expect(screen.getByText('bills')).toBeInTheDocument();
  });

  it('reverts on Escape without a request', async () => {
    renderPane(entry('budget'));
    const input = await startRename('budget');
    fireEvent.change(input, { target: { value: 'bills' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('budget')).toBeInTheDocument();
    expect(api.rename).not.toHaveBeenCalled();
  });

  it('refuses an invalid name inline and keeps the field open', async () => {
    renderPane(entry('budget'));
    const input = await startRename('budget');
    fireEvent.change(input, { target: { value: 'Tasks & Ideas' } });

    // Capitals and spaces are fixed as typed; the `&` is left for the error.
    expect(input).toHaveValue('tasks_&_ideas');
    expect(screen.getByRole('alert')).toHaveTextContent('Use only lowercase letters');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);

    expect(api.rename).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Rename' })).toBe(input);
    expect(input).toHaveValue('tasks_&_ideas');
  });

  it('keeps the typed name after a taken-name 409 and offers the current name', async () => {
    api.rename
      .mockRejectedValueOnce(new FetchError('A table named "reading_list" already exists', 409))
      .mockResolvedValueOnce({ table: entry('bills') });
    renderPane(entry('budget'));
    const input = await startRename('budget');
    fireEvent.change(input, { target: { value: 'reading_list' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'A table named "reading_list" already exists. Escape keeps "budget".'
    );
    expect(input).toHaveValue('reading_list');
    expect(input).not.toHaveAttribute('readonly');
    expect(events).toEqual([]);

    fireEvent.change(input, { target: { value: 'bills' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(api.rename).toHaveBeenCalledTimes(2);
    expect(screen.getByText('bills')).toBeInTheDocument();
  });

  it('keeps the typed name after a stale 409 and retries from the current name', async () => {
    const current = entry('expenses');
    api.rename
      .mockRejectedValueOnce(
        new FetchError('This table was renamed to "expenses"', 409, { table: current })
      )
      .mockResolvedValueOnce({ table: entry('bills') });
    renderPane(entry('budget'));
    const input = await startRename('budget');
    fireEvent.change(input, { target: { value: 'bills' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This table was renamed to "expenses". Escape keeps "expenses".'
    );
    expect(input).toHaveValue('bills');
    expect(events).toEqual([{ type: 'table.updated', table: current }]);

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(api.rename).toHaveBeenLastCalledWith(TABLE_ID, {
      name: 'bills',
      expectedName: 'expenses',
    });
    expect(screen.getByText('bills')).toBeInTheDocument();
  });

  it('leaves Snaglet table titles read-only', async () => {
    renderPane(entry('Docs', 'builtin', BUILTIN_ID));
    const title = await screen.findByText('Docs');
    await waitFor(() => expect(api.list).toHaveBeenCalled());

    expect(title).not.toHaveAttribute('title');
    fireEvent.doubleClick(title);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.rename).not.toHaveBeenCalled();
  });
});
