import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted by jest)
const mockDocsListByContainer = jest.fn();
const mockDocsCreate = jest.fn();
const mockLintCanonicalReferences = jest.fn();

jest.mock('@snaglet/db/tables/docs', () => ({
  Docs: {
    listByContainer: mockDocsListByContainer,
    create: mockDocsCreate,
  },
}));

const mockResolveContainerReference = jest.fn();
const mockResolveContainerByPath = jest.fn();
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveContainerReference: mockResolveContainerReference,
  resolveContainerByPath: mockResolveContainerByPath,
}));

// The shared parent-resolution helper probes Containers.findById for loose
// (`container`/`parent`) references before falling back to the path walk.
const mockContainersFindById = jest.fn();
jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: { findById: mockContainersFindById },
}));

jest.mock('@server/services/SocketService/outboundMessageLinter', () => ({
  lintCanonicalWorkspaceReferencesInContent: mockLintCanonicalReferences,
}));

import workspaceCreateDocTool from '@server/services/ToolService/handlers/docs/createDoc';
import { invokeTool, parseToolResult } from '../../../../../../support/toolHarness';

interface CreateDocResult {
  success: boolean;
  doc: {
    id: string;
    title: string;
    container_id: string | null;
    content?: string;
    sort_order?: number;
    created_at?: string;
    created_by?: string | null;
  };
  link: string;
}

const asResult = (out: unknown): CreateDocResult => parseToolResult<CreateDocResult>(out);

interface TestDoc {
  id: string;
  title: string;
  content: string;
  containerId: string | null;
  sortOrder: number;
  createdAt: string;
  createdBy?: string | null;
}

function baseDoc(overrides: Partial<TestDoc> = {}): TestDoc {
  return {
    id: 'doc-1',
    title: 'Hello',
    content: '',
    containerId: null,
    sortOrder: 0,
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
    ...overrides,
  };
}

describe('workspace_create_doc tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLintCanonicalReferences.mockResolvedValue({
      content: '',
      issues: [],
      infrastructureError: false,
    });
    // Loose-reference defaults: no container has the id, no path/name match.
    mockContainersFindById.mockResolvedValue(null);
    mockResolveContainerByPath.mockImplementation(async (path: unknown) => {
      throw new Error(`Container not found at path: ${String(path)}`);
    });
  });

  it('creates a doc with explicit container_id', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('c1');
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockDocsCreate.mockResolvedValueOnce(
      baseDoc({ id: 'd1', title: 'Hello', content: 'Body', containerId: 'c1' })
    );

    const out = await workspaceCreateDocTool(
      { container_id: 'c1', title: 'Hello', content: 'Body' },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.doc.id).toBe('d1');
    expect(result.doc.title).toBe('Hello');
    expect(result.link).toContain('Hello');
    expect(result.link).toContain('d1');
    expect(mockDocsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Hello', content: 'Body', containerId: 'c1' })
    );
  });

  it('creates a doc at root when no container is specified', async () => {
    mockResolveContainerReference.mockResolvedValueOnce(null);
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockDocsCreate.mockResolvedValueOnce(baseDoc({ id: 'd2', title: 'Rooted', containerId: null }));

    const out = await workspaceCreateDocTool({ title: 'Rooted' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.doc.container_id).toBeNull();
    expect(mockDocsListByContainer).toHaveBeenCalledWith(null);
  });

  it('resolves container_path via pathResolver', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('c-from-path');
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockDocsCreate.mockResolvedValueOnce(
      baseDoc({ id: 'd3', title: 'P', containerId: 'c-from-path' })
    );

    const out = await workspaceCreateDocTool({ container_path: '/foo/bar', title: 'P' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(mockResolveContainerReference).toHaveBeenCalledWith(undefined, '/foo/bar', null);
    expect(result.doc.container_id).toBe('c-from-path');
  });

  describe('loose container references (no silent root fallback)', () => {
    it('resolves a bare `container` key holding a real container id', async () => {
      mockContainersFindById.mockResolvedValueOnce({ id: 'c1', name: 'Notes' });
      mockDocsListByContainer.mockResolvedValueOnce([]);
      mockDocsCreate.mockResolvedValueOnce(
        baseDoc({ id: 'd-loose', title: 'L', containerId: 'c1' })
      );

      const out = await workspaceCreateDocTool(
        { container: 'c1', title: 'L' } as never,
        {} as never,
        {} as never
      );
      expect(asResult(out).doc.container_id).toBe('c1');
      expect(mockDocsCreate).toHaveBeenCalledWith(expect.objectContaining({ containerId: 'c1' }));
      // The loose path must not consult the thread/root fallback resolver.
      expect(mockResolveContainerReference).not.toHaveBeenCalled();
    });

    it('resolves a bare `container` key holding a name via the path walk', async () => {
      mockResolveContainerByPath.mockResolvedValueOnce('c-name');
      mockDocsListByContainer.mockResolvedValueOnce([]);
      mockDocsCreate.mockResolvedValueOnce(
        baseDoc({ id: 'd-name', title: 'N', containerId: 'c-name' })
      );

      const out = await workspaceCreateDocTool(
        { container: 'Release Notes (demo)', title: 'N' } as never,
        {} as never,
        {} as never
      );
      expect(asResult(out).doc.container_id).toBe('c-name');
      expect(mockResolveContainerByPath).toHaveBeenCalledWith('Release Notes (demo)');
    });

    it('errors loudly when a provided `container` does not resolve — never falls back to root', async () => {
      await expect(
        workspaceCreateDocTool(
          { container: 'Release Notes (demo)', title: 'Misplaced' } as never,
          {} as never,
          {} as never
        )
      ).rejects.toThrow(
        /create_doc: `container` "Release Notes \(demo\)" did not resolve to a container[\s\S]*`node` \(op tree\)/
      );
      expect(mockDocsCreate).not.toHaveBeenCalled();
    });

    it('rejects a `container` key conflicting with an explicit parent_id', async () => {
      await expect(
        workspaceCreateDocTool(
          { container: 'Somewhere Else', parent_id: 'c1', title: 'T' } as never,
          {} as never,
          {} as never
        )
      ).rejects.toThrow(/`container` \("Somewhere Else"\) conflicts with the explicit parent/);
      expect(mockDocsCreate).not.toHaveBeenCalled();
    });
  });

  describe('unresolvable explicit parents fail loudly', () => {
    it('wraps an unknown parent_id with lookup guidance', async () => {
      mockResolveContainerReference.mockRejectedValueOnce(
        new Error('Container not found: container-nope')
      );
      await expect(
        workspaceCreateDocTool(
          { parent_id: 'container-nope', title: 'T' },
          {} as never,
          {} as never
        )
      ).rejects.toThrow(/create_doc: Container not found: container-nope[\s\S]*`node` \(op tree\)/);
      expect(mockDocsCreate).not.toHaveBeenCalled();
    });

    it('tells the model the real id when a parent_id is actually a container name', async () => {
      mockResolveContainerReference.mockRejectedValueOnce(
        new Error('Container not found: Release Notes (demo)')
      );
      mockResolveContainerByPath.mockResolvedValueOnce('c-real');
      await expect(
        workspaceCreateDocTool(
          { parent_id: 'Release Notes (demo)', title: 'T' },
          {} as never,
          {} as never
        )
      ).rejects.toThrow(/a container by that NAME exists \(id="c-real"\)/);
      expect(mockDocsCreate).not.toHaveBeenCalled();
    });
  });

  it('throws when title is missing or blank', async () => {
    await expect(workspaceCreateDocTool({ title: '' }, {}, {})).rejects.toThrow(/title/i);
    await expect(workspaceCreateDocTool({ title: '   ' }, {}, {})).rejects.toThrow(/title/i);
  });

  it('throws when input is not an object', async () => {
    await expect(invokeTool(workspaceCreateDocTool, null)).rejects.toThrow(/object/i);
  });

  it('throws when sibling with same title (case-insensitive) exists', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('c1');
    mockDocsListByContainer.mockResolvedValueOnce([baseDoc({ id: 'existing', title: 'hello' })]);
    await expect(
      workspaceCreateDocTool({ container_id: 'c1', title: 'Hello' }, {}, {})
    ).rejects.toThrow(/already exists/i);
    expect(mockDocsCreate).not.toHaveBeenCalled();
  });

  it('auto-assigns sort_order as max(sibling.sortOrder)+1', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('c1');
    mockDocsListByContainer.mockResolvedValueOnce([
      baseDoc({ id: 'a', title: 'A', sortOrder: 3 }),
      baseDoc({ id: 'b', title: 'B', sortOrder: 7 }),
    ]);
    mockDocsCreate.mockResolvedValueOnce(
      baseDoc({ id: 'new', title: 'C', containerId: 'c1', sortOrder: 8 })
    );
    await workspaceCreateDocTool({ container_id: 'c1', title: 'C' }, {}, {});
    expect(mockDocsCreate).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 8 }));
  });

  it('passes explicit sort_order through when provided', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('c1');
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockDocsCreate.mockResolvedValueOnce(
      baseDoc({ id: 'd-sort', title: 'S', containerId: 'c1', sortOrder: 42 })
    );
    await workspaceCreateDocTool({ container_id: 'c1', title: 'S', sort_order: 42 }, {}, {});
    expect(mockDocsCreate).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 42 }));
  });

  it('ignores a stray subtype key and never forwards one to the model', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('status-container');
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockDocsCreate.mockResolvedValueOnce(
      baseDoc({ id: 'd-default', title: 'Defaulted', containerId: 'status-container' })
    );

    await workspaceCreateDocTool(
      { parent_id: 'status-container', title: 'Defaulted', subtype: 'task' },
      {},
      {}
    );
    const lastCall = mockDocsCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastCall).toMatchObject({ containerId: 'status-container' });
    expect(lastCall).not.toHaveProperty('subtype');
  });

  it('rejects non-string container_id', async () => {
    await expect(workspaceCreateDocTool({ title: 'T', container_id: 123 }, {}, {})).rejects.toThrow(
      /container_id/
    );
  });

  it('rejects non-finite sort_order', async () => {
    await expect(workspaceCreateDocTool({ title: 'T', sort_order: NaN }, {}, {})).rejects.toThrow(
      /sort_order/
    );
  });

  it('rejects an unverified canonical reference before creating the doc', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('c1');
    mockLintCanonicalReferences.mockResolvedValueOnce({
      content: '[Missing](doc-9999999999999-fabricated)',
      issues: [{ id: 'doc-9999999999999-fabricated', nodeType: 'doc', reason: 'not_found' }],
      infrastructureError: false,
    });

    await expect(
      workspaceCreateDocTool(
        { title: 'Guarded', content: '[Missing](doc-9999999999999-fabricated)' },
        {},
        {}
      )
    ).rejects.toThrow(/unverified workspace reference/i);
    expect(mockDocsCreate).not.toHaveBeenCalled();
  });

  it('creates normally when canonical references are verified', async () => {
    mockResolveContainerReference.mockResolvedValueOnce('c1');
    mockDocsListByContainer.mockResolvedValueOnce([]);
    mockDocsCreate.mockResolvedValueOnce(baseDoc({ id: 'verified', title: 'Verified' }));

    await workspaceCreateDocTool(
      { title: 'Verified', content: '[Real](doc-1111111111111-2djr9lby1)' },
      {},
      {}
    );

    expect(mockDocsCreate).toHaveBeenCalledTimes(1);
  });
});
