import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted)
const mockPoolQuery = jest.fn();
const mockFindById = jest.fn();
const mockResolveDocByPath = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(() => ({ query: mockPoolQuery })),
}));

jest.mock('@snaglet/db/tables/docs', () => ({
  Docs: { findById: mockFindById },
}));
jest.mock('../../../../../../../packages/db/tables/docs/index.js', () => ({
  Docs: { findById: mockFindById },
}));

jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveDocByPath: mockResolveDocByPath,
  // Faithful stand-in for the shared resolver the tools call (same
  // validation semantics as WorkspaceService/pathResolver.resolveDocIdOrThrow).
  resolveDocIdOrThrow: async (args: { doc_id?: string; doc_path?: string }) => {
    if (!args.doc_id && !args.doc_path) throw new Error('Must specify either doc_id or doc_path');
    if (args.doc_id && args.doc_path) throw new Error('Cannot specify both doc_id and doc_path');
    return args.doc_id ?? mockResolveDocByPath(args.doc_path);
  },
}));

import handler from '../../../../../../../apps/server/src/services/ToolService/handlers/docs/deleteDoc';
import { runTool } from '../../../../../../support/toolHarness';

const pgRows = (rows: unknown[]) => ({ rows });

interface DeleteDocResult {
  doc_id?: string;
  deleted?: boolean;
  dry_run?: boolean;
  forced?: boolean;
  snapshots_deleted?: number;
  transcluded_in?: Array<{ id: string; title: string; archived?: true }>;
  linked_from?: Array<{ id: string; title: string; archived?: true }>;
  warnings?: string[];
}

async function runDelete(input: unknown): Promise<DeleteDocResult> {
  return runTool<DeleteDocResult>(handler, input);
}

function makeDoc(overrides: Partial<{ id: string; title: string }> = {}) {
  return {
    id: 'doc-1',
    title: 'My Doc',
    content: 'body',
    container_id: null,
    sort_order: 0,
    ...overrides,
  };
}

/**
 * Helper: mock the standard query sequence used by the tool when no doc
 * transcludes the target.
 *   1) transcluded_in SELECT -> []
 *   2) snapshots COUNT -> [{ count }]
 *   3) (if not dry_run) DELETE FROM docs -> []
 */
/** A referring doc row as the links query returns it, transcluding `target`. */
const transcluding = (id: string, title: string, target = 'doc-1', archived = false) => ({
  id,
  title,
  content: `![](${target})`,
  archived,
});

/** A referring doc row that only links to `target`, through part of it. */
const linking = (id: string, title: string, target = 'doc-1') => ({
  id,
  title,
  content: `See [it](${target}#h=setup).`,
  archived: false,
});

function setupNotTranscluded(snapshotsCount = 0) {
  mockPoolQuery.mockResolvedValueOnce(pgRows([])); // docs whose content names it
  mockPoolQuery.mockResolvedValueOnce(pgRows([{ count: String(snapshotsCount) }])); // snapshot count
  mockPoolQuery.mockResolvedValueOnce(pgRows([])); // DELETE
}

describe('workspace_delete_doc', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockFindById.mockReset();
    mockResolveDocByPath.mockReset();
  });

  describe('input validation', () => {
    it('throws when neither doc_id nor doc_path is provided', async () => {
      await expect(runDelete({})).rejects.toThrow(/Must specify either doc_id or doc_path/);
    });

    it('throws when both doc_id and doc_path are provided', async () => {
      await expect(runDelete({ doc_id: 'doc-1', doc_path: '/x' })).rejects.toThrow(
        /Cannot specify both/
      );
    });

    it('throws when document is not found', async () => {
      mockFindById.mockResolvedValueOnce(null);
      await expect(runDelete({ doc_id: 'missing' })).rejects.toThrow(/Document not found: missing/);
    });

    it('resolves doc_path via resolveDocByPath', async () => {
      mockResolveDocByPath.mockResolvedValueOnce('doc-from-path');
      mockFindById.mockResolvedValueOnce(makeDoc({ id: 'doc-from-path' }));
      setupNotTranscluded();

      const result = await runDelete({ doc_path: '/projects/foo' });

      expect(mockResolveDocByPath).toHaveBeenCalledWith('/projects/foo');
      expect(result.doc_id).toBe('doc-from-path');
      expect(result.deleted).toBe(true);
    });
  });

  describe('happy path (nothing transcludes the doc)', () => {
    it('deletes the doc and reports zero snapshots', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      setupNotTranscluded(0);

      const result = await runDelete({ doc_id: 'doc-1' });

      expect(result).toMatchObject({
        success: true,
        doc_id: 'doc-1',
        doc_title: 'My Doc',
        deleted: true,
        dry_run: false,
        forced: false,
        transcluded_in: [],
        snapshots_deleted: 0,
        warnings: [],
      });

      // Validate DELETE was called with the right id
      const deleteCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM nodes')
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall![1]).toEqual(['doc-1']);
    });

    it('reports cascaded snapshots_deleted from the count query', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      setupNotTranscluded(7);

      const result = await runDelete({ doc_id: 'doc-1' });

      expect(result.snapshots_deleted).toBe(7);
    });

    it('warns (but does not fail) if snapshot count query throws', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([])); // referrers
      mockPoolQuery.mockRejectedValueOnce(new Error('relation "doc_snapshots" does not exist')); // count fails
      mockPoolQuery.mockResolvedValueOnce(pgRows([])); // DELETE still proceeds

      const result = await runDelete({ doc_id: 'doc-1' });

      expect(result.deleted).toBe(true);
      expect(result.snapshots_deleted).toBe(0);
      expect(result.warnings!.some((w) => /snapshot/i.test(w))).toBe(true);
    });
  });

  describe('reference safety check', () => {
    it('refuses while other docs transclude or link to it, naming which do which', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([
          transcluding('doc-ref-b', 'Doc B', 'doc-1', true),
          linking('doc-ref-c', 'Doc C'),
          transcluding('doc-ref-a', 'Doc A'),
        ])
      );

      await expect(runDelete({ doc_id: 'doc-1' })).rejects.toThrow(
        'Refusing to delete "My Doc" (doc-1): of the other docs, 2 transclude it ' +
          '("Doc A" (doc-ref-a), "Doc B" (doc-ref-b) [archived]) and 1 only link to it ' +
          '("Doc C" (doc-ref-c)).'
      );

      // No DELETE should have happened
      const deleteCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM nodes')
      );
      expect(deleteCall).toBeUndefined();
    });

    it('refuses while a doc only links to it', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([linking('doc-ref-c', 'Doc C')]));

      await expect(runDelete({ doc_id: 'doc-1' })).rejects.toThrow(
        '1 only link to it ("Doc C" (doc-ref-c))'
      );
    });

    it('proceeds when force is true and names what loses the doc', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([transcluding('doc-ref-a', 'Doc A'), linking('doc-ref-c', 'Doc C')])
      );
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ count: '0' }])); // snap count
      mockPoolQuery.mockResolvedValueOnce(pgRows([])); // DELETE

      const result = await runDelete({ doc_id: 'doc-1', force: true });

      expect(result.deleted).toBe(true);
      expect(result.forced).toBe(true);
      expect(result.transcluded_in).toEqual([{ id: 'doc-ref-a', title: 'Doc A' }]);
      expect(result.linked_from).toEqual([{ id: 'doc-ref-c', title: 'Doc C' }]);
      expect(result.warnings).toEqual([
        'Forced delete: "Doc A" (doc-ref-a) transclude this doc and will show it as missing.',
        'Forced delete: "Doc C" (doc-ref-c) link to this doc; those links will break.',
      ]);
    });
  });

  describe('dry_run mode', () => {
    it('does not call DELETE when dry_run is true', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([])); // referrers
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ count: '3' }])); // snap count

      const result = await runDelete({ doc_id: 'doc-1', dry_run: true });

      expect(result.deleted).toBe(false);
      expect(result.dry_run).toBe(true);
      expect(result.snapshots_deleted).toBe(3);

      const deleteCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('DELETE FROM nodes')
      );
      expect(deleteCall).toBeUndefined();
    });

    it('dry_run still refuses while the doc is transcluded and force is false', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([transcluding('doc-ref-a', 'Doc A')]));

      await expect(runDelete({ doc_id: 'doc-1', dry_run: true })).rejects.toThrow(
        /Refusing to delete/
      );
    });

    it('dry_run + force lists the docs that transclude it and those that link to it', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([transcluding('doc-ref-a', 'Doc A'), linking('doc-ref-c', 'Doc C')])
      ); // referrers
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ count: '0' }])); // snap count

      const result = await runDelete({
        doc_id: 'doc-1',
        force: true,
        dry_run: true,
      });

      expect(result.deleted).toBe(false);
      expect(result.dry_run).toBe(true);
      expect(result.forced).toBe(true);
      expect(result.transcluded_in).toHaveLength(1);
      expect(result.linked_from).toHaveLength(1);
      expect(result.warnings!.length).toBe(2);
    });
  });

  describe('referrers scan', () => {
    it('scans content for the id once, since the links graph misses references', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ id: 'doc-target' }));
      setupNotTranscluded();

      await runDelete({ doc_id: 'doc-target' });

      const queries = mockPoolQuery.mock.calls.map((c) => String(c[0]));
      expect(queries.filter((q) => q.includes('FROM links'))).toEqual([]);
      const scan = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('content LIKE'));
      expect(scan![1]).toEqual(['doc-target', '%doc-target%']);
    });

    it('does not count a reference that only appears inside code', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([
          {
            id: 'doc-ref-x',
            title: 'X',
            content: '```\n![](doc-1) [it](doc-1)\n```',
            archived: false,
          },
        ])
      );
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ count: '0' }])); // snap count
      mockPoolQuery.mockResolvedValueOnce(pgRows([])); // DELETE

      const result = await runDelete({ doc_id: 'doc-1' });
      expect(result.deleted).toBe(true);
      expect(result.transcluded_in).toEqual([]);
      expect(result.linked_from).toEqual([]);
    });

    it('excludes the target doc itself from the search', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ id: 'doc-self' }));
      setupNotTranscluded();

      await runDelete({ doc_id: 'doc-self' });

      const refQuery = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('content LIKE')
      );
      expect((refQuery as [string, unknown[]])[0]).toMatch(/d\.id\s*<>\s*\$1/);
    });
  });
});
