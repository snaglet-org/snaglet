/**
 * `@` mentions of Database tables. A table hit carries a catalog id, so the
 * inserted chip must take the `table:` href — never the bare id a workspace
 * node chip would use — and `@table:` must narrow the search to tables.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteAugmentedResponse } from '@desktop/utils/api/palette-search';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const mocks = vi.hoisted(() => ({ tieredSearch: vi.fn(), list: vi.fn(), agents: vi.fn() }));

vi.mock('@desktop/hooks/useTieredSearch', () => ({
  useTieredSearch: mocks.tieredSearch,
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    tablesApi: { ...actual.tablesApi, list: mocks.list },
    agentsApi: { ...actual.agentsApi, list: mocks.agents },
  };
});

import { ChipEditableInput } from './ChipEditableInput';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';

const tableResponse: PaletteAugmentedResponse = {
  byKind: {},
  channelsUsed: ['fts'],
  semanticStatus: 'ready',
  coverage: {},
  items: [
    {
      type: 'workspace',
      nodeId: TABLE_ID,
      nodeType: 'table',
      title: 'Reading list',
      subtitle: null,
      icon: null,
      score: 1,
      archived: false,
    },
  ],
  filesystem: [],
  files: [],
  meta: { query: 'read', kinds: ['table'], workspaceCount: 1, filesystemCount: 0 },
};

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

describe('@ mentions of tables', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agents.mockResolvedValue([]);
    mocks.list.mockResolvedValue({
      tables: [
        {
          id: TABLE_ID,
          name: 'Reading list',
          origin: 'custom',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    mocks.tieredSearch.mockImplementation(({ enabled }: { enabled: boolean }) => ({
      instant: enabled ? tableResponse : null,
      enriched: null,
      instantLoading: false,
      enrichmentLoading: false,
    }));
  });

  it('narrows `@table:` to tables and inserts a `table:` chip titled by the name', async () => {
    const onChange = vi.fn();
    render(<ChipEditableInput value="" onChange={onChange} ariaLabel="Notes" />);
    const input = await screen.findByRole('textbox', { name: 'Notes' });
    await userEvent.type(input, '@table:read');

    const option = await screen.findByRole('option', { name: /Reading list/ });
    expect(screen.getByText('Tables')).toBeInTheDocument();
    expect(mocks.tieredSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'read', kinds: ['table'], enabled: true })
    );

    fireEvent.mouseDown(option);
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(`[Reading list](table:${TABLE_ID}) `)
    );
    expect(input.querySelector(`[data-node-url="table:${TABLE_ID}"]`)).toHaveTextContent(
      'Reading list'
    );
  });
});
