import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted)
const mockPoolQuery = jest.fn();
const mockGetPool = jest.fn(() => ({ query: mockPoolQuery }));

jest.mock('@snaglet/db', () => ({
  getPool: mockGetPool,
  // Tests mock the engine-agnostic getDb() facade.
  getDb: mockGetPool,
}));

import deleteSnapshot from '@server/services/ToolService/handlers/docs/history/delete';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface DeleteSnapshotResult {
  success: boolean;
  deleted_snapshot_id: string;
  doc_id: string;
  label: string | null;
}

const asResult = (out: unknown): DeleteSnapshotResult => parseToolResult<DeleteSnapshotResult>(out);

interface SnapshotRow {
  id: string;
  doc_id: string;
  label: string | null;
  reason: string | null;
  created_at: string;
}

const snapshotRow = (overrides: Partial<SnapshotRow> = {}): SnapshotRow => ({
  id: 'snap-1',
  doc_id: 'd1',
  label: 'before edit',
  reason: 'manual',
  created_at: new Date('2025-01-01T00:00:00Z').toISOString(),
  ...overrides,
});

function selectSnapshot(row: SnapshotRow | null) {
  mockPoolQuery.mockResolvedValueOnce({ rows: row ? [row] : [] });
}
function deleteOk(id = 'snap-1') {
  mockPoolQuery.mockResolvedValueOnce({ rows: [{ id }], rowCount: 1 });
}

describe('delete_snapshot tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes the snapshot and echoes its identity', async () => {
    selectSnapshot(snapshotRow());
    deleteOk();

    const out = await deleteSnapshot({ snapshot_id: 'snap-1' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.deleted_snapshot_id).toBe('snap-1');
    expect(result.doc_id).toBe('d1');
    expect(result.label).toBe('before edit');

    // The DELETE is scoped to id + doc_id — never a bare id.
    const deleteCall = mockPoolQuery.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('DELETE FROM doc_snapshots')
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.[1]).toEqual(['snap-1', 'd1']);
  });

  it('accepts a matching defensive doc_id', async () => {
    selectSnapshot(snapshotRow());
    deleteOk();

    const out = await deleteSnapshot({ snapshot_id: 'snap-1', doc_id: 'd1' }, {}, {});
    expect(asResult(out).success).toBe(true);
  });

  it('rejects a mismatched doc_id without deleting anything', async () => {
    selectSnapshot(snapshotRow());

    await expect(
      deleteSnapshot({ snapshot_id: 'snap-1', doc_id: 'd-other' }, {}, {})
    ).rejects.toThrow(/doc_id mismatch/);
    const deletes = mockPoolQuery.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('DELETE FROM doc_snapshots')
    );
    expect(deletes).toHaveLength(0);
  });

  it('throws a clear not-found error for an unknown snapshot', async () => {
    selectSnapshot(null);

    await expect(deleteSnapshot({ snapshot_id: 'snap-gone' }, {}, {})).rejects.toThrow(
      /snapshot not found: snap-gone/
    );
  });

  it('requires snapshot_id', async () => {
    await expect(deleteSnapshot({}, {}, {})).rejects.toThrow(/`snapshot_id` is required/);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('surfaces a delete race (row vanished between SELECT and DELETE) as not-found', async () => {
    selectSnapshot(snapshotRow());
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(deleteSnapshot({ snapshot_id: 'snap-1' }, {}, {})).rejects.toThrow(
      /snapshot not found: snap-1/
    );
  });
});
