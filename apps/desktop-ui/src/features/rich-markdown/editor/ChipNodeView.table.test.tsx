/**
 * Editor (TipTap) table chips: the live catalog name, the unavailable state,
 * and click-to-open the table pane — the same contract the rendered chip
 * keeps, so a chip behaves identically while editing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCatalogEntry } from '@snaglet/shared/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({ list: vi.fn(), agents: vi.fn() }));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, list: api.list },
    agentsApi: { ...actual.agentsApi, list: api.agents },
  };
});

import { DashboardNavigationProvider } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { ChipEditableInput } from './ChipEditableInput';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const MISSING_ID = 'table-2222222222222-bbbbbbbbb';
const table: TableCatalogEntry = {
  id: TABLE_ID,
  name: 'Reading list',
  origin: 'custom',
  projectId: null,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
});

function renderInput(value: string) {
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
      <ChipEditableInput value={value} onChange={vi.fn()} ariaLabel="Notes" />
    </DashboardNavigationProvider>
  );
  return { openTable };
}

const chipFor = (id: string) =>
  document.querySelector<HTMLElement>(`.md-chip-table[data-node-url="table:${id}"]`);

describe('editor table chips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.agents.mockResolvedValue([]);
    api.list.mockResolvedValue({ tables: [table] });
  });

  it('shows the live name and opens the table pane on click', async () => {
    const { openTable } = renderInput(`[Old name](table:${TABLE_ID})`);
    await screen.findByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(chipFor(TABLE_ID)).toHaveTextContent('Reading list'));
    fireEvent.click(chipFor(TABLE_ID)!);
    expect(openTable).toHaveBeenCalledWith(TABLE_ID);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows an unavailable table as such and does not open it', async () => {
    const { openTable } = renderInput(`[Deleted table](table:${MISSING_ID})`);
    await screen.findByRole('textbox', { name: 'Notes' });
    await waitFor(() => expect(chipFor(MISSING_ID)).toHaveTextContent('Unavailable table'));
    expect(chipFor(MISSING_ID)).toHaveClass('md-chip-unavailable');
    fireEvent.click(chipFor(MISSING_ID)!);
    expect(openTable).not.toHaveBeenCalled();
  });
});
