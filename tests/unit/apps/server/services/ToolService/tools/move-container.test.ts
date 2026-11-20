// Compatibility coverage for move_container after it was absorbed by move.
const mockDocsFindById = jest.fn();
const mockContainersFindById = jest.fn();
const mockContainersMoveTo = jest.fn();
const mockThreadsFindById = jest.fn();
const mockResolveContainerByPath = jest.fn();
const mockResolveNodeByPath = jest.fn();

jest.mock('@snaglet/db', () => ({
  Docs: { findById: mockDocsFindById },
  Containers: { findById: mockContainersFindById, moveTo: mockContainersMoveTo },
  Threads: { findById: mockThreadsFindById },
  Sketches: { findById: jest.fn() },
}));

jest.mock('@server/services/WorkspaceService/pathResolver', () => ({
  resolveContainerByPath: mockResolveContainerByPath,
  resolveNodeByPath: mockResolveNodeByPath,
}));

import move from '@server/services/ToolService/handlers/workspace/moveNode';

function resultOf(value: unknown): Record<string, unknown> {
  return (value as { rawContent: Record<string, unknown> }).rawContent;
}

describe('move tool — move_container compatibility route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires id or path', async () => {
    await expect(move({ kind: 'container' }, {}, undefined as never)).rejects.toThrow(
      /provide either `id` or `path`/
    );
  });

  it('rejects passing both id and path', async () => {
    await expect(
      move(
        { id: 'c-1', path: '/Snaglet', kind: 'container', new_parent_id: null },
        {},
        undefined as never
      )
    ).rejects.toThrow(/not both/);
  });

  it('routes alias-transformed kind:container input directly to the container model', async () => {
    mockContainersFindById
      .mockResolvedValueOnce({ id: 'c-1', name: 'Folder', parentId: 'c-old' })
      // The destination lookup: a live container.
      .mockResolvedValueOnce({ id: 'c-2', name: 'Target', parentId: null, archived: false });
    mockContainersMoveTo.mockResolvedValueOnce({
      id: 'c-1',
      name: 'Folder',
      parentId: 'c-2',
      sortOrder: 3,
      updatedAt: '2026-07-22T00:00:00.000Z',
    });

    const out = await move(
      { id: 'c-1', kind: 'container', new_parent_id: 'c-2', sort_order: 3 },
      {},
      undefined as never
    );

    expect(resultOf(out)).toMatchObject({
      success: true,
      kind: 'container',
      moved: { id: 'c-1', new_parent_id: 'c-2', sort_order: 3 },
    });
    expect(mockContainersMoveTo).toHaveBeenCalledWith('c-1', 'c-2', 3, null);
    expect(mockDocsFindById).not.toHaveBeenCalled();
    expect(mockThreadsFindById).not.toHaveBeenCalled();
  });

  it('passes the container hint while resolving a legacy path call', async () => {
    mockResolveNodeByPath.mockResolvedValueOnce({ id: 'c-9', kind: 'container' });
    mockContainersFindById.mockResolvedValueOnce({
      id: 'c-9',
      name: 'Docs',
      parentId: 'c-old',
    });
    mockContainersMoveTo.mockResolvedValueOnce({
      id: 'c-9',
      name: 'Docs',
      parentId: null,
      sortOrder: 0,
      updatedAt: '2026-07-22T00:00:00.000Z',
    });

    await move(
      { path: '/Snaglet/docs', kind: 'container', new_parent_id: null },
      {},
      undefined as never
    );

    expect(mockResolveNodeByPath).toHaveBeenCalledWith('/Snaglet/docs', 'container');
    expect(mockContainersMoveTo).toHaveBeenCalledWith('c-9', null, undefined, null);
  });
});
