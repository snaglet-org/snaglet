import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted)
// duplicate_doc owns only the doc-specific ergonomics (title/path
// resolution + collision policy) and delegates the copy to the shared clone
// engine. So we mock `cloneNode` (the single clone implementation) plus the
// two Docs reads the tool still does itself (source lookup + sibling scan).
const mockDocsFindById = jest.fn();
const mockDocsListByContainer = jest.fn();

jest.mock('@snaglet/db', () => ({
  Docs: {
    findById: mockDocsFindById,
    listByContainer: mockDocsListByContainer,
  },
}));

const mockCloneNode = jest.fn();
jest.mock('@server/domains/clone/NodeCloneService', () => ({
  cloneNode: mockCloneNode,
}));

const mockResolveContainerByPath = jest.fn();
const mockResolveDocByPath = jest.fn();
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveContainerByPath: mockResolveContainerByPath,
  resolveDocByPath: mockResolveDocByPath,
}));

import workspaceDuplicateDoc from '@server/services/ToolService/handlers/docs/duplicateDoc';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface DuplicateDocResult {
  success: boolean;
  source: { id: string };
  doc: { id: string; title: string };
  link: string;
}

const asResult = (out: unknown): DuplicateDocResult => parseToolResult<DuplicateDocResult>(out);

interface SourceDoc {
  id: string;
  title: string;
  content: string;
  containerId: string | null;
  sortOrder: number;
}

/** The snapshot fields cloneResult overrides per test. */
interface CloneRoot {
  id: string;
  kind: string;
  title: string;
  parentId: string | null;
  sortKey: string;
  createdAt: string;
  updatedAt: string;
}

const sourceDoc = (overrides: Partial<SourceDoc> = {}): SourceDoc => ({
  id: 'src-1',
  title: 'Original',
  content: 'Body with ![ref](target-1)',
  containerId: 'c1',
  sortOrder: 0,
  ...overrides,
});

/** cloneNode returns a `{ root, count }` — the root is a WorkspaceNodeSnapshot. */
const cloneResult = (rootOverrides: Partial<CloneRoot> = {}) => ({
  root: {
    id: 'copy-1',
    kind: 'doc',
    title: 'Original (copy)',
    parentId: 'c1',
    sortKey: '1',
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2025-01-01T00:00:00Z').toISOString(),
    ...rootOverrides,
  },
  count: 1,
});

describe('workspace_duplicate_doc tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCloneNode.mockResolvedValue(cloneResult());
  });

  it('duplicates a doc by id with default title "<source> (copy)"', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockDocsListByContainer.mockResolvedValueOnce([sourceDoc()]);

    const out = await workspaceDuplicateDoc({ source_id: 'src-1' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.source.id).toBe('src-1');
    expect(result.doc.id).toBe('copy-1');
    expect(result.doc.title).toBe('Original (copy)');
    expect(result.link).toContain('copy-1');
    // The copy itself is delegated to the single clone engine, with our chosen
    // title threaded through as the collision-suffixed base.
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'src-1',
        targetContainerId: 'c1',
        titleOverride: 'Original (copy)',
      })
    );
  });

  it('uses provided new_title', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockDocsListByContainer.mockResolvedValueOnce([sourceDoc()]);
    mockCloneNode.mockResolvedValueOnce(cloneResult({ id: 'c2', title: 'Brand New' }));

    const out = await workspaceDuplicateDoc({ source_id: 'src-1', new_title: 'Brand New' }, {}, {});
    const result = asResult(out);
    expect(result.doc.title).toBe('Brand New');
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ titleOverride: 'Brand New' })
    );
  });

  it('places copy in target_container_id when provided', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockCloneNode.mockResolvedValueOnce(cloneResult({ parentId: 'c-other' }));

    await workspaceDuplicateDoc({ source_id: 'src-1', target_container_id: 'c-other' }, {}, {});
    expect(mockDocsListByContainer).toHaveBeenCalledWith('c-other');
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ targetContainerId: 'c-other' })
    );
  });

  it('treats target_container_id=null as root', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockCloneNode.mockResolvedValueOnce(cloneResult({ parentId: null }));

    await workspaceDuplicateDoc({ source_id: 'src-1', target_container_id: null }, {}, {});
    expect(mockDocsListByContainer).toHaveBeenCalledWith(null);
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ targetContainerId: null })
    );
  });

  it('resolves target_container_path', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockResolveContainerByPath.mockResolvedValueOnce('c-resolved');
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockCloneNode.mockResolvedValueOnce(cloneResult({ parentId: 'c-resolved' }));

    await workspaceDuplicateDoc({ source_id: 'src-1', target_container_path: '/projects' }, {}, {});
    expect(mockResolveContainerByPath).toHaveBeenCalledWith('/projects');
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ targetContainerId: 'c-resolved' })
    );
  });

  it('treats target_container_path="/" as root', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockCloneNode.mockResolvedValueOnce(cloneResult({ parentId: null }));

    await workspaceDuplicateDoc({ source_id: 'src-1', target_container_path: '/' }, {}, {});
    expect(mockResolveContainerByPath).not.toHaveBeenCalled();
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ targetContainerId: null })
    );
  });

  it('resolves source by path', async () => {
    mockResolveDocByPath.mockResolvedValueOnce('src-by-path');
    mockDocsFindById.mockResolvedValueOnce(sourceDoc({ id: 'src-by-path' }));
    mockDocsListByContainer.mockResolvedValueOnce([]);

    await workspaceDuplicateDoc({ source_path: '/Original' }, {}, {});
    expect(mockResolveDocByPath).toHaveBeenCalledWith('/Original');
    expect(mockCloneNode).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-by-path' })
    );
  });

  it('passes sort_order through', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockDocsListByContainer.mockResolvedValueOnce([]);

    await workspaceDuplicateDoc({ source_id: 'src-1', sort_order: 9 }, {}, {});
    expect(mockCloneNode).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 9 }));
  });

  it('throws when neither source_id nor source_path is given', async () => {
    await expect(workspaceDuplicateDoc({}, {}, {})).rejects.toThrow(/source_id.*source_path/);
  });

  it('throws when both source_id and source_path are given', async () => {
    await expect(
      workspaceDuplicateDoc({ source_id: 'a', source_path: '/b' }, {}, {})
    ).rejects.toThrow(/both/);
  });

  it('throws when source doc does not exist', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    await expect(workspaceDuplicateDoc({ source_id: 'ghost' }, {}, {})).rejects.toThrow(
      /source doc not found/
    );
    expect(mockCloneNode).not.toHaveBeenCalled();
  });

  it('throws on sibling-title collision', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockDocsListByContainer.mockResolvedValueOnce([
      sourceDoc({ id: 'existing', title: 'Original (copy)' }),
    ]);
    await expect(workspaceDuplicateDoc({ source_id: 'src-1' }, {}, {})).rejects.toThrow(
      /already has a doc titled/
    );
    expect(mockCloneNode).not.toHaveBeenCalled();
  });

  it('throws when target_container_path does not resolve', async () => {
    mockDocsFindById.mockResolvedValueOnce(sourceDoc());
    mockResolveContainerByPath.mockResolvedValueOnce(null);
    await expect(
      workspaceDuplicateDoc({ source_id: 'src-1', target_container_path: '/missing' }, {}, {})
    ).rejects.toThrow(/target container not found/);
  });

  it('throws when sort_order is not finite', async () => {
    await expect(
      workspaceDuplicateDoc({ source_id: 'src-1', sort_order: NaN }, {}, {})
    ).rejects.toThrow(/sort_order/);
  });
});
