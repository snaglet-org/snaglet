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
// Belt + braces: also stub the resolved path in case alias bypassed.
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

import handler from '../../../../../../../apps/server/src/services/ToolService/handlers/docs/history/snapshot';
import { runTool } from '../../../../../../support/toolHarness';
import type { ToolHandlerContext } from '../../../../../../support/toolHarness';

const pgRows = (rows: unknown[]) => ({ rows });

interface SnapshotDocResult {
  snapshot_id: string;
  doc_id: string;
  label: string | null;
  reason: string | null;
  content_bytes: number;
}

async function runSnapshot(
  input: unknown,
  context: ToolHandlerContext = {}
): Promise<SnapshotDocResult> {
  return runTool<SnapshotDocResult>(handler, input, context);
}

function makeDoc(overrides: Partial<{ id: string; title: string; content: string }> = {}) {
  return {
    id: 'doc-1',
    title: 'My Doc',
    content: 'Hello world',
    container_id: null,
    sort_order: 0,
    ...overrides,
  };
}

describe('workspace_snapshot_doc', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockFindById.mockReset();
    mockResolveDocByPath.mockReset();
  });

  describe('input validation', () => {
    it('throws when neither doc_id nor doc_path is provided', async () => {
      await expect(runSnapshot({})).rejects.toThrow(/Must specify either doc_id or doc_path/);
    });

    it('throws when both doc_id and doc_path are provided', async () => {
      await expect(runSnapshot({ doc_id: 'doc-1', doc_path: '/x' })).rejects.toThrow(
        /Cannot specify both/
      );
    });

    it('throws when document is not found', async () => {
      mockFindById.mockResolvedValueOnce(null);
      await expect(runSnapshot({ doc_id: 'missing' })).rejects.toThrow(
        /Document not found: missing/
      );
    });

    it('rejects label over 120 chars', async () => {
      await expect(runSnapshot({ doc_id: 'doc-1', label: 'x'.repeat(121) })).rejects.toThrow();
    });

    it('rejects reason over 1000 chars', async () => {
      await expect(runSnapshot({ doc_id: 'doc-1', reason: 'x'.repeat(1001) })).rejects.toThrow();
    });
  });

  describe('happy path', () => {
    it('writes a snapshot row and returns the result', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: 'Hello world', title: 'My Doc' }));
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      const result = await runSnapshot({
        doc_id: 'doc-1',
        label: 'pre-refactor',
        reason: 'Backing up before architectural rewrite',
      });

      expect(result).toMatchObject({
        success: true,
        doc_id: 'doc-1',
        doc_title: 'My Doc',
        content_bytes: 11,
        label: 'pre-refactor',
        reason: 'Backing up before architectural rewrite',
        created_at: '2026-01-09T14:17:01.000Z',
      });
      expect(result.snapshot_id).toMatch(/^snap-\d+-[A-Za-z0-9_-]{8}$/);

      // Validate the INSERT call args
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/INSERT INTO doc_snapshots/);
      expect(params[0]).toMatch(/^snap-/); // id
      expect(params[1]).toBe('doc-1'); // doc_id
      expect(params[2]).toBe('Hello world'); // content
      expect(params[3]).toBe(11); // content_bytes
      expect(params[4]).toBe('pre-refactor'); // label
      expect(params[5]).toBe('Backing up before architectural rewrite'); // reason
    });

    it('uses null label/reason when not provided', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      const result = await runSnapshot({ doc_id: 'doc-1' });

      expect(result.label).toBeNull();
      expect(result.reason).toBeNull();
      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params[4]).toBeNull();
      expect(params[5]).toBeNull();
    });

    it('captures created_by from agent context', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      // ToolHandlerContext uses camelCase `agentId`; a snake_case `agent_id`
      // is never read by the handler.
      await runSnapshot({ doc_id: 'doc-1' }, { agentId: 'agent-clio' });

      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params[6]).toBe('agent-clio'); // created_by
    });

    it('defaults created_by to null when no agent context', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      await runSnapshot({ doc_id: 'doc-1' });

      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params[6]).toBeNull();
    });

    it('resolves doc_path via resolveDocByPath', async () => {
      mockResolveDocByPath.mockResolvedValueOnce('doc-from-path');
      mockFindById.mockResolvedValueOnce(makeDoc({ id: 'doc-from-path', content: 'X' }));
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      const result = await runSnapshot({ doc_path: '/projects/foo' });

      expect(mockResolveDocByPath).toHaveBeenCalledWith('/projects/foo');
      expect(mockFindById).toHaveBeenCalledWith('doc-from-path');
      expect(result.doc_id).toBe('doc-from-path');
    });
  });

  describe('content byte sizing', () => {
    it('measures multibyte UTF-8 content in bytes, not characters', async () => {
      // Two emoji each = 4 UTF-8 bytes → 8 bytes total
      mockFindById.mockResolvedValueOnce(makeDoc({ content: '🚀🔥' }));
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      const result = await runSnapshot({ doc_id: 'doc-1' });

      expect(result.content_bytes).toBe(8);
      const params = mockPoolQuery.mock.calls[0]![1] as unknown[];
      expect(params[3]).toBe(8);
    });

    it('handles empty content', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc({ content: '' }));
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      const result = await runSnapshot({ doc_id: 'doc-1' });

      expect(result.content_bytes).toBe(0);
    });
  });

  describe('snapshot_id format', () => {
    it('produces a snap- prefixed id with epoch ms and nanoid suffix', async () => {
      mockFindById.mockResolvedValueOnce(makeDoc());
      mockPoolQuery.mockResolvedValueOnce(pgRows([{ created_at: '2026-01-09T14:17:01.000Z' }]));

      const before = Date.now();
      const result = await runSnapshot({ doc_id: 'doc-1' });
      const after = Date.now();

      const match = result.snapshot_id.match(/^snap-(\d+)-([A-Za-z0-9_-]{8})$/);
      expect(match).not.toBeNull();
      const ts = Number(match![1]);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });
});
