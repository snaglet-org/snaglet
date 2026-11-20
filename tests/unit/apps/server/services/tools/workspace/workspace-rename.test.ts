import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted)
const mockDocsFindById = jest.fn();
const mockDocsUpdate = jest.fn();
const mockDocsListByContainer = jest.fn();

const mockContainersFindById = jest.fn();
const mockContainersUpdate = jest.fn();
const mockContainersListByParent = jest.fn();

const mockLinksFilter = jest.fn();
const mockNodesGetType = jest.fn();

jest.mock('@snaglet/db', () => ({
  Docs: {
    findById: mockDocsFindById,
    update: mockDocsUpdate,
    listByContainer: mockDocsListByContainer,
  },
  Containers: {
    findById: mockContainersFindById,
    update: mockContainersUpdate,
    listByParent: mockContainersListByParent,
  },
  Links: { filter: mockLinksFilter },
  Nodes: { getType: mockNodesGetType },
}));

const mockResolveNodeByPath = jest.fn();
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveNodeByPath: mockResolveNodeByPath,
}));

const mockImagesFindMetaById = jest.fn();
const mockImagesRename = jest.fn();
jest.mock('@snaglet/db/tables/images', () => ({
  Images: { findMetaById: mockImagesFindMetaById, rename: mockImagesRename },
}));

const mockEmitTreeNodeUpdated = jest.fn();
jest.mock('@server/realtime/surfaces/tree', () => ({
  emitTreeNodeUpdated: mockEmitTreeNodeUpdated,
  emitDocBodySaved: jest.fn(),
}));

import workspaceRename from '@server/services/ToolService/handlers/workspace/renameNode';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface InlineUpdate {
  doc_id?: string;
  occurrences: number;
}

interface RenameResult {
  success?: boolean;
  noop?: boolean;
  validate_only?: boolean;
  kind?: string;
  old_title?: string;
  new_title?: string;
  inline_updates_applied?: InlineUpdate[];
  inline_updates_planned?: InlineUpdate[];
}

const asResult = (out: unknown): RenameResult => parseToolResult<RenameResult>(out);

describe('rename tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // validation
  it('throws when neither id nor path is given', async () => {
    await expect(workspaceRename({ new_title: 'X' }, {}, {})).rejects.toThrow(/id.*path/);
  });

  it('throws when both id and path are given', async () => {
    await expect(workspaceRename({ id: 'a', path: '/b', new_title: 'X' }, {}, {})).rejects.toThrow(
      /both/
    );
  });

  it('throws when new_title is blank', async () => {
    await expect(workspaceRename({ id: 'd1', new_title: '   ' }, {}, {})).rejects.toThrow(
      /new_title/
    );
  });

  it('throws when target node id does not exist', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce(null);
    mockNodesGetType.mockResolvedValueOnce(null);
    await expect(workspaceRename({ id: 'ghost', new_title: 'X' }, {}, {})).rejects.toThrow(
      /not found/
    );
  });

  describe('images', () => {
    const IMAGE_ID = 'image-1111111111111-aaaaaaaaa';
    const image = (name: string, archived = false) => ({
      id: IMAGE_ID,
      name,
      archived,
      updatedAt: '2026-08-05T00:00:00.000Z',
    });

    beforeEach(() => {
      mockDocsFindById.mockResolvedValue(null);
      mockContainersFindById.mockResolvedValue(null);
      mockNodesGetType.mockResolvedValue('image');
    });

    it('renames an image and its stored file through the model, like the sidebar', async () => {
      mockImagesFindMetaById.mockResolvedValue(image('Capture'));
      mockImagesRename.mockResolvedValue({ status: 'renamed', image: image('Sunset') });

      const out = asResult(await workspaceRename({ id: IMAGE_ID, new_title: ' Sunset ' }, {}, {}));

      expect(mockImagesRename).toHaveBeenCalledWith(IMAGE_ID, 'Sunset', {
        expectedName: 'Capture',
      });
      expect(mockEmitTreeNodeUpdated).toHaveBeenCalledWith({
        id: IMAGE_ID,
        kind: 'image',
        title: 'Sunset',
        updatedAt: '2026-08-05T00:00:00.000Z',
      });
      expect(out).toMatchObject({
        success: true,
        kind: 'image',
        old_title: 'Capture',
        new_title: 'Sunset',
      });
    });

    it('does nothing for an unchanged name or a validate_only call', async () => {
      mockImagesFindMetaById.mockResolvedValue(image('Capture'));
      expect(
        asResult(await workspaceRename({ id: IMAGE_ID, new_title: 'Capture' }, {}, {}))
      ).toMatchObject({ noop: true });
      expect(
        asResult(
          await workspaceRename({ id: IMAGE_ID, new_title: 'Next', validate_only: true }, {}, {})
        )
      ).toMatchObject({ validate_only: true });
      expect(mockImagesRename).not.toHaveBeenCalled();
      expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
    });

    it('refuses an archived image, an overlong name and a stale rename', async () => {
      mockImagesFindMetaById.mockResolvedValueOnce(image('Capture', true));
      await expect(workspaceRename({ id: IMAGE_ID, new_title: 'X' }, {}, {})).rejects.toThrow(
        /archived/
      );
      await expect(
        workspaceRename({ id: IMAGE_ID, new_title: 'x'.repeat(121) }, {}, {})
      ).rejects.toThrow(/at most 120 characters/);
      mockImagesFindMetaById.mockResolvedValue(image('Capture'));
      mockImagesRename.mockResolvedValue({ status: 'conflict', currentName: 'Elsewhere' });
      await expect(workspaceRename({ id: IMAGE_ID, new_title: 'X' }, {}, {})).rejects.toThrow(
        /renamed to "Elsewhere" meanwhile/
      );
      expect(mockEmitTreeNodeUpdated).not.toHaveBeenCalled();
    });
  });

  // doc rename happy path
  it('renames a doc and rewrites inline labels in linking docs', async () => {
    // classify: it's a doc
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'Old', containerId: 'c1' }); // classifyId
    mockContainersFindById.mockResolvedValueOnce(null);
    // current fetch
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'Old', containerId: 'c1' });
    mockDocsListByContainer.mockResolvedValueOnce([
      { id: 'd1', title: 'Old', containerId: 'c1' },
      { id: 'd2', title: 'Other', containerId: 'c1' },
    ]);
    // links: two source docs link to d1
    mockLinksFilter.mockResolvedValueOnce([
      { sourceId: 'd-src-1', targetId: 'd1' },
      { sourceId: 'd-src-2', targetId: 'd1' },
    ]);
    // src-1 has 2 chips to d1, src-2 has 1
    mockDocsFindById
      .mockResolvedValueOnce({
        id: 'd-src-1',
        title: 'Source One',
        content: 'See ![Old](d1) and also ![old](d1) for details',
      })
      .mockResolvedValueOnce({
        id: 'd-src-2',
        title: 'Source Two',
        content: '![Old](d1) is great',
      });
    mockDocsUpdate.mockResolvedValue({
      id: 'd1',
      title: 'New',
      containerId: 'c1',
    });
    // re-fetches for applying updates
    mockDocsFindById
      .mockResolvedValueOnce({
        id: 'd-src-1',
        title: 'Source One',
        content: 'See ![Old](d1) and also ![old](d1) for details',
      })
      .mockResolvedValueOnce({
        id: 'd-src-2',
        title: 'Source Two',
        content: '![Old](d1) is great',
      });

    const out = await workspaceRename({ id: 'd1', new_title: 'New' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.kind).toBe('doc');
    expect(result.old_title).toBe('Old');
    expect(result.new_title).toBe('New');
    expect(result.inline_updates_applied).toHaveLength(2);
    const total = result.inline_updates_applied!.reduce((a, u) => a + u.occurrences, 0);
    expect(total).toBe(3);

    // verify the rename call
    expect(mockDocsUpdate).toHaveBeenCalledWith('d1', { title: 'New' });
    // verify inline rewrites: the actual content should have the new label
    const src1Update = mockDocsUpdate.mock.calls.find((c) => c[0] === 'd-src-1');
    expect(src1Update).toBeDefined();
    expect(src1Update![1].content).toBe('See ![New](d1) and also ![New](d1) for details');
    const src2Update = mockDocsUpdate.mock.calls.find((c) => c[0] === 'd-src-2');
    expect(src2Update![1].content).toBe('![New](d1) is great');
  });

  it('skips inline-label rewrite when update_inline_labels=false', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'A', containerId: null });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'A', containerId: null });
    mockDocsListByContainer.mockResolvedValueOnce([{ id: 'd1', title: 'A', containerId: null }]);
    mockDocsUpdate.mockResolvedValueOnce({ id: 'd1', title: 'B', containerId: null });

    const out = await workspaceRename(
      { id: 'd1', new_title: 'B', update_inline_labels: false },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.inline_updates_applied).toEqual([]);
    expect(mockLinksFilter).not.toHaveBeenCalled();
  });

  it('is a noop when new title equals old title', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'Same', containerId: null });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'Same', containerId: null });

    const out = await workspaceRename({ id: 'd1', new_title: 'Same' }, {}, {});
    const result = asResult(out);
    expect(result.noop).toBe(true);
    expect(mockDocsUpdate).not.toHaveBeenCalled();
    expect(mockLinksFilter).not.toHaveBeenCalled();
  });

  it('throws on sibling title collision', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'A', containerId: 'c1' });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'A', containerId: 'c1' });
    mockDocsListByContainer.mockResolvedValueOnce([
      { id: 'd1', title: 'A', containerId: 'c1' },
      { id: 'd2', title: 'Taken', containerId: 'c1' },
    ]);

    await expect(workspaceRename({ id: 'd1', new_title: 'Taken' }, {}, {})).rejects.toThrow(
      /already exists/
    );
    expect(mockDocsUpdate).not.toHaveBeenCalled();
  });

  // container rename
  it('renames a container and never queries links', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce({ id: 'c1', name: 'Old', parentId: null });
    mockContainersFindById.mockResolvedValueOnce({ id: 'c1', name: 'Old', parentId: null });
    mockContainersListByParent.mockResolvedValueOnce([
      { id: 'c1', name: 'Old', parentId: null },
      { id: 'c2', name: 'Other', parentId: null },
    ]);
    mockContainersUpdate.mockResolvedValueOnce({ id: 'c1', name: 'New', parentId: null });

    const out = await workspaceRename({ id: 'c1', new_title: 'New' }, {}, {});
    const result = asResult(out);
    expect(result.kind).toBe('container');
    expect(mockContainersUpdate).toHaveBeenCalledWith('c1', { name: 'New' });
    expect(mockLinksFilter).not.toHaveBeenCalled();
  });

  it('throws on container sibling-name collision', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    mockContainersFindById.mockResolvedValueOnce({ id: 'c1', name: 'A', parentId: null });
    mockContainersFindById.mockResolvedValueOnce({ id: 'c1', name: 'A', parentId: null });
    mockContainersListByParent.mockResolvedValueOnce([
      { id: 'c1', name: 'A', parentId: null },
      { id: 'c2', name: 'Taken', parentId: null },
    ]);

    await expect(workspaceRename({ id: 'c1', new_title: 'Taken' }, {}, {})).rejects.toThrow(
      /already exists/
    );
    expect(mockContainersUpdate).not.toHaveBeenCalled();
  });

  // validate_only
  it('validate_only reports plan without writing', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'Old', containerId: null });
    mockContainersFindById.mockResolvedValueOnce(null);
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'Old', containerId: null });
    mockDocsListByContainer.mockResolvedValueOnce([{ id: 'd1', title: 'Old', containerId: null }]);
    mockLinksFilter.mockResolvedValueOnce([{ sourceId: 'd-src', targetId: 'd1' }]);
    mockDocsFindById.mockResolvedValueOnce({
      id: 'd-src',
      title: 'Src',
      content: '![Old](d1) twice ![Old](d1)',
    });

    const out = await workspaceRename(
      { id: 'd1', new_title: 'Brand', validate_only: true },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.validate_only).toBe(true);
    expect(result.inline_updates_planned).toHaveLength(1);
    expect(result.inline_updates_planned![0].occurrences).toBe(2);
    expect(mockDocsUpdate).not.toHaveBeenCalled();
    expect(mockContainersUpdate).not.toHaveBeenCalled();
  });

  // path resolution
  it('resolves target by path', async () => {
    mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'doc', id: 'd1' });
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'A', containerId: null });
    mockDocsListByContainer.mockResolvedValueOnce([{ id: 'd1', title: 'A', containerId: null }]);
    mockLinksFilter.mockResolvedValueOnce([]);
    mockDocsUpdate.mockResolvedValueOnce({ id: 'd1', title: 'B', containerId: null });

    const out = await workspaceRename({ path: '/A', new_title: 'B' }, {}, {});
    const result = asResult(out);
    expect(mockResolveNodeByPath).toHaveBeenCalledWith('/A', undefined);
    expect(result.success).toBe(true);
  });
});
