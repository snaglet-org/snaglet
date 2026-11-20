import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted)
const mockPoolQuery = jest.fn();
const mockResolveDocByPath = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: jest.fn(() => ({ query: mockPoolQuery })),
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

import handler from '../../../../../../../apps/server/src/services/ToolService/handlers/docs/history/list';
import { runTool } from '../../../../../../support/toolHarness';

const pgRows = (rows: unknown[]) => ({ rows });

interface ListSnapshotsResult {
  doc_id: string;
  count: number;
  truncated: boolean;
  snapshots: Array<{
    id?: string;
    content?: string;
    created_at?: string;
    label?: string | null;
    reason?: string | null;
  }>;
}

async function runList(input: unknown): Promise<ListSnapshotsResult> {
  return runTool<ListSnapshotsResult>(handler, input);
}

function makeRow(
  overrides: Partial<{
    id: string;
    doc_id: string;
    content_bytes: number;
    label: string | null;
    reason: string | null;
    created_by: string | null;
    created_at: string;
    content: string;
  }> = {}
) {
  return {
    id: 'snap-1',
    doc_id: 'doc-1',
    content_bytes: 11,
    label: null,
    reason: null,
    created_by: null,
    created_at: '2026-01-09T14:17:01.000Z',
    ...overrides,
  };
}

describe('workspace_list_snapshots', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockResolveDocByPath.mockReset();
  });

  describe('input validation', () => {
    it('throws when neither doc_id nor doc_path is provided', async () => {
      await expect(runList({})).rejects.toThrow(/Must specify either doc_id or doc_path/);
    });

    it('throws when both doc_id and doc_path are provided', async () => {
      await expect(runList({ doc_id: 'doc-1', doc_path: '/x' })).rejects.toThrow(
        /Cannot specify both/
      );
    });

    it('rejects limit over 200', async () => {
      await expect(runList({ doc_id: 'doc-1', limit: 201 })).rejects.toThrow();
    });

    it('rejects non-positive limit', async () => {
      await expect(runList({ doc_id: 'doc-1', limit: 0 })).rejects.toThrow();
    });
  });

  describe('happy path', () => {
    it('returns metadata-only snapshots by default (no content field)', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([
          makeRow({ id: 'snap-1', content_bytes: 10 }),
          makeRow({ id: 'snap-2', content_bytes: 20 }),
        ])
      );

      const result = await runList({ doc_id: 'doc-1' });

      expect(result).toMatchObject({
        success: true,
        doc_id: 'doc-1',
        count: 2,
        truncated: false,
      });
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0]).toMatchObject({
        snapshot_id: 'snap-1',
        doc_id: 'doc-1',
        content_bytes: 10,
      });
      // No content field in default mode
      expect(result.snapshots[0].content).toBeUndefined();

      // SQL should not include `content` column
      const sql = mockPoolQuery.mock.calls[0]![0] as string;
      expect(sql).not.toMatch(/,\s*content\b/);
    });

    it('includes content when include_content is true', async () => {
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([makeRow({ id: 'snap-1', content: 'Hello world' })])
      );

      const result = await runList({
        doc_id: 'doc-1',
        include_content: true,
      });

      expect(result.snapshots[0].content).toBe('Hello world');
      const sql = mockPoolQuery.mock.calls[0]![0] as string;
      expect(sql).toMatch(/,\s*content/);
    });

    it('orders by created_at DESC', async () => {
      mockPoolQuery.mockResolvedValueOnce(pgRows([]));
      await runList({ doc_id: 'doc-1' });
      const sql = mockPoolQuery.mock.calls[0]![0] as string;
      expect(sql).toMatch(/ORDER BY created_at DESC/);
    });

    it('filters by label when provided', async () => {
      mockPoolQuery.mockResolvedValueOnce(pgRows([]));
      await runList({ doc_id: 'doc-1', label: 'pre-refactor' });

      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/label\s*=\s*\$2/);
      expect(params).toContain('pre-refactor');
    });

    it('resolves doc_path via resolveDocByPath', async () => {
      mockResolveDocByPath.mockResolvedValueOnce('doc-from-path');
      mockPoolQuery.mockResolvedValueOnce(pgRows([]));

      const result = await runList({ doc_path: '/projects/foo' });

      expect(mockResolveDocByPath).toHaveBeenCalledWith('/projects/foo');
      expect(result.doc_id).toBe('doc-from-path');
      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params[0]).toBe('doc-from-path');
    });
  });

  describe('truncation', () => {
    it('reports truncated:true and trims to limit when more rows exist', async () => {
      // Tool queries `limit + 1`. We return `limit + 1` rows to signal more available.
      const rows = Array.from({ length: 3 }, (_, i) => makeRow({ id: `snap-${i}` }));
      mockPoolQuery.mockResolvedValueOnce(pgRows(rows));

      const result = await runList({ doc_id: 'doc-1', limit: 2 });

      expect(result.count).toBe(2);
      expect(result.snapshots).toHaveLength(2);
      expect(result.truncated).toBe(true);

      // The tool requested limit+1 rows
      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params[params.length - 1]).toBe(3);
    });

    it('reports truncated:false when fewer rows than limit', async () => {
      mockPoolQuery.mockResolvedValueOnce(pgRows([makeRow({ id: 'snap-1' })]));

      const result = await runList({ doc_id: 'doc-1', limit: 50 });

      expect(result.truncated).toBe(false);
      expect(result.count).toBe(1);
    });
  });

  describe('Date objects from pg', () => {
    it('serializes Date created_at into ISO strings', async () => {
      const d = new Date('2026-02-15T10:00:00.000Z');
      mockPoolQuery.mockResolvedValueOnce(
        pgRows([makeRow({ id: 'snap-1', created_at: d as unknown as string })])
      );

      const result = await runList({ doc_id: 'doc-1' });

      expect(result.snapshots[0].created_at).toBe('2026-02-15T10:00:00.000Z');
    });
  });

  describe('default limit', () => {
    it('uses limit=50 when not specified', async () => {
      mockPoolQuery.mockResolvedValueOnce(pgRows([]));
      await runList({ doc_id: 'doc-1' });
      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params[params.length - 1]).toBe(51); // limit + 1
    });
  });
});
