import { beforeEach, describe, expect, it } from '@jest/globals';

const mockResolveNodeByPath = jest.fn();
const mockContainerFindById = jest.fn();
const mockDocFindById = jest.fn();

jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: { findById: mockContainerFindById },
}));
jest.mock('@snaglet/db/tables/docs', () => ({
  Docs: { findById: mockDocFindById },
}));
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveNodeByPath: mockResolveNodeByPath,
}));

import resolvePath from '@server/services/ToolService/handlers/trivial/workspaceResolvePath';

type Out = { output: string; rawContent: Record<string, unknown> };

describe('workspace_resolve_path', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('input validation', () => {
    it('throws when input is not an object', async () => {
      await expect(resolvePath(null as never, {}, {} as never)).rejects.toThrow(
        /must be an object/
      );
    });

    it('throws when path is missing', async () => {
      await expect(resolvePath({} as never, {}, {} as never)).rejects.toThrow(/`path` is required/);
    });

    it('throws when path is whitespace', async () => {
      await expect(resolvePath({ path: '  ' } as never, {}, {} as never)).rejects.toThrow(
        /`path` is required/
      );
    });

    it('throws when kind is invalid', async () => {
      await expect(
        resolvePath({ path: '/x', kind: 'thread' } as never, {}, {} as never)
      ).rejects.toThrow(/`kind` must be "doc" or "container"/);
    });

    it('throws when strict is not boolean', async () => {
      await expect(
        resolvePath({ path: '/x', strict: 'yes' } as never, {}, {} as never)
      ).rejects.toThrow(/`strict` must be a boolean/);
    });
  });

  describe('found: container', () => {
    it('returns container metadata with link', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'container', id: 'container-1' });
      mockContainerFindById.mockResolvedValueOnce({
        id: 'container-1',
        name: 'Snaglet',
        parentId: null,
        sortOrder: 3,
      });
      const result = (await resolvePath({ path: '/Snaglet' } as never, {}, {} as never)) as Out;
      expect(result.rawContent).toEqual({
        found: true,
        path: '/Snaglet',
        kind: 'container',
        id: 'container-1',
        name: 'Snaglet',
        parent_id: null,
        sort_order: 3,
        link: expect.stringContaining('container-1'),
      });
    });

    it('passes kind hint to resolver', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'container', id: 'c-1' });
      mockContainerFindById.mockResolvedValueOnce({
        id: 'c-1',
        name: 'X',
        parentId: null,
        sortOrder: 0,
      });
      await resolvePath({ path: '/X', kind: 'container' } as never, {}, {} as never);
      expect(mockResolveNodeByPath).toHaveBeenCalledWith('/X', 'container');
    });
  });

  describe('found: doc', () => {
    it('returns doc metadata with link and content_length', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'doc', id: 'doc-7' });
      mockDocFindById.mockResolvedValueOnce({
        id: 'doc-7',
        title: 'Onboarding',
        containerId: 'container-9',
        sortOrder: 1,
        content: 'Hello world.',
      });
      const result = (await resolvePath(
        { path: '/Snaglet/docs/Onboarding' } as never,
        {},
        {} as never
      )) as Out;
      expect(result.rawContent).toMatchObject({
        found: true,
        kind: 'doc',
        id: 'doc-7',
        title: 'Onboarding',
        container_id: 'container-9',
        sort_order: 1,
        content_length: 'Hello world.'.length,
      });
      expect(result.rawContent.link).toMatch(/doc-7/);
    });

    it('handles missing content gracefully (length 0)', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'doc', id: 'doc-empty' });
      mockDocFindById.mockResolvedValueOnce({
        id: 'doc-empty',
        title: 'Empty',
        containerId: null,
        sortOrder: 0,
        content: null,
      });
      const result = (await resolvePath({ path: '/Empty' } as never, {}, {} as never)) as Out;
      expect(result.rawContent.content_length).toBe(0);
    });
  });

  describe('not found (strict: false, default)', () => {
    it('returns { found: false } when resolver throws', async () => {
      mockResolveNodeByPath.mockRejectedValueOnce(new Error('not found'));
      const result = (await resolvePath({ path: '/missing' } as never, {}, {} as never)) as Out;
      expect(result.rawContent).toEqual({ found: false, path: '/missing' });
    });

    it('returns { found: false } when container disappears between resolve and find', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'container', id: 'c-gone' });
      mockContainerFindById.mockResolvedValueOnce(null);
      const result = (await resolvePath({ path: '/gone' } as never, {}, {} as never)) as Out;
      expect(result.rawContent).toEqual({ found: false, path: '/gone' });
    });

    it('returns { found: false } when doc disappears between resolve and find', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'doc', id: 'd-gone' });
      mockDocFindById.mockResolvedValueOnce(null);
      const result = (await resolvePath({ path: '/d-gone' } as never, {}, {} as never)) as Out;
      expect(result.rawContent).toEqual({ found: false, path: '/d-gone' });
    });
  });

  describe('not found (strict: true)', () => {
    it('rethrows resolver error', async () => {
      mockResolveNodeByPath.mockRejectedValueOnce(new Error('path does not resolve'));
      await expect(
        resolvePath({ path: '/missing', strict: true } as never, {}, {} as never)
      ).rejects.toThrow(/path does not resolve/);
    });

    it('throws when container disappears', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'container', id: 'c-gone' });
      mockContainerFindById.mockResolvedValueOnce(null);
      await expect(
        resolvePath({ path: '/gone', strict: true } as never, {}, {} as never)
      ).rejects.toThrow(/disappeared during resolution/);
    });

    it('throws when doc disappears', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'doc', id: 'd-gone' });
      mockDocFindById.mockResolvedValueOnce(null);
      await expect(
        resolvePath({ path: '/d-gone', strict: true } as never, {}, {} as never)
      ).rejects.toThrow(/disappeared during resolution/);
    });
  });

  describe('output format', () => {
    it('output JSON matches rawContent', async () => {
      mockResolveNodeByPath.mockResolvedValueOnce({ kind: 'container', id: 'c-1' });
      mockContainerFindById.mockResolvedValueOnce({
        id: 'c-1',
        name: 'A',
        parentId: null,
        sortOrder: 0,
      });
      const result = (await resolvePath({ path: '/A' } as never, {}, {} as never)) as Out;
      expect(JSON.parse(result.output)).toEqual(result.rawContent);
    });
  });
});
