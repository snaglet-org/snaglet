import { beforeEach, describe, expect, it } from '@jest/globals';

// Mocks (hoisted)
const mockDocsFindById = jest.fn();
const mockDocsUpdate = jest.fn();
const mockPoolQuery = jest.fn();
const mockGetPool = jest.fn(() => ({ query: mockPoolQuery }));

jest.mock('@snaglet/db', () => ({
  Docs: { findById: mockDocsFindById, update: mockDocsUpdate },
  getPool: mockGetPool,
  // Tests mock the engine-agnostic getDb() facade.
  getDb: mockGetPool,
  // The real loop guard: it reads docs only when the snapshot transcludes one.
  assertNoTransclusionLoop: jest.requireActual<
    typeof import('../../../../../../../packages/db/tables/docs/transclusionLoop')
  >('../../../../../../../packages/db/tables/docs/transclusionLoop').assertNoTransclusionLoop,
}));

import workspaceRestoreSnapshot from '@server/services/ToolService/handlers/docs/history/restore';
import { parseToolResult } from '../../../../../../support/toolHarness';

interface RestoreSnapshotResult {
  success?: boolean;
  noop?: boolean;
  validate_only?: boolean;
  doc_id?: string;
  restored_from_snapshot_id?: string;
  safety_snapshot_id?: string;
  safety_skipped_reason?: string;
  bytes_before?: number;
  bytes_after?: number;
  snapshot?: { id: string };
}

const asResult = (out: unknown): RestoreSnapshotResult =>
  parseToolResult<RestoreSnapshotResult>(out);

interface SnapshotRow {
  id: string;
  doc_id: string;
  content: string;
  content_bytes: number;
  label: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

interface DocRow {
  id: string;
  title: string;
  content: string;
  containerId: string | null;
  sortOrder: number;
}

const snapshotRow = (overrides: Partial<SnapshotRow> = {}): SnapshotRow => ({
  id: 'snap-1',
  doc_id: 'd1',
  content: 'snapshot content',
  content_bytes: 16,
  label: 'before edit',
  reason: null,
  created_by: null,
  created_at: new Date('2025-01-01T00:00:00Z').toISOString(),
  ...overrides,
});

const docRow = (overrides: Partial<DocRow> = {}): DocRow => ({
  id: 'd1',
  title: 'Plan',
  content: 'current content',
  containerId: null,
  sortOrder: 0,
  ...overrides,
});

function selectSnapshot(row: SnapshotRow | null) {
  mockPoolQuery.mockResolvedValueOnce({ rows: row ? [row] : [] });
}
function insertOk() {
  mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
}

describe('workspace_restore_snapshot tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('restores a doc and creates a safety snapshot by default', async () => {
    selectSnapshot(snapshotRow());
    mockDocsFindById.mockResolvedValueOnce(docRow());
    insertOk();
    mockDocsUpdate.mockResolvedValueOnce(docRow({ content: 'snapshot content' }));

    // ToolHandlerContext uses camelCase `agentId` (not `agent_id`), the field
    // docs/restore-snapshot/tool.ts reads.
    const out = await workspaceRestoreSnapshot(
      { snapshot_id: 'snap-1' },
      {},
      { agentId: 'agent-x' }
    );
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.doc_id).toBe('d1');
    expect(result.restored_from_snapshot_id).toBe('snap-1');
    expect(result.safety_snapshot_id).toMatch(/^snap-\d+-[a-z0-9]{8}$/);
    expect(result.safety_skipped_reason).toBeUndefined();
    expect(result.bytes_before).toBe('current content'.length);
    expect(result.bytes_after).toBe('snapshot content'.length);

    // verify INSERT was called for safety snapshot
    const insertCall = mockPoolQuery.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO doc_snapshots')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining(['d1', 'current content', 'pre-restore', 'agent-x'])
    );
    // verify the restore update
    expect(mockDocsUpdate).toHaveBeenCalledWith('d1', { content: 'snapshot content' });
  });

  it('skips safety snapshot when create_safety_snapshot=false', async () => {
    selectSnapshot(snapshotRow());
    mockDocsFindById.mockResolvedValueOnce(docRow());
    mockDocsUpdate.mockResolvedValueOnce(docRow({ content: 'snapshot content' }));

    const out = await workspaceRestoreSnapshot(
      { snapshot_id: 'snap-1', create_safety_snapshot: false },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.safety_snapshot_id).toBeUndefined();
    expect(result.safety_skipped_reason).toBe('create_safety_snapshot=false');
    const inserts = mockPoolQuery.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO doc_snapshots')
    );
    expect(inserts).toHaveLength(0);
  });

  it('uses provided label for safety snapshot', async () => {
    selectSnapshot(snapshotRow());
    mockDocsFindById.mockResolvedValueOnce(docRow());
    insertOk();
    mockDocsUpdate.mockResolvedValueOnce(docRow({ content: 'snapshot content' }));

    await workspaceRestoreSnapshot({ snapshot_id: 'snap-1', label: 'my-label' }, {}, {});
    const insertCall = mockPoolQuery.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO doc_snapshots')
    );
    expect(insertCall?.[1]).toEqual(expect.arrayContaining(['my-label']));
  });

  it('returns noop when current content already matches snapshot', async () => {
    selectSnapshot(snapshotRow({ content: 'identical' }));
    mockDocsFindById.mockResolvedValueOnce(docRow({ content: 'identical' }));

    const out = await workspaceRestoreSnapshot({ snapshot_id: 'snap-1' }, {}, {});
    const result = asResult(out);
    expect(result.noop).toBe(true);
    expect(mockDocsUpdate).not.toHaveBeenCalled();
    // no INSERT should fire either
    const inserts = mockPoolQuery.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO doc_snapshots')
    );
    expect(inserts).toHaveLength(0);
  });

  it('continues with restore when safety-snapshot insert fails', async () => {
    selectSnapshot(snapshotRow());
    mockDocsFindById.mockResolvedValueOnce(docRow());
    mockPoolQuery.mockRejectedValueOnce(new Error('disk full'));
    mockDocsUpdate.mockResolvedValueOnce(docRow({ content: 'snapshot content' }));

    const out = await workspaceRestoreSnapshot({ snapshot_id: 'snap-1' }, {}, {});
    const result = asResult(out);
    expect(result.success).toBe(true);
    expect(result.safety_snapshot_id).toBeUndefined();
    expect(result.safety_skipped_reason).toMatch(/disk full/);
    expect(mockDocsUpdate).toHaveBeenCalled();
  });

  it('validate_only reports plan without writing', async () => {
    selectSnapshot(snapshotRow());
    mockDocsFindById.mockResolvedValueOnce(docRow());

    const out = await workspaceRestoreSnapshot(
      { snapshot_id: 'snap-1', validate_only: true },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.validate_only).toBe(true);
    expect(result.noop).toBe(false);
    expect(result.snapshot?.id).toBe('snap-1');
    expect(mockDocsUpdate).not.toHaveBeenCalled();
    const inserts = mockPoolQuery.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO doc_snapshots')
    );
    expect(inserts).toHaveLength(0);
  });

  it('validate_only flags noop when content already matches', async () => {
    selectSnapshot(snapshotRow({ content: 'same' }));
    mockDocsFindById.mockResolvedValueOnce(docRow({ content: 'same' }));

    const out = await workspaceRestoreSnapshot(
      { snapshot_id: 'snap-1', validate_only: true },
      {},
      {}
    );
    const result = asResult(out);
    expect(result.validate_only).toBe(true);
    expect(result.noop).toBe(true);
  });

  it('throws when snapshot_id is missing or blank', async () => {
    await expect(workspaceRestoreSnapshot({}, {}, {})).rejects.toThrow(/snapshot_id/);
    await expect(workspaceRestoreSnapshot({ snapshot_id: '   ' }, {}, {})).rejects.toThrow(
      /snapshot_id/
    );
  });

  it('throws when snapshot does not exist', async () => {
    selectSnapshot(null);
    await expect(workspaceRestoreSnapshot({ snapshot_id: 'ghost' }, {}, {})).rejects.toThrow(
      /snapshot not found/
    );
  });

  it('throws when provided doc_id does not match the snapshot', async () => {
    selectSnapshot(snapshotRow());
    await expect(
      workspaceRestoreSnapshot({ snapshot_id: 'snap-1', doc_id: 'wrong-doc' }, {}, {})
    ).rejects.toThrow(/doc_id mismatch/);
  });

  it('throws when target doc not found', async () => {
    selectSnapshot(snapshotRow());
    mockDocsFindById.mockResolvedValueOnce(null);
    await expect(workspaceRestoreSnapshot({ snapshot_id: 'snap-1' }, {}, {})).rejects.toThrow(
      /target doc not found/
    );
  });
});
