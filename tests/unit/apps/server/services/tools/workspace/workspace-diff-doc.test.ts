import { beforeEach, describe, expect, it } from '@jest/globals';

const mockDocsFindById = jest.fn();
const mockPoolQuery = jest.fn();
const mockGetPool = jest.fn(() => ({ query: mockPoolQuery }));

jest.mock('@snaglet/db', () => ({
  Docs: { findById: mockDocsFindById },
  getPool: mockGetPool,
  // Tests mock the engine-agnostic getDb() facade.
  getDb: mockGetPool,
}));

import workspaceDiffDoc from '@server/services/ToolService/handlers/docs/diffDoc';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface DiffDocResult {
  success?: boolean;
  identical?: boolean;
  truncated?: boolean;
  from_label?: string;
  to_label?: string;
  from_bytes?: number;
  to_bytes?: number;
  diff?: string;
  summary?: {
    added_lines: number;
    removed_lines: number;
    hunks: number;
  };
}

const asResult = (out: unknown): DiffDocResult => parseToolResult<DiffDocResult>(out);

interface SnapshotRow {
  id: string;
  doc_id: string;
  content: string;
  created_at: string;
  label: string | null;
}

function snapshotRow(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 'snap-1',
    doc_id: 'd1',
    content: '',
    created_at: new Date('2025-01-01').toISOString(),
    label: null,
    ...overrides,
  };
}
function returnSnap(row: SnapshotRow | null) {
  mockPoolQuery.mockResolvedValueOnce({ rows: row ? [row] : [] });
}

describe('workspace_diff_doc tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // validation
  it('throws when neither from_snapshot_id nor from_content provided', async () => {
    await expect(workspaceDiffDoc({ doc_id: 'd1' }, {}, {})).rejects.toThrow(
      /from_snapshot_id.*from_content/
    );
  });

  it('throws when both from_snapshot_id and from_content provided', async () => {
    await expect(
      workspaceDiffDoc({ doc_id: 'd1', from_snapshot_id: 's1', from_content: 'x' }, {}, {})
    ).rejects.toThrow(/both/);
  });

  it('throws when doc_id missing and only one snapshot given', async () => {
    await expect(workspaceDiffDoc({ from_snapshot_id: 's1' }, {}, {})).rejects.toThrow(
      /doc_id.*required/
    );
  });

  // snapshot vs current
  it('diffs current doc content against a snapshot', async () => {
    mockDocsFindById.mockResolvedValueOnce({
      id: 'd1',
      title: 'T',
      content: 'a\nb\nc\nNEW LINE\nd',
    });
    returnSnap(snapshotRow({ id: 's1', doc_id: 'd1', content: 'a\nb\nc\nd' }));

    const out = await workspaceDiffDoc({ doc_id: 'd1', from_snapshot_id: 's1' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.identical).toBe(false);
    expect(result.summary?.added_lines).toBe(1);
    expect(result.summary?.removed_lines).toBe(0);
    expect(result.summary?.hunks).toBe(1);
    expect(result.diff).toContain('+NEW LINE');
    expect(result.diff).toContain('--- snapshot:s1');
    expect(result.diff).toContain('+++ doc:d1@current');
  });

  it('reports identical=true when current content matches the snapshot', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'T', content: 'same' });
    returnSnap(snapshotRow({ content: 'same' }));

    const out = await workspaceDiffDoc({ doc_id: 'd1', from_snapshot_id: 's1' }, {}, {});
    const result = asResult(out);
    expect(result.identical).toBe(true);
    expect(result.diff).toBe('');
    expect(result.summary?.added_lines).toBe(0);
    expect(result.summary?.removed_lines).toBe(0);
  });

  // snapshot vs snapshot
  it('diffs two snapshots of the same doc', async () => {
    returnSnap(snapshotRow({ id: 's1', doc_id: 'd1', content: 'one\ntwo\nthree' }));
    returnSnap(snapshotRow({ id: 's2', doc_id: 'd1', content: 'one\nTWO\nthree' }));

    const out = await workspaceDiffDoc({ from_snapshot_id: 's1', to_snapshot_id: 's2' }, {}, {});
    const result = asResult(out);
    expect(result.identical).toBe(false);
    expect(result.from_label).toBe('snapshot:s1');
    expect(result.to_label).toBe('snapshot:s2');
    expect(result.summary?.added_lines).toBe(1);
    expect(result.summary?.removed_lines).toBe(1);
    expect(result.diff).toContain('-two');
    expect(result.diff).toContain('+TWO');
  });

  it('throws when two snapshots belong to different docs', async () => {
    returnSnap(snapshotRow({ id: 's1', doc_id: 'd1' }));
    returnSnap(snapshotRow({ id: 's2', doc_id: 'd2' }));

    await expect(
      workspaceDiffDoc({ from_snapshot_id: 's1', to_snapshot_id: 's2' }, {}, {})
    ).rejects.toThrow(/different docs/);
  });

  // from_content path
  it('diffs current doc content against provided content', async () => {
    mockDocsFindById.mockResolvedValueOnce({
      id: 'd1',
      title: 'T',
      content: 'final',
    });

    const out = await workspaceDiffDoc({ doc_id: 'd1', from_content: 'initial' }, {}, {});
    const result = asResult(out);
    expect(result.identical).toBe(false);
    expect(result.from_label).toBe('provided');
    expect(result.summary?.added_lines).toBe(1);
    expect(result.summary?.removed_lines).toBe(1);
    expect(result.diff).toContain('-initial');
    expect(result.diff).toContain('+final');
  });

  // defensive checks
  it('throws when snapshot does not belong to the doc', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'T', content: '' });
    returnSnap(snapshotRow({ id: 's1', doc_id: 'd-other' }));
    await expect(
      workspaceDiffDoc({ doc_id: 'd1', from_snapshot_id: 's1' }, {}, {})
    ).rejects.toThrow(/belongs to doc/);
  });

  it('throws when snapshot not found', async () => {
    mockDocsFindById.mockResolvedValueOnce({ id: 'd1', title: 'T', content: '' });
    returnSnap(null);
    await expect(
      workspaceDiffDoc({ doc_id: 'd1', from_snapshot_id: 'ghost' }, {}, {})
    ).rejects.toThrow(/snapshot not found/);
  });

  it('throws when doc not found', async () => {
    mockDocsFindById.mockResolvedValueOnce(null);
    await expect(workspaceDiffDoc({ doc_id: 'ghost', from_content: '' }, {}, {})).rejects.toThrow(
      /doc not found/
    );
  });

  // truncation
  it('truncates and skips diff body when content exceeds max_diff_bytes', async () => {
    mockDocsFindById.mockResolvedValueOnce({
      id: 'd1',
      title: 'T',
      content: 'x'.repeat(1000),
    });

    const out = await workspaceDiffDoc(
      { doc_id: 'd1', from_content: 'short', max_diff_bytes: 100 },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.truncated).toBe(true);
    expect(result.from_bytes).toBe(5);
    expect(result.to_bytes).toBe(1000);
    expect(result.diff).toBeUndefined();
  });

  // context_lines respected
  it('respects context_lines=0 (no surrounding context in hunks)', async () => {
    mockDocsFindById.mockResolvedValueOnce({
      id: 'd1',
      title: 'T',
      content: 'a\nb\nc\nX\ne\nf',
    });
    returnSnap(snapshotRow({ content: 'a\nb\nc\nd\ne\nf' }));

    const out = await workspaceDiffDoc(
      { doc_id: 'd1', from_snapshot_id: 's1', context_lines: 0 },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.diff).not.toContain(' a');
    expect(result.diff).not.toContain(' f');
    expect(result.diff).toContain('-d');
    expect(result.diff).toContain('+X');
  });
});
