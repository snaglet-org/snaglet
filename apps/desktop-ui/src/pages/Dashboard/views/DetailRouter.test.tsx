/**
 * DetailRouter pane states: the empty pane, per-item view keys, and a
 * workspace selection whose node never hydrates (archived, deleted, or not in
 * the tree the dashboard read).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { WebSocketContext, type WsContextValue } from '@desktop/ws/WebSocketContext';
import type { DetailSelection } from '../selection/types';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const counts = vi.fn();
const listTree = vi.fn();
vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    archiveApi: { ...actual.archiveApi, counts: (id: string) => counts(id) },
    containersApi: { ...actual.containersApi, listTree: () => listTree() },
  };
});

const stubs = await vi.hoisted(async () => {
  const { createElement, useState } = await import('react');
  /** A stand-in view that remembers which item it was first mounted for. */
  const stubView =
    (label: string) =>
    ({ node }: { node: { id: string } }) => {
      const [mountedFor] = useState(node.id);
      return createElement('div', null, `${label} ${node.id} (mounted for ${mountedFor})`);
    };
  /** A stand-in table draft that shows the scope it was given. */
  const draftView = ({ draftId, projectId }: { draftId: string; projectId?: string | null }) =>
    createElement('div', null, `draft ${draftId} in ${projectId ?? 'workspace'}`);
  /** A stand-in tool pane whose button stands for a finished Create tool. */
  const toolPane = ({
    create,
    onReplaceSelection,
  }: {
    create?: boolean;
    onReplaceSelection?: (selection: { kind: 'tool-create' }) => void;
  }) =>
    create
      ? createElement(
          'button',
          { onClick: () => onReplaceSelection?.({ kind: 'tool-create' }) },
          'tool pane created'
        )
      : null;
  return { stubView, draftView, toolPane, nothing: () => null };
});
vi.mock('./DocView', () => ({ DocView: stubs.stubView('doc') }));
vi.mock('./ImageView', () => ({ ImageView: stubs.stubView('image') }));
vi.mock('./ContainerView', () => {
  const View = stubs.stubView('container');
  return {
    ContainerView: ({ container }: { container: { id: string } }) => View({ node: container }),
  };
});
vi.mock('./AgentView', async () => {
  const { createElement } = await import('react');
  return {
    AgentView: ({
      agent,
      focusTab,
      focusRequestId,
    }: {
      agent: { id: string };
      focusTab?: string;
      focusRequestId?: number;
    }) =>
      createElement(
        'div',
        null,
        `agent ${agent.id} tab ${focusTab ?? 'none'} request ${focusRequestId ?? 'none'}`
      ),
  };
});
vi.mock('./ChatView', () => ({ ChatView: stubs.nothing }));
vi.mock('./DmView', async () => {
  const { createElement } = await import('react');
  return {
    DmView: ({ threadId }: { threadId: string }) =>
      createElement('div', { 'data-testid': 'dm-view' }, `dm ${threadId}`),
  };
});
vi.mock('./FileView', () => ({ FileView: stubs.nothing }));
vi.mock('./ProfileView', () => ({ ProfileView: stubs.nothing }));
vi.mock('./StorageView', () => ({ StorageView: stubs.nothing }));
vi.mock('./ProvidersView', () => ({ ProvidersView: stubs.nothing }));
vi.mock('./McpConnections', () => ({
  McpClientConnectionView: stubs.nothing,
  McpServerConnectionView: stubs.nothing,
}));
vi.mock('./DataSearchView', () => ({ DataSearchView: stubs.nothing }));
vi.mock('./CliSettingsView', () => ({ CliSettingsView: stubs.nothing }));
vi.mock('./ThemeView', () => ({ ThemeView: stubs.nothing }));
vi.mock('./ToolView', () => ({ ToolPane: stubs.toolPane }));
vi.mock('./HookBuilderView', () => ({ HookBuilderView: stubs.nothing }));
vi.mock('./TableView', () => ({ TableView: stubs.nothing, TableDraftView: stubs.draftView }));
// Flag-aware mock: everything off (the product default).
vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: () => false,
}));

import { DetailRouter } from './DetailRouter';
import { UNRESOLVED_ITEM_GRACE_MS, UNRESOLVED_ITEM_RETRY_MS } from './UnresolvedWorkspaceItem';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { onArchivedDrawerRequest } from './archivedDrawerRequest';
import { FetchError } from '@desktop/utils/api';
import { useRemovedNodeSync } from '../hooks/useWorkspaceEventSync';
import { createLeaf, findLeaf, leafIds, splitLeaf, type LayoutNode } from '../layout/paneTree';

const timestamp = '2026-01-01T00:00:00.000Z';
const docNode = (id: string): Extract<LibraryTreeChild, { kind: 'doc' }> => ({
  kind: 'doc',
  id,
  containerId: null,
  title: 'Doc',
  content: '',
  sortOrder: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const imageNode = (id: string): Extract<LibraryTreeChild, { kind: 'image' }> => ({
  kind: 'image',
  id,
  containerId: null,
  name: 'Image',
  description: null,
  tags: [],
  mimeType: 'image/png',
  sizeBytes: 1,
  sortOrder: 0,
  url: `/api/images/${id}/content`,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const containerNode = (id: string): Extract<LibraryTreeChild, { kind: 'container' }> => ({
  kind: 'container',
  id,
  parentId: null,
  name: 'Folder',
  sortOrder: 0,
  category: null,
  folderPath: null,
  githubUrl: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  children: [],
});
const archivedRow = (id: string, archived: boolean) => ({
  node: {
    id,
    type: 'doc',
    title: 'Doc',
    archived,
    archived_at: archived ? timestamp : null,
    container_id: null,
    sort_order: 0,
    created_at: timestamp,
    updated_at: timestamp,
  },
  counts: { sub_containers: 0, docs: 0, projects: 0, threads: 0, messages: 0, memories: 0 },
});

function withSocket(state: WsContextValue['connectionState'], children: ReactNode) {
  const value = { connectionState: state } as WsContextValue;
  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

afterEach(() => {
  counts.mockReset();
  listTree.mockReset();
});

describe('DetailRouter empty pane', () => {
  it('explains how to open something, including the search shortcut', () => {
    render(<DetailRouter selection={null} />);
    expect(screen.getByText('Nothing open here')).toBeInTheDocument();
    expect(
      screen.getByText(
        /^Open a doc, thread, table or agent from the sidebar, drag one onto this pane, or press (⌘K|Ctrl\+K) to search\.$/
      )
    ).toBeInTheDocument();
  });
});

describe('DetailRouter agent pane', () => {
  const agent = { id: 'test-agent-a', name: 'Ada' } as Extract<
    DetailSelection,
    { kind: 'agent' }
  >['agent'];

  it('hands a named tab and its request id to the agent page', () => {
    render(
      <DetailRouter selection={{ kind: 'agent', agent, focusTab: 'overview', focusRequestId: 7 }} />
    );
    expect(screen.getByText('agent test-agent-a tab overview request 7')).toBeInTheDocument();
  });

  it('opens a plain agent selection with no tab hint', () => {
    render(<DetailRouter selection={{ kind: 'agent', agent }} />);
    expect(screen.getByText('agent test-agent-a tab none request none')).toBeInTheDocument();
  });
});

describe('DetailRouter per-item view keys', () => {
  it.each([
    ['doc', (id: string): DetailSelection => ({ kind: 'doc', doc_id: id, node: docNode(id) })],
    [
      'image',
      (id: string): DetailSelection => ({ kind: 'image', image_id: id, node: imageNode(id) }),
    ],
    [
      'container',
      (id: string): DetailSelection => ({
        kind: 'container',
        container_id: id,
        node: containerNode(id),
      }),
    ],
  ])('remounts the %s view when the pane switches items', (label, select) => {
    const view = render(<DetailRouter selection={select('item-a')} />);
    view.rerender(<DetailRouter selection={select('item-b')} />);
    expect(screen.getByText(`${label} item-b (mounted for item-b)`)).toBeInTheDocument();
  });
});

describe('DetailRouter table draft', () => {
  const draftId = 'table-1111111111111-aaaaaaaaa';

  it('hands the draft its project, or none for a workspace-wide table', () => {
    const projectId = 'container-1111111111111-aaaaaaaaa';
    const view = render(
      <DetailRouter selection={{ kind: 'table-draft', draft_id: draftId, project_id: projectId }} />
    );
    expect(screen.getByText(`draft ${draftId} in ${projectId}`)).toBeInTheDocument();

    view.rerender(<DetailRouter selection={{ kind: 'table-draft', draft_id: draftId }} />);
    expect(screen.getByText(`draft ${draftId} in workspace`)).toBeInTheDocument();
  });
});

describe('DetailRouter new tool', () => {
  it('lets the New tool pane replace its own selection once the tool exists', () => {
    const onReplaceSelection = vi.fn();
    render(
      <DetailRouter selection={{ kind: 'tool-create' }} onReplaceSelection={onReplaceSelection} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'tool pane created' }));

    expect(onReplaceSelection).toHaveBeenCalledTimes(1);
  });
});

describe('DetailRouter unresolved workspace item', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function passGrace() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNRESOLVED_ITEM_GRACE_MS);
    });
  }

  it('shows a calm unavailable state for a deleted item, with a close action', async () => {
    counts.mockRejectedValue(new FetchError('Node not found', 404));
    const onClosePane = vi.fn();
    render(
      <DetailRouter selection={{ kind: 'doc', doc_id: 'doc-gone' }} onClosePane={onClosePane} />
    );
    expect(screen.getByText('Loading workspace item')).toBeInTheDocument();
    expect(counts).not.toHaveBeenCalled();

    await passGrace();

    expect(counts).toHaveBeenCalledTimes(1);
    expect(screen.getByText("This item isn't available")).toBeInTheDocument();
    expect(screen.getByText('It may have been archived or deleted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close pane' }));
    expect(onClosePane).toHaveBeenCalledTimes(1);
  });

  it('offers the Archived drawer for an archived item when a host is listening', async () => {
    counts.mockResolvedValue(archivedRow('doc-archived', true));
    const openDrawer = vi.fn();
    const unsubscribe = onArchivedDrawerRequest(openDrawer);
    render(<DetailRouter selection={{ kind: 'image', image_id: 'doc-archived' }} />);

    await passGrace();

    expect(screen.getByText(/It was archived/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Archived' }));
    expect(openDrawer).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('hands a live node missing from the pane cache back to the pane', async () => {
    counts.mockResolvedValue(archivedRow('doc-live', false));
    listTree.mockResolvedValue([docNode('doc-live')]);
    const onReplaceSelection = vi.fn();
    render(
      <DetailRouter
        selection={{ kind: 'doc', doc_id: 'doc-live' }}
        onReplaceSelection={onReplaceSelection}
      />
    );

    await passGrace();

    expect(onReplaceSelection).toHaveBeenCalledWith({
      kind: 'doc',
      doc_id: 'doc-live',
      node: docNode('doc-live'),
    });
  });

  it('retries a failed lookup when the socket reconnects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    counts.mockRejectedValueOnce(new Error('Failed to fetch'));
    const selection: DetailSelection = { kind: 'container', container_id: 'container-gone' };
    const view = render(withSocket('closed', <DetailRouter selection={selection} />));

    await passGrace();
    expect(screen.getByText(/can't be reached right now/)).toBeInTheDocument();

    counts.mockRejectedValueOnce(new FetchError('Node not found', 404));
    view.rerender(withSocket('open', <DetailRouter selection={selection} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(counts).toHaveBeenCalledTimes(2);
    expect(screen.getByText("This item isn't available")).toBeInTheDocument();
    error.mockRestore();
  });

  it('never stays on Loading after a failed lookup, and retries on its own until it knows', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    counts.mockRejectedValue(new Error('HTTP 502'));
    render(<DetailRouter selection={{ kind: 'doc', doc_id: 'doc-later' }} />);

    await passGrace();
    expect(screen.queryByText('Loading workspace item')).toBeNull();
    expect(screen.getByText("Can't load this item right now")).toBeInTheDocument();
    expect(counts).toHaveBeenCalledTimes(1);

    // First automatic retry after the base delay; still failing.
    await advance(UNRESOLVED_ITEM_RETRY_MS);
    await advance(0);
    expect(counts).toHaveBeenCalledTimes(2);

    // The next one waits longer (backoff), but a tree refresh retries now.
    counts.mockRejectedValue(new FetchError('Node not found', 404));
    act(() => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }));
    await advance(0);
    expect(counts).toHaveBeenCalledTimes(3);
    expect(screen.getByText("This item isn't available")).toBeInTheDocument();

    // Known gone: no more polling.
    await advance(UNRESOLVED_ITEM_RETRY_MS * 20);
    expect(counts).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });

  it('retries from the Try again button', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    counts.mockRejectedValueOnce(new Error('HTTP 502'));
    render(<DetailRouter selection={{ kind: 'doc', doc_id: 'doc-archived' }} />);
    await passGrace();

    counts.mockResolvedValueOnce(archivedRow('doc-archived', true));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await advance(0);

    expect(counts).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/It was archived/)).toBeInTheDocument();
    error.mockRestore();
  });
});

describe('DetailRouter panes under an archived folder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Panes over one layout, kept in step with archives as the dashboard keeps them. */
  function Panes({ initial }: { initial: LayoutNode }) {
    const [layout, setLayout] = useState(initial);
    useRemovedNodeSync(layout, setLayout);
    return leafIds(layout).map((id) => (
      <DetailRouter key={id} selection={findLeaf(layout, id)?.selection ?? null} />
    ));
  }

  function docPanes(...nodes: Array<ReturnType<typeof docNode>>): LayoutNode {
    const [first, ...rest] = nodes;
    let layout: LayoutNode = createLeaf({ kind: 'doc', doc_id: first.id, node: first });
    for (const node of rest) {
      const ids = leafIds(layout);
      layout = splitLeaf(layout, ids[ids.length - 1], 'right', {
        kind: 'doc',
        doc_id: node.id,
        node,
      });
    }
    return layout;
  }

  it('turns open panes on a child and a grandchild to the unavailable notice, not others', async () => {
    // container-1 holds doc-1 and container-2, which holds doc-2.
    const child = { ...docNode('doc-1'), containerId: 'container-1' };
    const grandchild = { ...docNode('doc-2'), containerId: 'container-2' };
    const unrelated = { ...docNode('doc-3'), containerId: 'container-3' };
    render(<Panes initial={docPanes(child, grandchild, unrelated)} />);
    expect(screen.getByText('doc doc-1 (mounted for doc-1)')).toBeInTheDocument();
    expect(screen.getByText('doc doc-2 (mounted for doc-2)')).toBeInTheDocument();

    // The archive cascaded: the live tree keeps only the unrelated doc.
    listTree.mockResolvedValue([unrelated]);
    counts.mockImplementation(async (id: string) => archivedRow(id, true));
    act(() => emitLibraryEvent({ type: 'archive-changed', ids: ['container-1'] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByText('Loading workspace item')).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNRESOLVED_ITEM_GRACE_MS);
    });

    expect(screen.queryByText(/^doc doc-1 /)).toBeNull();
    expect(screen.queryByText(/^doc doc-2 /)).toBeNull();
    expect(screen.getAllByText("This item isn't available")).toHaveLength(2);
    expect(screen.getAllByText(/It was archived/)).toHaveLength(2);
    expect(screen.getByText('doc doc-3 (mounted for doc-3)')).toBeInTheDocument();
  });
});

describe('DetailRouter DM thread', () => {
  it('routes a DM selection to the DM reading pane', () => {
    const threadId = 'thread-dm-1111111111111-aaaaaaaaa';
    render(<DetailRouter selection={{ kind: 'dm', thread_id: threadId }} />);
    expect(screen.getByTestId('dm-view')).toHaveTextContent(`dm ${threadId}`);
  });
});
