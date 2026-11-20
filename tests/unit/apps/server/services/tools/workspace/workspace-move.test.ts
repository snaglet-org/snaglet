import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted)
const mockDocsFindById = jest.fn();
const mockDocsMoveTo = jest.fn();
const mockContainersFindById = jest.fn();
const mockContainersMoveTo = jest.fn();
const mockThreadsFindById = jest.fn();
const mockThreadsMoveTo = jest.fn();
const mockNearestProjectForContainer = jest.fn();
const mockHooksEmit = jest.fn();

jest.mock('@snaglet/db', () => ({
  Docs: { findById: mockDocsFindById, moveTo: mockDocsMoveTo },
  Containers: { findById: mockContainersFindById, moveTo: mockContainersMoveTo },
  Threads: { findById: mockThreadsFindById, moveTo: mockThreadsMoveTo },
  Projects: { nearestProjectForContainer: mockNearestProjectForContainer },
}));
jest.mock('@server/services/HookService', () => ({
  hooks: { emit: (...args: unknown[]) => mockHooksEmit(...args) },
}));

const mockResolveContainerByPath = jest.fn();
const mockResolveNodeByPath = jest.fn();
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveContainerByPath: mockResolveContainerByPath,
  resolveNodeByPath: mockResolveNodeByPath,
}));

import workspaceMove from '@server/services/ToolService/handlers/workspace/moveNode';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface MoveResult {
  success: boolean;
  kind: string;
  moved: {
    id: string;
    new_parent_id: string | null;
    sort_order: number;
  };
  link: string;
}

const asResult = (out: unknown): MoveResult => parseToolResult<MoveResult>(out);

// Destination lookups: `c-…` ids name live plain containers and `project-…`
// ids live project containers; anything else is not a container row.
// Classification lookups still queue their own once-values.
const destinationContainer = async (id: string) =>
  id.startsWith('c-')
    ? { id, name: id, category: null, archived: false }
    : id.startsWith('project-')
      ? { id, name: id, category: 'project', archived: false }
      : null;

describe('workspace_move tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContainersFindById.mockImplementation(destinationContainer);
  });

  it('moves a doc by id to a new parent by id', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'Plan', containerId: 'c-old' });
    mockContainersFindById.mockResolvedValueOnce(null); // d1 is a doc, not a container
    mockDocsMoveTo.mockResolvedValueOnce({
      id: 'd1',
      title: 'Plan',
      containerId: 'c-new',
      sortOrder: 3,
    });

    const out = await workspaceMove({ id: 'd1', new_parent_id: 'c-new' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.kind).toBe('doc');
    expect(result.moved.id).toBe('d1');
    expect(result.moved.new_parent_id).toBe('c-new');
    expect(result.moved.sort_order).toBe(3);
    expect(result.link).toContain('Plan');
    expect(mockDocsMoveTo).toHaveBeenCalledWith('d1', 'c-new', undefined, null);
  });

  it('moves a container by id to root (new_parent_id=null)', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce({ id: 'c1', name: 'Folder' });
    mockContainersMoveTo.mockResolvedValueOnce({
      id: 'c1',
      name: 'Folder',
      parentId: null,
      sortOrder: 0,
    });

    const out = await workspaceMove({ id: 'c1', new_parent_id: null }, {}, {});
    const result = asResult(out);
    expect(result.kind).toBe('container');
    expect(result.moved.new_parent_id).toBeNull();
    expect(mockContainersMoveTo).toHaveBeenCalledWith('c1', null, undefined, null);
  });

  it('resolves new_parent_path to a container id', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd2', title: 'X', containerId: null });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockResolveContainerByPath.mockResolvedValueOnce('c-resolved');
    mockDocsMoveTo.mockResolvedValueOnce({
      id: 'd2',
      title: 'X',
      containerId: 'c-resolved',
      sortOrder: 1,
    });

    const out = await workspaceMove({ id: 'd2', new_parent_path: '/projects/q4' }, {}, {});
    const result = asResult(out);
    expect(mockResolveContainerByPath).toHaveBeenCalledWith('/projects/q4');
    expect(result.moved.new_parent_id).toBe('c-resolved');
  });

  it('treats new_parent_path="/" as root', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd3', title: 'Y', containerId: 'c-old' });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockDocsMoveTo.mockResolvedValueOnce({ id: 'd3', title: 'Y', containerId: null, sortOrder: 0 });

    await workspaceMove({ id: 'd3', new_parent_path: '/' }, {}, {});
    expect(mockDocsMoveTo).toHaveBeenCalledWith('d3', null, undefined, null);
    expect(mockResolveContainerByPath).not.toHaveBeenCalled();
  });

  it('resolves target by path', async () => {
    mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'doc', id: 'd4' });
    // Path branch refetches the node so the archive guard can inspect it.
    mockDocsFindById.mockResolvedValueOnce({ id: 'd4', title: 'Z', containerId: 'c-old' });
    mockDocsMoveTo.mockResolvedValueOnce({
      id: 'd4',
      title: 'Z',
      containerId: 'c-new',
      sortOrder: 5,
    });

    const out = await workspaceMove({ path: '/old/Z', new_parent_id: 'c-new' }, {}, {});
    const result = asResult(out);
    expect(mockResolveNodeByPath).toHaveBeenCalledWith('/old/Z', undefined);
    expect(result.kind).toBe('doc');
    expect(result.moved.id).toBe('d4');
  });

  it('passes sort_order through to moveTo (keeping current parent)', async () => {
    // First findById is classifyId; second is the "keep current parent" lookup.
    // classifyId fetches doc/container/thread in parallel; handler reuses the
    // prefetched source node (single fetch) for the keep-current-parent path.
    mockDocsFindById.mockResolvedValueOnce({ id: 'd5', title: 'S', containerId: 'c1' });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(null);
    mockDocsMoveTo.mockResolvedValueOnce({ id: 'd5', title: 'S', containerId: 'c1', sortOrder: 2 });

    await workspaceMove({ id: 'd5', sort_order: 2 }, {}, {});
    expect(mockDocsMoveTo).toHaveBeenCalledWith('d5', 'c1', 2, null);
  });

  it('reorders within current parent when only sort_order is given', async () => {
    // Single source fetch (reused from classifyId); container stays current.
    mockDocsFindById.mockResolvedValueOnce({ id: 'd6', title: 'R', containerId: 'c-current' });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(null);
    mockDocsMoveTo.mockResolvedValueOnce({
      id: 'd6',
      title: 'R',
      containerId: 'c-current',
      sortOrder: 7,
    });

    await workspaceMove({ id: 'd6', sort_order: 7 }, {}, {});
    expect(mockDocsMoveTo).toHaveBeenCalledWith('d6', 'c-current', 7, null);
  });

  it('throws when neither id nor path is given', async () => {
    await expect(workspaceMove({}, {}, {})).rejects.toThrow(/id.*path/);
  });

  it('throws when both id and path are given', async () => {
    await expect(workspaceMove({ id: 'a', path: '/b' }, {}, {})).rejects.toThrow(/both/);
  });

  it('throws when both new_parent_id and new_parent_path are given', async () => {
    await expect(
      workspaceMove({ id: 'd', new_parent_id: 'a', new_parent_path: '/b' }, {}, {})
    ).rejects.toThrow(/both/);
  });

  it('throws when no destination or sort_order provided', async () => {
    await expect(workspaceMove({ id: 'd' }, {}, {})).rejects.toThrow(/at least one/);
  });

  it('throws when new_parent_path does not resolve', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd', title: 'T', containerId: null });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockResolveContainerByPath.mockResolvedValueOnce(null);

    await expect(workspaceMove({ id: 'd', new_parent_path: '/missing' }, {}, {})).rejects.toThrow(
      /destination container not found/
    );
  });

  it('throws when target node id does not exist', async () => {
    // classifyId runs all three lookups in parallel; every one must miss
    // for the not-found path to throw.
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(null);

    await expect(workspaceMove({ id: 'nope', new_parent_id: null }, {}, {})).rejects.toThrow(
      /not found/
    );
  });

  it('throws when sort_order is not finite', async () => {
    await expect(workspaceMove({ id: 'd', sort_order: NaN }, {}, {})).rejects.toThrow(/sort_order/);
  });

  // thread moves: a thread's parent is its project

  const movedThread = (id: string, title: string, projectId: string | null) => ({
    id,
    title,
    projectId,
    sortOrder: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
  });

  it('moves a thread by id into another project and emits thread:move with both id pairs', async () => {
    // classifyId: doc null, container null, thread hit
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(movedThread('thread-1', 'Chat', 'project-old'));
    mockThreadsMoveTo.mockResolvedValueOnce(movedThread('thread-1', 'Chat', 'project-new'));

    const out = await workspaceMove({ id: 'thread-1', new_parent_id: 'project-new' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.kind).toBe('thread');
    expect(result.moved.id).toBe('thread-1');
    expect(result.moved.new_parent_id).toBe('project-new');
    // prefixed id => self-identifying markdown link
    expect(result.link).toBe('[Chat](thread-1)');
    // No sort_order: the model puts it at the top of the new project's list.
    expect(mockThreadsMoveTo).toHaveBeenCalledWith('thread-1', { projectId: 'project-new' });
    expect(mockHooksEmit).toHaveBeenCalledWith('thread:move', {
      id: 'thread-1',
      fromProjectId: 'project-old',
      toProjectId: 'project-new',
      fromContainerId: 'project-old',
      toContainerId: 'project-new',
    });
  });

  it('moves a thread to the workspace level (new_parent_id=null makes it flat)', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(movedThread('t2', 'Chat', 'project-old'));
    mockThreadsMoveTo.mockResolvedValueOnce(movedThread('t2', 'Chat', null));

    const out = await workspaceMove({ id: 't2', new_parent_id: null }, {}, {});
    expect(asResult(out).moved.new_parent_id).toBeNull();
    expect(mockThreadsMoveTo).toHaveBeenCalledWith('t2', { projectId: null });
    expect(mockHooksEmit).toHaveBeenCalledWith(
      'thread:move',
      expect.objectContaining({ fromProjectId: 'project-old', toProjectId: null })
    );
  });

  it('refuses a plain folder as a thread destination, naming the nearest project', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(movedThread('t3', 'Chat', 'project-old'));
    mockNearestProjectForContainer.mockResolvedValueOnce('project-above');

    await expect(workspaceMove({ id: 't3', new_parent_id: 'c-folder' }, {}, {})).rejects.toThrow(
      /not a project.*nearest project above it is "project-above"/s
    );
    expect(mockNearestProjectForContainer).toHaveBeenCalledWith('c-folder');
    expect(mockThreadsMoveTo).not.toHaveBeenCalled();
    expect(mockHooksEmit).not.toHaveBeenCalled();
  });

  it('refuses a folder with no enclosing project and says so', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(movedThread('t4', 'Chat', null));
    mockNearestProjectForContainer.mockResolvedValueOnce(null);

    await expect(workspaceMove({ id: 't4', new_parent_id: 'c-folder' }, {}, {})).rejects.toThrow(
      /No project encloses it/
    );
    expect(mockThreadsMoveTo).not.toHaveBeenCalled();
  });

  it('does not emit thread:move when the thread is already in the target project', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(movedThread('t5', 'Chat', 'project-same'));
    mockThreadsMoveTo.mockResolvedValueOnce(movedThread('t5', 'Chat', 'project-same'));

    await workspaceMove({ id: 't5', new_parent_id: 'project-same' }, {}, {});
    expect(mockThreadsMoveTo).toHaveBeenCalledWith('t5', { projectId: 'project-same' });
    expect(mockHooksEmit).not.toHaveBeenCalled();
  });

  it('reorders a thread within its current project with sort_order alone', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockThreadsFindById.mockResolvedValueOnce(movedThread('t6', 'Chat', 'project-old'));
    mockThreadsMoveTo.mockResolvedValueOnce({
      ...movedThread('t6', 'Chat', 'project-old'),
      sortOrder: 2,
    });

    const result = asResult(await workspaceMove({ id: 't6', sort_order: 2 }, {}, {}));
    expect(mockThreadsMoveTo).toHaveBeenCalledWith('t6', {
      projectId: 'project-old',
      sortOrder: 2,
    });
    expect(result.moved).toMatchObject({ new_parent_id: 'project-old', sort_order: 2 });
    expect(mockHooksEmit).not.toHaveBeenCalled();
  });

  it('moves a thread into another project at an explicit slot', async () => {
    mockThreadsFindById.mockResolvedValueOnce(movedThread('t7', 'Chat', null));
    mockThreadsMoveTo.mockResolvedValueOnce({
      ...movedThread('t7', 'Chat', 'project-new'),
      sortOrder: 1,
    });

    const result = asResult(
      await workspaceMove(
        { id: 't7', kind: 'thread', new_parent_id: 'project-new', sort_order: 1 },
        {},
        {}
      )
    );
    expect(mockThreadsMoveTo).toHaveBeenCalledWith('t7', {
      projectId: 'project-new',
      sortOrder: 1,
    });
    expect(result.moved).toMatchObject({ new_parent_id: 'project-new', sort_order: 1 });
    expect(mockHooksEmit).toHaveBeenCalledWith(
      'thread:move',
      expect.objectContaining({ fromProjectId: null, toProjectId: 'project-new' })
    );
  });
});
