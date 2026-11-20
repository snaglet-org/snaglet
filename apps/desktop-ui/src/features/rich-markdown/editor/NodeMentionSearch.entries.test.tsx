/**
 * Table rows in the `@` search: ranked beside the nodes (a few at most), `@entry:`
 * scopes the search to rows, and picking one inserts a row chip.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteAugmentedResponse } from '@desktop/utils/api/palette-search';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const mocks = vi.hoisted(() => ({ tieredSearch: vi.fn(), agents: vi.fn() }));

vi.mock('@desktop/hooks/useTieredSearch', () => ({
  useTieredSearch: mocks.tieredSearch,
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return { ...actual, agentsApi: { ...actual.agentsApi, list: mocks.agents } };
});

import { ChipEditableInput } from './ChipEditableInput';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';

function response(query: string, rowCount = 6): PaletteAugmentedResponse {
  return {
    byKind: {},
    channelsUsed: ['fts'],
    semanticStatus: 'ready',
    coverage: {},
    items: [
      {
        type: 'workspace',
        nodeId: 'thread-1111111111111-aaaaaaaaa',
        nodeType: 'thread',
        title: 'Concurrent calls thread',
        subtitle: null,
        icon: null,
        score: 1,
        archived: false,
      },
    ],
    filesystem: [],
    files: [],
    entries: Array.from({ length: rowCount }, (_, i) => ({
      tableId: TABLE_ID,
      tableName: 'quotes',
      projectId: null,
      entryId: i === 0 ? ENTRY_ID : `22222222-2222-4222-8222-22222222222${i}`,
      name: `Concurrent row ${i}`,
      score: 0.5,
      createdAt: '2026-10-19T10:00:00.000000Z',
    })),
    meta: { query, kinds: [], workspaceCount: 1, filesystemCount: 0 },
  };
}

beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null;
  if (!Range.prototype.getClientRects)
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect)
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agents.mockResolvedValue([]);
  mocks.tieredSearch.mockImplementation(
    ({ enabled, query }: { enabled: boolean; query: string }) => ({
      instant: enabled && query.trim() ? response(query) : null,
      enriched: null,
      instantLoading: false,
      enrichmentLoading: false,
    })
  );
});

const lastSearch = () =>
  mocks.tieredSearch.mock.calls[mocks.tieredSearch.mock.calls.length - 1]?.[0];

describe('@ search with table rows', () => {
  it('asks for rows beside the nodes and lists at most five', async () => {
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@concurrent');
    expect(lastSearch()).toMatchObject({ query: 'concurrent', includeEntries: true });
    expect(screen.getByText('Concurrent calls thread')).toBeInTheDocument();
    expect(screen.getAllByText(/^Concurrent row \d$/)).toHaveLength(5);
  });

  it('`@entry:` becomes an entry-only search and lists every row', async () => {
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@entry:concurrent');
    expect(lastSearch()).toMatchObject({ query: 'entry: concurrent', includeEntries: false });
    expect(lastSearch().kinds).toBeUndefined();
    expect(screen.getAllByText(/^Concurrent row \d$/)).toHaveLength(6);
  });

  it('`@table:` lists the tables and then their rows, nothing else', async () => {
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@table:concurrent');
    expect(lastSearch()).toMatchObject({ includeEntries: true, kinds: ['table'] });
    expect(screen.getAllByText(/^Concurrent row \d$/)).toHaveLength(6);
  });

  it('a `doc:` filter leaves rows out', async () => {
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@doc:concurrent');
    expect(lastSearch()).toMatchObject({ includeEntries: false, kinds: ['doc'] });
  });

  it('`@table:work_items:entry:` searches the rows of that one table', async () => {
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@table:work_items:entry:some query');
    expect(lastSearch()).toMatchObject({
      query: 'table:"work_items" entry: some query',
      includeEntries: false,
    });
    expect(lastSearch().kinds).toBeUndefined();
  });

  it('picking a row inserts a row chip', async () => {
    const onChange = vi.fn();
    render(<ChipEditableInput value="" onChange={onChange} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@entry:concurrent');
    await userEvent.click(screen.getByText('Concurrent row 0'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.stringContaining(`[Concurrent row 0](entry:${TABLE_ID}/${ENTRY_ID})`)
    );
  });
});
