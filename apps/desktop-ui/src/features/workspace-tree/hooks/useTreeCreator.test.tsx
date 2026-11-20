/**
 * useTreeCreator — the tree's inline create flow. Covers the thread path:
 * which pickers offer a thread, and how a create that succeeds only partly
 * (thread made, an agent not added) is resolved without a duplicating retry;
 * and the table path: offered exactly where a thread is, it opens an inline
 * name row in the scope's Tables group and creates the table on commit;
 * the project path: a container created with category 'project'; and where a
 * root-level draft row is drawn.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadSummary } from '../../../utils/api';

vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', '/api');
  vi.stubEnv('VITE_APP_NAME', 'Snaglet');
});

const api = vi.hoisted(() => ({
  threads: { createInProjectWithAgents: vi.fn() },
  containers: { create: vi.fn() },
  docs: { create: vi.fn() },
  tables: { create: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({
  containersApi: api.containers,
  docsApi: api.docs,
  tablesApi: api.tables,
}));

const emitTableEvent = vi.hoisted(() => vi.fn());
vi.mock('../../database/tableEvents', () => ({ emitTableEvent }));
vi.mock('../../../utils/api/threads', () => ({ threadsApi: api.threads }));
vi.mock('../undo/workspaceUndo', () => ({ recordCreate: vi.fn() }));

import { useTreeCreator } from './useTreeCreator';

const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const createdThread = { id: THREAD_ID, projectId: PROJECT_ID } as ThreadSummary;

function setup({ withTables = false }: { withTables?: boolean } = {}) {
  const setExpanded = vi.fn();
  const setReloadKey = vi.fn();
  const reportError = vi.fn();
  const openTable = vi.fn<(tableId: string) => void>();
  const onCreated = vi.fn<(id: string) => void>();
  const hook = renderHook(() =>
    useTreeCreator({
      setExpanded,
      setReloadKey,
      reportError,
      openTable: withTables ? openTable : undefined,
      onCreated,
    })
  );
  return { ...hook, setExpanded, setReloadKey, reportError, openTable, onCreated };
}

/** The expansion set a `setExpanded(updater)` call produces from `prev`. */
function expandedAfter(
  setExpanded: { mock: { calls: unknown[][] } },
  prev: Set<string>
): Set<string> {
  const { calls } = setExpanded.mock;
  const update = calls[calls.length - 1]?.[0] as (prev: Set<string>) => Set<string>;
  return update(prev);
}

/** Walk picker → editing → committed title for a thread under `parentId`. */
async function draftThread(
  result: ReturnType<typeof setup>['result'],
  parentId: string | null,
  category: 'project' | null
) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  act(() => result.current.openPicker(parentId, anchor, category));
  act(() => result.current.selectKind('thread'));
  await act(() => result.current.commitCreator('My thread'));
}

beforeEach(() => {
  vi.resetAllMocks();
  api.threads.createInProjectWithAgents.mockResolvedValue({
    thread: createdThread,
    failedAgentIds: [],
  });
});

describe('useTreeCreator — creatable kinds', () => {
  it('offers a thread at the root and inside a project, not in a plain folder', () => {
    const { result } = setup();
    const anchor = document.createElement('button');

    act(() => result.current.openPicker(null, anchor, null));
    expect(result.current.creatableKinds).toContain('thread');

    act(() => result.current.openPicker(PROJECT_ID, anchor, 'project'));
    expect(result.current.creatableKinds).toContain('thread');

    act(() => result.current.openPicker('container-2222222222222-bbbbbbbbb', anchor, null));
    expect(result.current.creatableKinds).not.toContain('thread');
    expect(result.current.creatableKinds).toEqual(['container', 'project', 'doc']);
  });

  it('offers a table exactly where it offers a thread, once a draft pane can open', () => {
    const anchor = document.createElement('button');
    const withoutPane = setup();
    act(() => withoutPane.result.current.openPicker(null, anchor, null));
    expect(withoutPane.result.current.creatableKinds).not.toContain('table');

    const { result } = setup({ withTables: true });
    act(() => result.current.openPicker(null, anchor, null));
    expect(result.current.creatableKinds).toEqual([
      'container',
      'project',
      'doc',
      'thread',
      'table',
    ]);

    act(() => result.current.openPicker(PROJECT_ID, anchor, 'project'));
    expect(result.current.creatableKinds).toEqual([
      'container',
      'project',
      'doc',
      'thread',
      'table',
    ]);

    act(() => result.current.openPicker('container-2222222222222-bbbbbbbbb', anchor, null));
    expect(result.current.creatableKinds).toEqual(['container', 'project', 'doc']);
  });
});

describe('useTreeCreator — root drafts', () => {
  it('opens the Docs & context group for a root doc, not for a root project', () => {
    const { result, setExpanded } = setup();
    const anchor = document.createElement('button');

    act(() => result.current.openPicker(null, anchor, null));
    act(() => result.current.selectKind('doc'));
    expect(expandedAfter(setExpanded, new Set())).toEqual(new Set(['workspace/items']));

    setExpanded.mockClear();
    act(() => result.current.openPicker(null, anchor, null));
    act(() => result.current.selectKind('project'));
    expect(setExpanded).not.toHaveBeenCalled();
    expect(result.current.creator).toEqual({
      stage: 'editing',
      parentContainerId: null,
      kind: 'project',
    });
  });
});

describe('useTreeCreator — project', () => {
  it('creates a project wherever a container can go, including inside a plain folder', async () => {
    const { result, setReloadKey } = setup();
    const folderId = 'container-2222222222222-bbbbbbbbb';
    api.containers.create.mockResolvedValue({ id: 'container-3333333333333-ccccccccc' });
    const anchor = document.createElement('button');

    act(() => result.current.openPicker(folderId, anchor, null));
    act(() => result.current.selectKind('project'));
    await act(() => result.current.commitCreator('  My project  '));

    expect(api.containers.create).toHaveBeenCalledWith({
      name: 'My project',
      parentId: folderId,
      category: 'project',
    });
    expect(setReloadKey).toHaveBeenCalled();
  });

  it('keeps a plain container uncategorized', async () => {
    const { result } = setup();
    api.containers.create.mockResolvedValue({ id: 'container-3333333333333-ccccccccc' });
    act(() => result.current.openPicker(null, document.createElement('button'), null));
    act(() => result.current.selectKind('container'));
    await act(() => result.current.commitCreator('Folder'));
    expect(api.containers.create).toHaveBeenCalledWith({ name: 'Folder', parentId: null });
  });
});

describe('useTreeCreator — table', () => {
  it('opens a name row in the project Tables group, expanding it', () => {
    const { result, setExpanded } = setup({ withTables: true });
    act(() => result.current.openPicker(PROJECT_ID, document.createElement('button'), 'project'));
    act(() => result.current.selectKind('table'));

    expect(result.current.creator).toEqual({
      stage: 'editing',
      parentContainerId: PROJECT_ID,
      kind: 'table',
    });
    expect([...expandedAfter(setExpanded, new Set(['other']))].sort()).toEqual(
      ['other', PROJECT_ID, `${PROJECT_ID}/tables`].sort()
    );
  });

  it('opens a workspace-level name row from the root picker', () => {
    const { result, setExpanded } = setup({ withTables: true });
    act(() => result.current.openPicker(null, document.createElement('button'), null));
    act(() => result.current.selectKind('table'));

    expect(result.current.creator).toMatchObject({ parentContainerId: null, kind: 'table' });
    expect([...expandedAfter(setExpanded, new Set())]).toEqual(['workspace/tables']);
  });

  it('never links a table to a plain folder', () => {
    const { result } = setup({ withTables: true });
    act(() =>
      result.current.openPicker(
        'container-2222222222222-bbbbbbbbb',
        document.createElement('button'),
        null
      )
    );
    act(() => result.current.selectKind('table'));
    expect(result.current.creator).toMatchObject({ parentContainerId: null, kind: 'table' });
  });

  it('creates the table in its scope on commit, announces it and opens it', async () => {
    const table = { id: 'table-1234567890123-abc', name: 'Roasts' };
    api.tables.create.mockResolvedValue({ table });
    const { result, openTable } = setup({ withTables: true });
    act(() => result.current.startScopedDraft('table', PROJECT_ID));
    await act(() => result.current.commitCreator('  Roasts  '));

    expect(api.tables.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Roasts', projectId: PROJECT_ID })
    );
    expect(emitTableEvent).toHaveBeenCalledWith({ type: 'table.created', table });
    expect(openTable).toHaveBeenCalledWith(table.id);
    expect(result.current.creator).toBeNull();
  });

  it('creates nothing when the name is blank', async () => {
    const { result } = setup({ withTables: true });
    act(() => result.current.startScopedDraft('table', null));
    await act(() => result.current.commitCreator('   '));
    expect(api.tables.create).not.toHaveBeenCalled();
    expect(result.current.creator).toBeNull();
  });
});

describe('useTreeCreator — thread placement', () => {
  it('drafts a thread inside its scope Threads group and expands it', () => {
    const { result, setExpanded } = setup();
    act(() => result.current.openPicker(PROJECT_ID, document.createElement('button'), 'project'));
    act(() => result.current.selectKind('thread'));

    expect(result.current.creator).toMatchObject({ parentContainerId: PROJECT_ID, kind: 'thread' });
    expect([...expandedAfter(setExpanded, new Set())].sort()).toEqual(
      [PROJECT_ID, `${PROJECT_ID}/threads`].sort()
    );
  });

  it('expands the workspace Threads group for a root thread', () => {
    const { result, setExpanded } = setup();
    act(() => result.current.openPicker(null, document.createElement('button'), null));
    act(() => result.current.selectKind('thread'));
    expect([...expandedAfter(setExpanded, new Set())]).toEqual(['workspace/threads']);
  });
});

describe('useTreeCreator — pending thread', () => {
  it('creates the thread in the project with every chosen agent and reloads the tree', async () => {
    const { result, setReloadKey, reportError } = setup();
    await draftThread(result, PROJECT_ID, 'project');
    expect(result.current.pendingThread).toEqual({ title: 'My thread', projectId: PROJECT_ID });

    await act(() => result.current.commitPendingThread(['test-agent-a', 'test-agent-b']));

    expect(api.threads.createInProjectWithAgents).toHaveBeenCalledWith('My thread', PROJECT_ID, [
      'test-agent-a',
      'test-agent-b',
    ]);
    expect(result.current.pendingThread).toBeNull();
    expect(setReloadKey).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('creates a flat thread from the root picker', async () => {
    const { result } = setup();
    await draftThread(result, null, null);
    await act(() => result.current.commitPendingThread(['test-agent-a']));
    expect(api.threads.createInProjectWithAgents).toHaveBeenCalledWith('My thread', null, [
      'test-agent-a',
    ]);
  });

  it('closes the picker and reports the shortfall when an agent did not join the created thread', async () => {
    api.threads.createInProjectWithAgents.mockResolvedValue({
      thread: createdThread,
      failedAgentIds: ['test-agent-b'],
    });
    const { result, setReloadKey, reportError } = setup();
    await draftThread(result, PROJECT_ID, 'project');

    await act(() => result.current.commitPendingThread(['test-agent-a', 'test-agent-b']));

    // The thread exists: keeping the picker open would offer a retry that
    // creates a duplicate. Close it, reveal the thread, say what is missing.
    expect(result.current.pendingThread).toBeNull();
    expect(setReloadKey).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.stringMatching(/created without 1 agent\b/));
  });

  it('rejects a create failure so the picker stays open with the error', async () => {
    api.threads.createInProjectWithAgents.mockRejectedValue(new Error('Project not found'));
    const { result, setReloadKey, reportError } = setup();
    await draftThread(result, PROJECT_ID, 'project');

    await expect(act(() => result.current.commitPendingThread(['test-agent-a']))).rejects.toThrow(
      'Project not found'
    );

    expect(result.current.pendingThread).toEqual({ title: 'My thread', projectId: PROJECT_ID });
    expect(setReloadKey).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('refuses an empty agent selection before calling the API', async () => {
    const { result } = setup();
    await draftThread(result, PROJECT_ID, 'project');
    await expect(act(() => result.current.commitPendingThread([]))).rejects.toThrow(
      'Select at least one agent'
    );
    expect(api.threads.createInProjectWithAgents).not.toHaveBeenCalled();
  });
});

describe('useTreeCreator — hands a saved item to the tree to open', () => {
  const NEW_ID = 'doc-3333333333333-ccccccccc';

  /** Walk picker → editing for `kind` at the root, then commit `name`. */
  async function draft(
    result: ReturnType<typeof setup>['result'],
    kind: 'container' | 'project' | 'doc',
    name: string
  ) {
    act(() => result.current.openPicker(null, document.createElement('button'), null));
    act(() => result.current.selectKind(kind));
    await act(() => result.current.commitCreator(name));
  }

  it.each(['container', 'project'] as const)('opens a created %s', async (kind) => {
    api.containers.create.mockResolvedValue({ id: NEW_ID });
    const { result, onCreated } = setup();
    await draft(result, kind, 'Plans');
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(NEW_ID);
  });

  it('opens a created doc', async () => {
    api.docs.create.mockResolvedValue({ id: NEW_ID });
    const { result, onCreated } = setup();
    await draft(result, 'doc', 'Plans');
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(NEW_ID);
  });

  it('opens a created thread once its agents are picked, even when one did not join', async () => {
    const { result, onCreated } = setup();
    await draftThread(result, PROJECT_ID, 'project');
    // Naming a thread does not create it yet: the agent picker comes first.
    expect(onCreated).not.toHaveBeenCalled();

    api.threads.createInProjectWithAgents.mockResolvedValue({
      thread: createdThread,
      failedAgentIds: ['test-agent-b'],
    });
    await act(() => result.current.commitPendingThread(['test-agent-a', 'test-agent-b']));
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(THREAD_ID);
  });

  it('opens nothing for a blank name, a canceled draft or a failed create', async () => {
    const { result, onCreated, reportError } = setup();
    await draft(result, 'doc', '   ');

    act(() => result.current.openPicker(null, document.createElement('button'), null));
    act(() => result.current.selectKind('doc'));
    act(() => result.current.cancelCreator());

    api.docs.create.mockRejectedValue(new Error('Server unreachable'));
    await draft(result, 'doc', 'Plans');
    expect(reportError).toHaveBeenCalledWith('Create failed: Server unreachable');

    expect(onCreated).not.toHaveBeenCalled();
  });

  it('opens no thread when its create fails or its agent picker is canceled', async () => {
    const { result, onCreated } = setup();
    await draftThread(result, PROJECT_ID, 'project');
    act(() => result.current.cancelPendingThread());

    api.threads.createInProjectWithAgents.mockRejectedValue(new Error('Project not found'));
    await draftThread(result, PROJECT_ID, 'project');
    await expect(act(() => result.current.commitPendingThread(['test-agent-a']))).rejects.toThrow(
      'Project not found'
    );

    expect(onCreated).not.toHaveBeenCalled();
  });
});
