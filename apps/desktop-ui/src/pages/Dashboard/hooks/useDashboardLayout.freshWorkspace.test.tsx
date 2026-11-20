/**
 * A saved layout belongs to the workspace it was saved for. One saved for
 * another workspace (after a reset, a restore, or a new Snaglet home), or one
 * whose items are all gone, gives way to the launch panes: Home first, Get
 * started to its right, Home keeping the focus. A layout saved for this
 * workspace, or saved before layouts carried a workspace id, stays as it was.
 * After a reset in this window, the panes give way the same way.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTreeChild } from '@desktop/utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

vi.mock('@desktop/features/featureFlags/FeatureFlagsContext', () => ({
  useFeatureFlag: (name: string) => name === 'hub_home',
  useFeatureFlagsSettled: () => true,
}));

const server = vi.hoisted(() => ({
  workspaceId: 'workspace-new' as string | null,
  tree: [] as LibraryTreeChild[],
  archived: [] as string[],
  archiveReads: 0,
}));

vi.mock('@desktop/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/utils/api')>();
  return {
    ...actual,
    containersApi: { ...actual.containersApi, listTree: async () => server.tree },
    settingsApi: {
      ...actual.settingsApi,
      get: async (category: string, key: string) => {
        if (category !== 'workspace' || key !== 'id') throw new Error('unexpected read');
        return { category, key, value: server.workspaceId };
      },
    },
    archiveApi: {
      ...actual.archiveApi,
      list: async () => {
        server.archiveReads += 1;
        return { roots: server.archived.map((id) => ({ id })), children: [] };
      },
    },
  };
});

vi.mock('@desktop/features/onboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@desktop/features/onboarding')>();
  return {
    ...actual,
    refreshOnboarding: async () => ({
      status: 'ready',
      seed: { status: 'done' },
      progress: {},
      provider: { kind: 'none' },
    }),
  };
});

import { useDashboardLayout } from './useDashboardLayout';
import { findLeaf, leafIds } from '../layout/paneTree';
import { LAYOUT_STORAGE_KEY, LAYOUT_STORAGE_VERSION } from '../persistence';

const docSelection = { kind: 'doc', doc_id: 'doc-1111111111111-aaaaaaaaa' } as const;
const LAUNCH_PANES = [{ kind: 'hub' }, { kind: 'get-started' }];

function storeLayout(workspaceId?: string) {
  const leaf = {
    kind: 'leaf',
    id: 'leaf-restored',
    selection: docSelection,
    history: { entries: [docSelection], index: 0 },
  };
  window.localStorage.setItem(
    LAYOUT_STORAGE_KEY,
    JSON.stringify({
      version: LAYOUT_STORAGE_VERSION,
      layout: leaf,
      activeLeafId: 'leaf-restored',
      ...(workspaceId ? { workspaceId } : {}),
    })
  );
}

function docNode(id: string): LibraryTreeChild {
  return {
    kind: 'doc',
    id,
    containerId: null,
    title: 'Plans',
    content: '',
    sortOrder: 0,
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:00:00.000Z',
  } as LibraryTreeChild;
}

function selections(result: { current: ReturnType<typeof useDashboardLayout> }) {
  const { layout } = result.current;
  return leafIds(layout).map((id) => {
    const selection = findLeaf(layout, id)?.selection ?? null;
    return selection && 'doc_id' in selection
      ? { kind: selection.kind, doc_id: selection.doc_id }
      : selection;
  });
}

/** Let the launch reads (workspace id, tree, archive, first-run state) land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

const initialWidth = window.innerWidth;

beforeEach(() => {
  server.workspaceId = 'workspace-new';
  server.tree = [docNode(docSelection.doc_id)];
  server.archived = [];
  server.archiveReads = 0;
  setWindowWidth(1280);
  window.localStorage.clear();
});

afterEach(() => {
  setWindowWidth(initialWidth);
  window.localStorage.clear();
});

describe('useDashboardLayout and the workspace a layout was saved for', () => {
  it('opens Home with Get started to its right in place of a layout saved for another workspace', async () => {
    storeLayout('workspace-old');
    const { result } = renderHook(() => useDashboardLayout());
    // The saved layout shows until the workspace id is read.
    expect(selections(result)).toEqual([docSelection]);

    await waitFor(() => expect(selections(result)).toEqual(LAUNCH_PANES));
    const [homeLeafId] = leafIds(result.current.layout);
    expect(result.current.activeLeafId).toBe(homeLeafId);
    // The next save carries the new workspace's id.
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}')).toMatchObject({
        workspaceId: 'workspace-new',
      })
    );
  });

  it('opens Get started alone in a narrow window in place of a stale layout', async () => {
    setWindowWidth(900);
    storeLayout('workspace-old');
    const { result } = renderHook(() => useDashboardLayout());
    await waitFor(() => expect(selections(result)).toEqual([{ kind: 'get-started' }]));
  });

  it('restores a layout saved for this workspace', async () => {
    storeLayout('workspace-new');
    const { result } = renderHook(() => useDashboardLayout());
    await settle();
    expect(selections(result)).toEqual([docSelection]);
  });

  it('keeps a layout saved before layouts carried a workspace id, and stamps it', async () => {
    storeLayout();
    const { result } = renderHook(() => useDashboardLayout());
    await settle();
    expect(selections(result)).toEqual([docSelection]);
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}')).toMatchObject({
        workspaceId: 'workspace-new',
      })
    );
  });

  it('keeps the layout while the workspace id cannot be read', async () => {
    server.workspaceId = null;
    storeLayout('workspace-old');
    const { result } = renderHook(() => useDashboardLayout());
    await settle();
    expect(selections(result)).toEqual([docSelection]);
  });

  it('opens the launch panes in place of a layout whose items are all gone', async () => {
    server.tree = [];
    storeLayout();
    const { result } = renderHook(() => useDashboardLayout());
    await waitFor(() => expect(selections(result)).toEqual(LAUNCH_PANES));
    expect(server.archiveReads).toBe(1);
  });

  it('keeps a layout whose missing item was archived, since its pane says so', async () => {
    server.tree = [];
    server.archived = [docSelection.doc_id];
    storeLayout();
    const { result } = renderHook(() => useDashboardLayout());
    await settle();
    expect(selections(result)).toEqual([docSelection]);
  });

  it('reads no archive while the tree still lists a restored item', async () => {
    storeLayout();
    renderHook(() => useDashboardLayout());
    await settle();
    expect(server.archiveReads).toBe(0);
  });

  it('opens the launch panes after a reset, stamped with the new workspace id', async () => {
    storeLayout('workspace-new');
    const { result } = renderHook(() => useDashboardLayout());
    await settle();
    expect(selections(result)).toEqual([docSelection]);

    server.workspaceId = 'workspace-after-reset';
    act(() => result.current.reopenForNewContent());
    await waitFor(() => expect(selections(result)).toEqual(LAUNCH_PANES));
    expect(result.current.activeLeafId).toBe(leafIds(result.current.layout)[0]);
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}')).toMatchObject({
        workspaceId: 'workspace-after-reset',
      })
    );
  });
});
