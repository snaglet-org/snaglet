/**
 * Multi-word `@` searches: a space inside the query keeps the list open and
 * searching (`@Automations rech` finds "Automations recheck"), while a space
 * straight after `@` is prose and Escape still dismisses.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { NodeMentionSearch, matchesEveryWord, type AgentMentionHit } from './NodeMentionSearch';

const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';

function threadResponse(query: string): PaletteAugmentedResponse {
  return {
    byKind: {},
    channelsUsed: ['fts'],
    semanticStatus: 'ready',
    coverage: {},
    items: [
      {
        type: 'workspace',
        nodeId: THREAD_ID,
        nodeType: 'thread',
        title: 'Automations recheck',
        subtitle: null,
        icon: null,
        score: 1,
        archived: false,
      },
    ],
    filesystem: [],
    files: [],
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
      instant: enabled && query.trim() ? threadResponse(query) : null,
      enriched: null,
      instantLoading: false,
      enrichmentLoading: false,
    })
  );
});

const suggestions = () => screen.queryByRole('listbox', { name: 'Mention suggestions' });

describe('multi-word @ search', () => {
  it('keeps searching past a space and swaps the typed query for the picked chip', async () => {
    const onChange = vi.fn();
    render(<ChipEditableInput value="" onChange={onChange} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, 'Ask @Automations rech');

    expect(suggestions()).toBeInTheDocument();
    expect(screen.getByText('Search: Automations rech')).toBeInTheDocument();
    expect(mocks.tieredSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'Automations rech', enabled: true })
    );

    fireEvent.mouseDown(await screen.findByRole('option', { name: /Automations recheck/ }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(`Ask [Automations recheck](${THREAD_ID}) `)
    );
    expect(suggestions()).not.toBeInTheDocument();
  });

  it('treats a space straight after @ as prose, not a search', async () => {
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@');
    expect(suggestions()).toBeInTheDocument();
    await userEvent.type(input, ' ');
    expect(suggestions()).not.toBeInTheDocument();
    await userEvent.type(input, 'then words');
    expect(suggestions()).not.toBeInTheDocument();
  });

  it('stays dismissed after Escape while the same query keeps growing', async () => {
    render(<ChipEditableInput value="" onChange={vi.fn()} multiline ariaLabel="Prompt" />);
    const input = await screen.findByRole('textbox', { name: 'Prompt' });
    await userEvent.type(input, '@Automations');
    expect(suggestions()).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(suggestions()).not.toBeInTheDocument();
    await userEvent.type(input, ' rech');
    expect(suggestions()).not.toBeInTheDocument();
  });
});

describe('matchesEveryWord', () => {
  it('needs every word, in any order and any case', () => {
    expect(matchesEveryWord('Clio Researcher', 'res clio')).toBe(true);
    expect(matchesEveryWord('Clio Researcher', 'CLIO')).toBe(true);
    expect(matchesEveryWord('Clio Researcher', 'clio writer')).toBe(false);
    expect(matchesEveryWord('Clio Researcher', '  ')).toBe(true);
  });

  it('filters roster agents by every word of a multi-word query', () => {
    mocks.tieredSearch.mockReturnValue({
      instant: null,
      enriched: null,
      instantLoading: false,
      enrichmentLoading: false,
    });
    const agent = (id: string, name: string, role: string): AgentMentionHit => ({
      type: 'agent',
      key: id,
      label: name,
      subtitle: role,
      prefix: false,
      agent: { id, name, handle: null, role },
    });
    render(
      <NodeMentionSearch
        open
        anchorRect={{ left: 0, top: 0, bottom: 10, width: 1 }}
        query="research agent"
        agentOptions={[
          agent('test-agent-a', 'Test Agent A', 'Research helper'),
          agent('test-agent-b', 'Test Agent B', 'Writer'),
        ]}
        onlyKinds={['agent']}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole('option', { name: /Test Agent A/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Test Agent B/ })).not.toBeInTheDocument();
  });
});
