import { beforeEach, describe, expect, it } from '@jest/globals';

const mockContainerFindById = jest.fn();
const mockResolveContainerByPath = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: { findById: mockContainerFindById },
}));
jest.mock('@snaglet/db', () => ({
  getPool: () => ({ query: mockPoolQuery }),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: () => ({ query: mockPoolQuery }),
}));
jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveContainerByPath: mockResolveContainerByPath,
}));

import bulkExport from '@server/services/ToolService/tools/workspace/bulk-export/tool';

type Out = { output: string; rawContent: Record<string, unknown> };
const call = (input: unknown) => bulkExport(input as never, {}, {} as never) as Promise<Out>;

// loadAll() makes two pool.query calls (containers + docs).
function stubLoadAll(containers: unknown[], docs: unknown[]) {
  mockPoolQuery.mockResolvedValueOnce({ rows: containers }).mockResolvedValueOnce({ rows: docs });
}

describe('bulk_export', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('input validation', () => {
    it('accepts no args (exports full workspace)', async () => {
      stubLoadAll([], []);
      const out = await call(undefined);
      const tree = out.rawContent.tree as { kind: string; name: string; children: unknown[] };
      expect(tree.kind).toBe('container');
      expect(tree.name).toBe('<workspace>');
      expect(tree.children).toEqual([]);
      expect(out.rawContent.root_id).toBeNull();
    });

    it('rejects both root_id and root_path', async () => {
      await expect(call({ root_id: 'c-1', root_path: '/x' })).rejects.toThrow(/not both/);
    });

    it('rejects out-of-range max_nodes', async () => {
      await expect(call({ max_nodes: 0 })).rejects.toThrow(/`max_nodes` must be/);
      await expect(call({ max_nodes: 99999 })).rejects.toThrow(/`max_nodes` must be/);
    });
  });

  describe('root resolution', () => {
    it('uses Containers.findById for root_id', async () => {
      mockContainerFindById.mockResolvedValueOnce({ id: 'c-root', name: 'Root' });
      stubLoadAll([{ id: 'c-root', name: 'Root', parent_id: null, sort_order: 0 }], []);
      const out = await call({ root_id: 'c-root' });
      expect(mockContainerFindById).toHaveBeenCalledWith('c-root');
      const tree = out.rawContent.tree as { name: string };
      expect(tree.name).toBe('Root');
      expect(out.rawContent.root_id).toBe('c-root');
    });

    it('uses resolveContainerByPath for root_path', async () => {
      mockResolveContainerByPath.mockResolvedValueOnce('c-99');
      stubLoadAll([{ id: 'c-99', name: 'X', parent_id: null, sort_order: 0 }], []);
      const out = await call({ root_path: '/X' });
      expect(mockResolveContainerByPath).toHaveBeenCalledWith('/X');
      expect(out.rawContent.root_id).toBe('c-99');
    });

    it('throws when root_id does not exist', async () => {
      mockContainerFindById.mockResolvedValueOnce(null);
      await expect(call({ root_id: 'c-missing' })).rejects.toThrow(/not found/);
    });

    it('throws when root_path does not resolve', async () => {
      mockResolveContainerByPath.mockResolvedValueOnce(null);
      await expect(call({ root_path: '/missing' })).rejects.toThrow(/did not resolve/);
    });
  });

  describe('tree assembly', () => {
    it('builds a nested tree from full workspace', async () => {
      // Structure:
      //   <workspace>
      //     - Folder A (c-a)
      //         - Sub A1 (c-a1)
      //             - doc d-a1-1
      //         - doc d-a-1
      //     - doc d-root-1
      stubLoadAll(
        [
          { id: 'c-a', name: 'Folder A', parent_id: null, sort_order: 0 },
          { id: 'c-a1', name: 'Sub A1', parent_id: 'c-a', sort_order: 0 },
        ],
        [
          {
            id: 'd-root-1',
            title: 'Root Doc',
            container_id: null,
            content: 'hello',
            sort_order: 0,
          },
          { id: 'd-a-1', title: 'A Doc', container_id: 'c-a', content: 'in A', sort_order: 0 },
          { id: 'd-a1-1', title: 'A1 Doc', container_id: 'c-a1', content: 'in A1', sort_order: 0 },
        ]
      );
      const out = await call(undefined);
      const tree = out.rawContent.tree as { children: unknown[] };
      // Top level: 1 container + 1 doc
      expect(tree.children).toHaveLength(2);
      const folderA = tree.children[0] as { name: string; children: unknown[] };
      expect(folderA.name).toBe('Folder A');
      expect(folderA.children).toHaveLength(2); // Sub A1 + A Doc
      const subA1 = folderA.children[0] as { name: string; children: unknown[] };
      expect(subA1.name).toBe('Sub A1');
      expect(subA1.children).toHaveLength(1);
      const a1Doc = subA1.children[0] as { kind: string; title: string; content: string };
      expect(a1Doc).toEqual({ kind: 'doc', title: 'A1 Doc', content: 'in A1' });
      expect(out.rawContent.node_count).toBe(5);
      expect(out.rawContent.truncated).toBe(false);
    });

    it('excludes content when include_content=false', async () => {
      stubLoadAll(
        [],
        [{ id: 'd-1', title: 'D', container_id: null, content: 'should-not-appear', sort_order: 0 }]
      );
      const out = await call({ include_content: false });
      const tree = out.rawContent.tree as { children: Array<{ content?: string; title: string }> };
      expect(tree.children[0]).toEqual({ kind: 'doc', title: 'D' });
      expect(tree.children[0]).not.toHaveProperty('content');
    });

    it('exports a subtree when root_id is set', async () => {
      mockContainerFindById.mockResolvedValueOnce({ id: 'c-a', name: 'A' });
      stubLoadAll(
        [
          { id: 'c-a', name: 'A', parent_id: null, sort_order: 0 },
          { id: 'c-other', name: 'Other', parent_id: null, sort_order: 1 },
        ],
        [
          {
            id: 'd-other',
            title: 'Other Doc',
            container_id: 'c-other',
            content: '',
            sort_order: 0,
          },
          { id: 'd-a', title: 'A Doc', container_id: 'c-a', content: 'in A', sort_order: 0 },
        ]
      );
      const out = await call({ root_id: 'c-a' });
      const tree = out.rawContent.tree as { name: string; children: Array<{ title?: string }> };
      expect(tree.name).toBe('A');
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].title).toBe('A Doc');
      // Did not include c-other or its docs.
      expect(JSON.stringify(out.rawContent)).not.toContain('Other Doc');
    });

    it('truncates at max_nodes and reports it', async () => {
      stubLoadAll(
        [
          { id: 'c-1', name: 'C1', parent_id: null, sort_order: 0 },
          { id: 'c-2', name: 'C2', parent_id: null, sort_order: 1 },
          { id: 'c-3', name: 'C3', parent_id: null, sort_order: 2 },
        ],
        []
      );
      const out = await call({ max_nodes: 2 });
      expect(out.rawContent.truncated).toBe(true);
      expect(out.rawContent.node_count).toBe(2);
    });

    it('returns empty workspace when both containers and docs are empty', async () => {
      stubLoadAll([], []);
      const out = await call(undefined);
      const tree = out.rawContent.tree as { children: unknown[] };
      expect(tree.children).toEqual([]);
      expect(out.rawContent.node_count).toBe(0);
    });
  });

  describe('output shape', () => {
    it('output JSON matches rawContent', async () => {
      stubLoadAll([], []);
      const out = await call(undefined);
      expect(JSON.parse(out.output)).toEqual(out.rawContent);
    });
  });
});
