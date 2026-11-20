import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaletteWorkspaceItem } from '@desktop/utils/api/palette-search';

const useTieredSearchMock = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/hooks/useTieredSearch.js', () => ({
  useTieredSearch: useTieredSearchMock,
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

import { NodeMentionSearch, type AgentMentionHit } from './NodeMentionSearch';

const ANCHOR = { left: 20, top: 20, bottom: 30, width: 1 };

function localAgent(id: string, name: string, role: string | null): AgentMentionHit {
  return {
    type: 'agent',
    key: id,
    label: name,
    subtitle: role,
    prefix: false,
    agent: { id, name, handle: null, role },
  };
}

function serverAgent(nodeId: string, title: string): PaletteWorkspaceItem {
  return {
    type: 'workspace',
    nodeId,
    nodeType: 'agent',
    title,
    subtitle: null,
    icon: null,
    score: 1,
    archived: false,
  };
}

beforeEach(() => {
  useTieredSearchMock.mockReset();
  useTieredSearchMock.mockReturnValue({
    instant: {
      byKind: {},
      channelsUsed: ['fts'],
      semanticStatus: 'ready',
      coverage: {},
      items: [
        serverAgent('test-agent-a', 'Test Agent A'),
        serverAgent('test-agent-b', 'Test Agent B'),
      ],
      filesystem: [],
      files: [],
      meta: { query: 'test', kinds: ['agent'], workspaceCount: 2, filesystemCount: 0 },
    },
    enriched: null,
    instantLoading: false,
    enrichmentLoading: false,
  });
});

describe('NodeMentionSearch agent rows', () => {
  it('lists an agent once when both the roster and the palette search return it', () => {
    render(
      <NodeMentionSearch
        open
        query="Test"
        anchorRect={ANCHOR}
        agentOptions={[localAgent('test-agent-a', 'Test Agent A', 'Test role')]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const rowsA = screen.getAllByRole('option', { name: /Test Agent A/ });
    expect(rowsA).toHaveLength(1);
    // The surviving row is the roster's, which carries the role.
    expect(rowsA[0]).toHaveTextContent('Test role');
    // An agent only the palette found still shows.
    expect(screen.getAllByRole('option', { name: /Test Agent B/ })).toHaveLength(1);
  });
});
