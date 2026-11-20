// Compatibility coverage for archive_container after it was absorbed by archive_node.
const mockResolveContainerByPath = jest.fn();
const mockContainerFindById = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock('@server/services/WorkspaceService/pathResolver', () => ({
  resolveContainerByPath: mockResolveContainerByPath,
}));

jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeArchived: jest.fn(),
}));

jest.mock('@server/realtime/surfaces/threads', () => ({
  emitThreadUpdated: jest.fn(),
}));

jest.mock('@snaglet/db', () => ({
  Containers: { findById: mockContainerFindById },
  getDb: jest.fn(() => ({ query: mockPoolQuery })),
  // A container archive runs in a transaction (it takes its projects' tables).
  transaction: jest.fn((fn: (tx: { query: typeof mockPoolQuery }) => unknown) =>
    fn({ query: mockPoolQuery })
  ),
}));

import archiveNode from '@server/services/ToolService/handlers/workspace/archiveNode';

describe('archive_node tool — archive_container compatibility route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires id or a container path', async () => {
    await expect(archiveNode({ kind: 'container' })).rejects.toThrow(
      /provide either `id` or a container `path`/
    );
  });

  it('rejects passing both id and path', async () => {
    await expect(archiveNode({ id: 'c-1', path: '/Snaglet', kind: 'container' })).rejects.toThrow(
      /not both/
    );
  });

  it('rejects path addressing unless kind is container', async () => {
    await expect(archiveNode({ path: '/Snaglet', kind: 'node' })).rejects.toThrow(
      /supported only with kind "container"/
    );
    expect(mockResolveContainerByPath).not.toHaveBeenCalled();
  });

  it('resolves and validates a container for alias-transformed path input', async () => {
    mockResolveContainerByPath.mockResolvedValueOnce('c-99');
    mockContainerFindById.mockResolvedValueOnce({ id: 'c-99', name: 'Docs' });
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'c-99', type: 'container', archived: false, archived_at: null }],
      })
      .mockResolvedValueOnce({ rows: [{ now: '2026-07-22 21:00:00+00' }] })
      // The archive UPDATE, then the cohort's projects (none: no tables to take).
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'c-99' }, { id: 'd-1' }, { id: 'd-2' }, { id: 't-1' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { id: 'c-99', type: 'container', archived: true, archived_at: '2026-07-22 21:00:00+00' },
        ],
      });

    const result = await archiveNode({ path: '/Snaglet/docs', kind: 'container' });

    expect(mockResolveContainerByPath).toHaveBeenCalledWith('/Snaglet/docs');
    expect(mockContainerFindById).toHaveBeenCalledWith('c-99');
    expect(result).toMatchObject({
      success: true,
      node_id: 'c-99',
      type: 'container',
      cohort_size: 4,
      already_archived: false,
    });
  });

  it('rejects an id that is not a container when the compatibility alias pins kind', async () => {
    mockContainerFindById.mockResolvedValueOnce(null);

    await expect(archiveNode({ id: 'not-a-container', kind: 'container' })).rejects.toThrow(
      /container "not-a-container" not found/
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
