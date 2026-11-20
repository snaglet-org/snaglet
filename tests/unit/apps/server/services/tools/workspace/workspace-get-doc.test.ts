import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks declared before module imports (jest.mock is hoisted).
const mockPoolQuery = jest.fn();
const mockResolveDocByPath = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(() => ({ query: mockPoolQuery })),
}));

jest.mock('@server/services/WorkspaceService/pathResolver.js', () => ({
  resolveDocByPath: mockResolveDocByPath,
}));

import executeWorkspaceGetDoc from '../../../../../../../apps/server/src/services/ToolService/handlers/docs/getDoc';

/** Helper: pg.Pool#query returns { rows, rowCount, ... }. We only use rows. */
const pgRows = (rows: unknown[]) => ({ rows });

describe('workspace_get_doc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Queries after the doc row (who transcludes this doc) find nothing.
    mockPoolQuery.mockResolvedValue(pgRows([]));
  });

  describe('input validation', () => {
    it('throws when neither doc_id nor doc_path is provided', async () => {
      await expect(executeWorkspaceGetDoc({})).rejects.toThrow(
        /Must specify either doc_id or doc_path/
      );
    });

    it('throws when both doc_id and doc_path are provided', async () => {
      await expect(executeWorkspaceGetDoc({ doc_id: 'doc-1', doc_path: '/a' })).rejects.toThrow(
        /Cannot specify both doc_id and doc_path/
      );
    });
  });

  describe('input resolution', () => {
    // Transclusion expansion and the lists are covered against a real
    // database in tests/integration/.../docs/transclusions.test.ts.
    it('uses doc_id directly without calling resolveDocByPath', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([
          {
            id: 'doc-123',
            title: 'Hello',
            content: 'plain content',
            container_id: null,
            sort_order: 0,
          },
        ])
      );

      const result = await executeWorkspaceGetDoc({ doc_id: 'doc-123' });

      expect(mockResolveDocByPath).not.toHaveBeenCalled();
      expect(mockPoolQuery).toHaveBeenNthCalledWith(1, expect.stringContaining('FROM docs'), [
        'doc-123',
      ]);
      expect(result).toMatchObject({
        id: 'doc-123',
        title: 'Hello',
        content: 'plain content',
      });
      // No transclusions either way: both lists are omitted, not empty.
      expect(result).not.toHaveProperty('transclusions');
      expect(result).not.toHaveProperty('transcluded_in');
    });

    it('does not select or return the legacy task fields (tasks are table rows)', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([{ id: 'doc-9', title: 'T', content: 'c', container_id: null, sort_order: 0 }])
      );

      const result = await executeWorkspaceGetDoc({ doc_id: 'doc-9' });
      const sql = String(mockPoolQuery.mock.calls[0][0]);
      for (const field of ['due_at', 'assigned_to', 'priority']) {
        expect(sql).not.toContain(field);
        expect(result).not.toHaveProperty(field);
      }
    });

    it('resolves doc by doc_path via resolveDocByPath', async () => {
      mockResolveDocByPath.mockResolvedValueOnce('doc-from-path');
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([
          {
            id: 'doc-from-path',
            title: 'Path Doc',
            content: 'body',
            container_id: 'ctr-1',
            sort_order: 2,
          },
        ])
      );

      const result = await executeWorkspaceGetDoc({ doc_path: '/projects/path-doc' });

      expect(mockResolveDocByPath).toHaveBeenCalledWith('/projects/path-doc');
      expect(mockPoolQuery).toHaveBeenNthCalledWith(1, expect.stringContaining('FROM docs'), [
        'doc-from-path',
      ]);
      expect(result.id).toBe('doc-from-path');
    });

    it('throws when the document is not found', async () => {
      mockPoolQuery.mockResolvedValueOnce(pgRows([]));

      await expect(executeWorkspaceGetDoc({ doc_id: 'missing' })).rejects.toThrow(
        /Document not found: missing/
      );
    });

    it('uses doc_path in the not-found error message when path was provided', async () => {
      mockResolveDocByPath.mockResolvedValueOnce('doc-ghost');
      mockPoolQuery.mockResolvedValueOnce(pgRows([]));

      await expect(executeWorkspaceGetDoc({ doc_path: '/ghost' })).rejects.toThrow(
        /Document not found: \/ghost/
      );
    });
  });
});
