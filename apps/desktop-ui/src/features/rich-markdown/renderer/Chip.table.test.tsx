/**
 * Rendered table chips: live catalog names, the unavailable state, and
 * click-to-open the table pane.
 *
 * The catalog name cache is module state, so every test starts from an
 * unloaded cache. It is reset in place: re-importing the renderer graph per
 * test costs seconds and timed out the first case under load.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { __resetTableNameCacheForTests } from '@desktop/features/database/tableNameCache';
import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { MarkdownRenderer } from './MarkdownRenderer';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ list: vi.fn(), archived: vi.fn(), agents: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, list: api.list },
    archiveApi: { ...actual.archiveApi, tables: api.archived },
    agentsApi: { ...actual.agentsApi, list: api.agents },
  };
});

const CUSTOM_ID = 'table-1111111111111-aaaaaaaaa';
const MISSING_ID = 'table-2222222222222-bbbbbbbbb';

const entry = (id: string, name: string): TableCatalogEntry => ({
  id,
  name,
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

function renderMarkdown(content: string) {
  const openTable = vi.fn();
  render(
    <DashboardNavigationProvider
      value={{
        openInPane: vi.fn(),
        openThreadAgent: vi.fn(),
        requestReveal: vi.fn(),
        openTable,
      }}
    >
      <MarkdownRenderer content={content} />
    </DashboardNavigationProvider>
  );
  return { openTable };
}

const chip = () => document.querySelector<HTMLAnchorElement>('a.md-chip-table');

describe('rendered table chips', () => {
  beforeEach(() => {
    __resetTableNameCacheForTests();
    vi.clearAllMocks();
    api.agents.mockResolvedValue([]);
    api.list.mockResolvedValue({ tables: [entry(CUSTOM_ID, 'Reading list')] });
    api.archived.mockResolvedValue({ tables: [] });
  });

  it('shows the live catalog name instead of the title frozen into the markdown', async () => {
    renderMarkdown(`See [Old name](table:${CUSTOM_ID}).`);
    await waitFor(() => expect(chip()).toHaveTextContent('Reading list'));
    expect(chip()).toHaveAttribute('href', `table:${CUSTOM_ID}`);
    expect(chip()).toHaveAttribute('data-node-id', CUSTOM_ID);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('follows a rename heard as table.updated', async () => {
    renderMarkdown(`[Old name](table:${CUSTOM_ID})`);
    await waitFor(() => expect(chip()).toHaveTextContent('Reading list'));
    act(() => emitTableEvent({ type: 'table.updated', table: entry(CUSTOM_ID, 'Book club') }));
    expect(chip()).toHaveTextContent('Book club');
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('opens the table pane by catalog id on click', async () => {
    const { openTable } = renderMarkdown(`[Old name](table:${CUSTOM_ID})`);
    await waitFor(() => expect(chip()).toHaveTextContent('Reading list'));
    fireEvent.click(chip()!);
    expect(openTable).toHaveBeenCalledWith(CUSTOM_ID);
    // Tables never open the workspace-node preview modal.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders an honest unavailable state for a table no longer in the catalog', async () => {
    const { openTable } = renderMarkdown(`[Deleted table](table:${MISSING_ID})`);
    await waitFor(() => expect(chip()).toHaveTextContent('Unavailable table'));
    expect(chip()).toHaveClass('md-chip-unavailable');
    expect(chip()).toHaveAttribute('aria-disabled', 'true');
    expect(chip()).not.toHaveTextContent('Deleted table');
    fireEvent.click(chip()!);
    expect(openTable).not.toHaveBeenCalled();
  });

  it('keeps the name of an archived table and still opens its pane', async () => {
    api.archived.mockResolvedValue({
      tables: [{ ...entry(MISSING_ID, 'Old budget'), state: 'archived' }],
    });
    const { openTable } = renderMarkdown(`[Frozen title](table:${MISSING_ID})`);
    await waitFor(() => expect(chip()).toHaveTextContent('Old budget'));
    expect(chip()).not.toHaveClass('md-chip-unavailable');
    expect(chip()).toHaveAttribute('title', 'This table is archived');
    fireEvent.click(chip()!);
    expect(openTable).toHaveBeenCalledWith(MISSING_ID);
  });

  it('keeps the frozen title when the catalog cannot load', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.list.mockRejectedValue(new Error('offline'));
    renderMarkdown(`[Reading list](table:${CUSTOM_ID})`);
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(chip()).toHaveTextContent('Reading list');
    expect(chip()).not.toHaveClass('md-chip-unavailable');
    error.mockRestore();
  });

  it('does not chip a bare catalog id written in prose', async () => {
    renderMarkdown(`The id is ${CUSTOM_ID} and table-builtin-docs.`);
    expect(document.querySelector('.md-chip')).toBeNull();
    expect(api.list).not.toHaveBeenCalled();
  });
});
