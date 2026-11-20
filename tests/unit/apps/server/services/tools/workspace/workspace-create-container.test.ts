import { beforeEach, describe, expect, it } from '@jest/globals';

// jest.mock is hoisted; declare mock fns before module imports.
const mockListByParent = jest.fn();
const mockCreate = jest.fn();
const mockFindById = jest.fn();
const mockResolveContainerReference = jest.fn();

jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: {
    listByParent: mockListByParent,
    create: mockCreate,
    findById: mockFindById,
  },
}));

const mockResolveContainerByPath = jest.fn();
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveContainerReference: mockResolveContainerReference,
  resolveContainerByPath: mockResolveContainerByPath,
}));

import createContainer from '@server/services/ToolService/handlers/containers/createContainer';

describe('workspace_create_container', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no parent (root), no siblings, no conflict.
    mockResolveContainerReference.mockResolvedValue(null);
    mockListByParent.mockResolvedValue([]);
    // Loose-reference defaults: no container has the id, no path/name match.
    mockFindById.mockResolvedValue(null);
    mockResolveContainerByPath.mockImplementation(async (path: unknown) => {
      throw new Error(`Container not found at path: ${String(path)}`);
    });
    mockCreate.mockResolvedValue({
      id: 'container-new',
      name: 'New Folder',
      parentId: null,
      sortOrder: 0,
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });
  });

  describe('input validation', () => {
    it('throws when input is not an object', async () => {
      await expect(createContainer(null as never, {}, {} as never)).rejects.toThrow(
        /must be an object/
      );
    });

    it('throws when name is missing', async () => {
      await expect(createContainer({} as never, {}, {} as never)).rejects.toThrow(
        /`name` is required/
      );
    });

    it('throws when name is empty/whitespace', async () => {
      await expect(createContainer({ name: '   ' } as never, {}, {} as never)).rejects.toThrow(
        /`name` is required/
      );
    });

    it('throws when sort_order is not a finite number', async () => {
      await expect(
        createContainer({ name: 'X', sort_order: 'nope' } as never, {}, {} as never)
      ).rejects.toThrow(/`sort_order` must be a finite number/);
      await expect(
        createContainer({ name: 'X', sort_order: NaN } as never, {}, {} as never)
      ).rejects.toThrow(/`sort_order` must be a finite number/);
    });
  });

  describe('parent resolution', () => {
    it('creates a root-level container when no parent specified', async () => {
      const result = await createContainer({ name: 'Root Folder' } as never, {}, {} as never);
      expect(mockResolveContainerReference).toHaveBeenCalledWith(undefined, undefined, null);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Root Folder', parentId: null })
      );
      const parsed = JSON.parse(
        typeof result === 'string' ? result : (result as { output: string }).output
      );
      expect(parsed.success).toBe(true);
      expect(parsed.container.id).toBe('container-new');
    });

    it('delegates parent_id to resolveContainerReference', async () => {
      mockResolveContainerReference.mockResolvedValueOnce('parent-123');
      await createContainer({ name: 'Child', parent_id: 'parent-123' } as never, {}, {} as never);
      expect(mockResolveContainerReference).toHaveBeenCalledWith('parent-123', undefined, null);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'parent-123' }));
    });

    it('delegates parent_path to resolveContainerReference', async () => {
      mockResolveContainerReference.mockResolvedValueOnce('parent-456');
      await createContainer(
        { name: 'Child', parent_path: '/Snaglet/docs' } as never,
        {},
        {} as never
      );
      expect(mockResolveContainerReference).toHaveBeenCalledWith(undefined, '/Snaglet/docs', null);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'parent-456' }));
    });

    it('surfaces errors from resolveContainerReference', async () => {
      mockResolveContainerReference.mockRejectedValueOnce(new Error('parent_path did not resolve'));
      await expect(
        createContainer({ name: 'X', parent_path: '/missing' } as never, {}, {} as never)
      ).rejects.toThrow(/parent_path did not resolve/);
    });

    it('accepts container_id as an alias of parent_id', async () => {
      mockResolveContainerReference.mockResolvedValueOnce('parent-alias');
      await createContainer(
        { name: 'Child', container_id: 'parent-alias' } as never,
        {},
        {} as never
      );
      expect(mockResolveContainerReference).toHaveBeenCalledWith('parent-alias', undefined, null);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'parent-alias' })
      );
    });

    it('rejects conflicting parent_id and container_id values', async () => {
      await expect(
        createContainer({ name: 'X', parent_id: 'a', container_id: 'b' } as never, {}, {} as never)
      ).rejects.toThrow(/`parent_id` and `container_id` were both provided/);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('resolves a bare `container` key holding a real container id', async () => {
      mockFindById.mockResolvedValueOnce({ id: 'c-loose', name: 'Somewhere' });
      await createContainer({ name: 'Child', container: 'c-loose' } as never, {}, {} as never);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'c-loose' }));
      expect(mockResolveContainerReference).not.toHaveBeenCalled();
    });

    it('errors loudly when a provided `parent` does not resolve — never falls back to root', async () => {
      await expect(
        createContainer(
          { name: 'Misplaced', parent: 'Release Notes (demo)' } as never,
          {},
          {} as never
        )
      ).rejects.toThrow(
        /create_container: `parent` "Release Notes \(demo\)" did not resolve to a container[\s\S]*`node` \(op tree\)/
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('wraps an unknown parent_id with lookup guidance and the name-hit hint', async () => {
      mockResolveContainerReference.mockRejectedValueOnce(
        new Error('Container not found: Archive')
      );
      mockResolveContainerByPath.mockResolvedValueOnce('c-archive');
      await expect(
        createContainer({ name: 'X', parent_id: 'Archive' } as never, {}, {} as never)
      ).rejects.toThrow(/a container by that NAME exists \(id="c-archive"\)/);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('sibling uniqueness', () => {
    it('throws when a sibling with the same name (case-insensitive) exists', async () => {
      mockListByParent.mockResolvedValueOnce([{ id: 'sib-1', name: 'Existing', sortOrder: 0 }]);
      await expect(createContainer({ name: 'existing' } as never, {}, {} as never)).rejects.toThrow(
        /already exists at this level \(id=sib-1\)/
      );
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('allows the same name under a different parent', async () => {
      // root has "Notes", new parent is 'p-1' which has no children
      mockResolveContainerReference.mockResolvedValueOnce('p-1');
      mockListByParent.mockResolvedValueOnce([]);
      await createContainer({ name: 'Notes', parent_id: 'p-1' } as never, {}, {} as never);
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  describe('sort_order defaulting', () => {
    it('defaults to 0 when no siblings exist', async () => {
      mockListByParent.mockResolvedValueOnce([]);
      await createContainer({ name: 'First' } as never, {}, {} as never);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 0 }));
    });

    it('defaults to max(sibling.sortOrder) + 1 when siblings exist', async () => {
      mockListByParent.mockResolvedValueOnce([
        { id: 'a', name: 'A', sortOrder: 2 },
        { id: 'b', name: 'B', sortOrder: 5 },
        { id: 'c', name: 'C', sortOrder: 3 },
      ]);
      await createContainer({ name: 'New' } as never, {}, {} as never);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 6 }));
    });

    it('respects explicit sort_order when provided', async () => {
      mockListByParent.mockResolvedValueOnce([{ id: 'a', name: 'A', sortOrder: 10 }]);
      await createContainer({ name: 'New', sort_order: 0 } as never, {}, {} as never);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 0 }));
    });
  });

  describe('output shape', () => {
    it('returns { output, rawContent } with success, container, link', async () => {
      mockCreate.mockResolvedValueOnce({
        id: 'container-xyz',
        name: 'Specs',
        parentId: null,
        sortOrder: 0,
        createdAt: new Date('2024-06-15T10:00:00Z'),
      });
      const result = await createContainer({ name: 'Specs' } as never, {}, {} as never);
      // ToolHandler may return string or { output, rawContent }; assert object shape.
      expect(typeof result).toBe('object');
      const obj = result as {
        output: string;
        rawContent: { container: { id: string }; link: string; success: boolean };
      };
      expect(obj.rawContent.success).toBe(true);
      expect(obj.rawContent.container.id).toBe('container-xyz');
      expect(obj.rawContent.link).toMatch(/container-xyz/);
      // Output is valid JSON of the same content.
      expect(JSON.parse(obj.output).container.id).toBe('container-xyz');
    });
  });
});
