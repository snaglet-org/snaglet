import { beforeEach, describe, expect, it } from '@jest/globals';

const mockResolveContainerReference = jest.fn();
const mockContainerListByParent = jest.fn();
const mockContainerCreate = jest.fn();
const mockContainerDelete = jest.fn();
const mockDocListByContainer = jest.fn();
const mockDocCreate = jest.fn();
const mockDocUpdate = jest.fn();
const mockDocDelete = jest.fn();

jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: {
    listByParent: mockContainerListByParent,
    create: mockContainerCreate,
    delete: mockContainerDelete,
  },
}));
jest.mock('@snaglet/db/tables/docs', () => ({
  Docs: {
    listByContainer: mockDocListByContainer,
    create: mockDocCreate,
    update: mockDocUpdate,
    delete: mockDocDelete,
  },
}));
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveContainerReference: mockResolveContainerReference,
}));

import bulkImport from '@server/services/ToolService/tools/workspace/bulk-import/tool';

type Out = { output: string; rawContent: Record<string, unknown> };
const call = (input: unknown) => bulkImport(input as never, {}, {} as never) as Promise<Out>;

describe('bulk_import', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Sensible defaults: parent resolves to root, no existing siblings.
    mockResolveContainerReference.mockResolvedValue(null);
    mockContainerListByParent.mockResolvedValue([]);
    mockDocListByContainer.mockResolvedValue([]);
  });

  describe('input validation', () => {
    it('rejects missing tree', async () => {
      await expect(call({})).rejects.toThrow(/`tree` must be a valid container or doc node/);
    });

    it('rejects tree of wrong kind', async () => {
      await expect(call({ tree: { kind: 'banana', name: 'x' } })).rejects.toThrow(
        /valid container or doc node/
      );
    });

    it('rejects container with empty name', async () => {
      await expect(call({ tree: { kind: 'container', name: '', children: [] } })).rejects.toThrow(
        /empty name/
      );
    });

    it('rejects doc with empty title', async () => {
      await expect(call({ tree: { kind: 'doc', title: '   ', content: '' } })).rejects.toThrow(
        /empty title/
      );
    });

    it('rejects non-string content', async () => {
      await expect(call({ tree: { kind: 'doc', title: 'X', content: 42 } })).rejects.toThrow(
        /non-string content/
      );
    });

    it('rejects invalid mode', async () => {
      await expect(call({ tree: { kind: 'doc', title: 'X' }, mode: 'overwrite' })).rejects.toThrow(
        /`mode` must be "create" or "merge"/
      );
    });
  });

  describe('dry_run mode', () => {
    it('produces a plan without writing', async () => {
      mockDocCreate.mockResolvedValue({ id: 'd-new', title: 'D', containerId: null, content: '' });
      const tree = {
        kind: 'container',
        name: 'Imports',
        children: [
          { kind: 'doc', title: 'A', content: 'a' },
          { kind: 'container', name: 'Sub', children: [{ kind: 'doc', title: 'B', content: 'b' }] },
        ],
      };
      const out = await call({ tree, dry_run: true });
      expect(out.rawContent.dry_run).toBe(true);
      expect(mockContainerCreate).not.toHaveBeenCalled();
      expect(mockDocCreate).not.toHaveBeenCalled();
      const plan = out.rawContent.plan as Array<{ action: string; name: string }>;
      const actions = plan.map((p) => `${p.action}:${p.name}`);
      expect(actions).toEqual([
        'create_container:Imports',
        'create_doc:A',
        'create_container:Sub',
        'create_doc:B',
      ]);
    });
  });

  describe('create mode — happy path', () => {
    it('creates a container with nested docs', async () => {
      mockContainerCreate.mockImplementation(async (input: { name: string }) => ({
        id: `c-${input.name}`,
        name: input.name,
        parentId: null,
        sortOrder: 0,
        createdAt: new Date(),
      }));
      mockDocCreate.mockImplementation(async (input: { title: string }) => ({
        id: `d-${input.title}`,
        title: input.title,
        containerId: null,
        content: '',
        sortOrder: 0,
        createdAt: new Date(),
      }));
      const tree = {
        kind: 'container',
        name: 'Imports',
        children: [{ kind: 'doc', title: 'A', content: 'hello' }],
      };
      const out = await call({ tree });
      expect(out.rawContent.success).toBe(true);
      expect(mockContainerCreate).toHaveBeenCalledTimes(1);
      expect(mockDocCreate).toHaveBeenCalledTimes(1);
      const counts = out.rawContent.counts as Record<string, number>;
      expect(counts.create_container).toBe(1);
      expect(counts.create_doc).toBe(1);
    });

    it('unwraps the magic <workspace> top-level container', async () => {
      mockContainerCreate.mockImplementation(async (input: { name: string }) => ({
        id: `c-${input.name}`,
        name: input.name,
        parentId: null,
        sortOrder: 0,
      }));
      const tree = {
        kind: 'container',
        name: '<workspace>',
        children: [
          { kind: 'container', name: 'A', children: [] },
          { kind: 'container', name: 'B', children: [] },
        ],
      };
      const out = await call({ tree });
      expect(mockContainerCreate).toHaveBeenCalledTimes(2);
      const plan = out.rawContent.plan as Array<{ name: string }>;
      // Should not contain a node for <workspace> itself.
      expect(plan.map((p) => p.name)).toEqual(['A', 'B']);
    });

    it('uses parent_id when provided', async () => {
      mockResolveContainerReference.mockResolvedValueOnce('parent-1');
      mockContainerCreate.mockResolvedValueOnce({
        id: 'c-x',
        name: 'X',
        parentId: 'parent-1',
        sortOrder: 0,
      });
      await call({
        tree: { kind: 'container', name: 'X', children: [] },
        parent_id: 'parent-1',
      });
      expect(mockResolveContainerReference).toHaveBeenCalledWith('parent-1', undefined);
      expect(mockContainerCreate).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'parent-1' })
      );
    });
  });

  describe('create mode — collision detection', () => {
    it('rejects when a container name already exists at the level', async () => {
      mockContainerListByParent.mockResolvedValueOnce([
        { id: 'c-existing', name: 'Imports', sortOrder: 0 },
      ]);
      const tree = { kind: 'container', name: 'Imports', children: [] };
      // Magic-unwrap doesn't apply (name != <workspace>), so the tree is the
      // top-level child being imported under root.
      await expect(call({ tree, mode: 'create' })).rejects.toThrow(/already exists/);
      expect(mockContainerCreate).not.toHaveBeenCalled();
    });

    it('rejects when a doc title already exists at the level', async () => {
      mockDocListByContainer.mockResolvedValueOnce([
        { id: 'd-existing', title: 'Onboarding', sortOrder: 0 },
      ]);
      const tree = { kind: 'doc', title: 'ONBOARDING', content: 'x' };
      await expect(call({ tree, mode: 'create' })).rejects.toThrow(/already exists/);
      expect(mockDocCreate).not.toHaveBeenCalled();
    });
  });

  describe('merge mode', () => {
    it('reuses an existing container by name', async () => {
      mockContainerListByParent.mockResolvedValueOnce([
        { id: 'c-existing', name: 'Imports', sortOrder: 0 },
      ]);
      // Inner level: empty containers/docs.
      mockContainerListByParent.mockResolvedValueOnce([]);
      mockDocListByContainer.mockResolvedValueOnce([]);
      mockDocCreate.mockResolvedValueOnce({
        id: 'd-new',
        title: 'New Doc',
        containerId: 'c-existing',
        content: '',
      });
      const tree = {
        kind: 'container',
        name: 'Imports',
        children: [{ kind: 'doc', title: 'New Doc', content: '' }],
      };
      const out = await call({ tree, mode: 'merge' });
      const plan = out.rawContent.plan as Array<{
        action: string;
        name: string;
        existing_id?: string;
      }>;
      expect(plan[0]).toEqual(
        expect.objectContaining({
          action: 'reuse_container',
          name: 'Imports',
          existing_id: 'c-existing',
        })
      );
      expect(plan[1]).toEqual(expect.objectContaining({ action: 'create_doc', name: 'New Doc' }));
      expect(mockContainerCreate).not.toHaveBeenCalled();
      expect(mockDocCreate).toHaveBeenCalledTimes(1);
    });

    it('updates existing docs by title (case-insensitive)', async () => {
      mockDocListByContainer.mockResolvedValueOnce([
        { id: 'd-existing', title: 'Onboarding', sortOrder: 0 },
      ]);
      mockDocUpdate.mockResolvedValueOnce({
        id: 'd-existing',
        title: 'Onboarding',
        containerId: null,
        content: 'NEW',
      });
      const tree = { kind: 'doc', title: 'ONBOARDING', content: 'NEW' };
      const out = await call({ tree, mode: 'merge' });
      expect(mockDocUpdate).toHaveBeenCalledWith('d-existing', { content: 'NEW' });
      const plan = out.rawContent.plan as Array<{ action: string }>;
      expect(plan[0].action).toBe('update_doc');
    });
  });

  describe('rollback on failure', () => {
    it('rolls back created containers when a later doc-create throws', async () => {
      mockContainerCreate.mockResolvedValueOnce({
        id: 'c-rollback',
        name: 'X',
        parentId: null,
        sortOrder: 0,
      });
      // Inner level returns no siblings, then Docs.create throws.
      mockContainerListByParent
        .mockResolvedValueOnce([]) // top-level pre-check
        .mockResolvedValueOnce([]); // inside X
      mockDocListByContainer
        .mockResolvedValueOnce([]) // top-level pre-check
        .mockResolvedValueOnce([]); // inside X
      mockDocCreate.mockRejectedValueOnce(new Error('disk full'));
      mockContainerDelete.mockResolvedValueOnce(true);

      const tree = {
        kind: 'container',
        name: 'X',
        children: [{ kind: 'doc', title: 'D', content: '' }],
      };
      const out = await call({ tree });
      expect(out.rawContent.success).toBe(false);
      expect(out.rawContent.error).toMatch(/disk full/);
      expect(mockContainerDelete).toHaveBeenCalledWith('c-rollback');
      expect(out.rawContent.rolled_back).toBe(1);
    });
  });
});
