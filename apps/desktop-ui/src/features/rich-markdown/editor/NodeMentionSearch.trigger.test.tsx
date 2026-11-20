import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useTieredSearchMock = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/hooks/useTieredSearch.js', () => ({
  useTieredSearch: useTieredSearchMock,
  stableMergeById: <T,>(instant: readonly T[], enriched: readonly T[]) => [...instant, ...enriched],
}));

import { NodeMentionSearch, type NodeMentionSearchHandle } from './NodeMentionSearch';

const triggers = [
  { value: 'message:create', label: 'Message created' },
  { value: 'agent:create', label: 'Agent created' },
  { value: 'agent:update', label: 'Agent updated' },
  { value: 'agent:delete', label: 'Agent deleted' },
] as const;

beforeEach(() => {
  useTieredSearchMock.mockReset();
  useTieredSearchMock.mockReturnValue({
    instant: null,
    enriched: null,
    instantLoading: false,
    enrichmentLoading: false,
  });
});

describe('NodeMentionSearch trigger lane', () => {
  it('lists locally supplied triggers and never enables workspace search', () => {
    render(
      <NodeMentionSearch
        open
        query="trigger:agent"
        anchorRect={{ left: 20, top: 20, bottom: 30, width: 1 }}
        triggerOptions={triggers}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryByText('Message created')).not.toBeInTheDocument();
    expect(useTieredSearchMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('does not reserve trigger: for rich mention callers that did not opt in', () => {
    render(
      <NodeMentionSearch
        open
        query="trigger:agent"
        anchorRect={{ left: 20, top: 20, bottom: 30, width: 1 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(useTieredSearchMock).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'trigger:agent', enabled: true })
    );
    expect(screen.queryByText('No matching triggers')).not.toBeInTheDocument();
  });

  it('filters case-insensitively and commits the selected runtime value', () => {
    const onSelect = vi.fn();
    render(
      <NodeMentionSearch
        open
        query="TRIGGER:update"
        anchorRect={{ left: 20, top: 20, bottom: 30, width: 1 }}
        triggerOptions={triggers}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );

    fireEvent.mouseDown(screen.getByRole('option', { name: /agent updated/i }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'trigger', trigger: 'agent:update' })
    );
  });

  it('supports keyboard commit and escape through the shared handle', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const ref = createRef<NodeMentionSearchHandle>();
    render(
      <NodeMentionSearch
        ref={ref}
        open
        query="trigger:delete"
        anchorRect={{ left: 20, top: 20, bottom: 30, width: 1 }}
        triggerOptions={triggers}
        onSelect={onSelect}
        onClose={onClose}
      />
    );

    expect(ref.current?.handleKeyDown?.(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'agent:delete' }));
    expect(ref.current?.handleKeyDown?.(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(
      true
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps workspace-only code search scoped and rejects raw filesystem results defensively', () => {
    useTieredSearchMock.mockReturnValue({
      instant: {
        byKind: {},
        channelsUsed: ['fts'],
        semanticStatus: 'ready',
        coverage: {},
        items: [
          {
            type: 'workspace',
            nodeId: 'doc-safe',
            nodeType: 'doc',
            title: 'Safe hook doc',
            subtitle: null,
            icon: null,
            score: 1,
            archived: false,
          },
          {
            type: 'filesystem',
            filesystemKind: 'file',
            name: 'secret.txt',
            path: '/private/secret.txt',
            subtitle: null,
            score: 1,
          },
        ],
        filesystem: [],
        files: [],
        meta: { query: 'hook', kinds: ['doc'], workspaceCount: 1, filesystemCount: 1 },
      },
      enriched: null,
      instantLoading: false,
      enrichmentLoading: false,
    });

    render(
      <NodeMentionSearch
        open
        query="doc:hook"
        anchorRect={{ left: 20, top: 20, bottom: 30, width: 1 }}
        workspaceOnly
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('option', { name: /safe hook doc/i })).toBeVisible();
    expect(screen.queryByText('/private/secret.txt')).not.toBeInTheDocument();
    expect(useTieredSearchMock).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['doc'] }));
  });
});
