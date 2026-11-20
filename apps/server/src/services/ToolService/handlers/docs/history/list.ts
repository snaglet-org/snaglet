import type { ToolHandler } from '@server/services/ToolService/types';
import { getDb } from '@snaglet/db';
import { resolveDocIdOrThrow } from '@server/services/WorkspaceService/pathResolver';
import { WorkspaceListSnapshotsInput } from './schemas';
import { isoStamp } from '@snaglet/shared/utils';

interface SnapshotMeta {
  snapshot_id: string;
  doc_id: string;
  content_bytes: number;
  label: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

interface SnapshotFull extends SnapshotMeta {
  content: string;
}

interface ListResult {
  success: true;
  doc_id: string;
  count: number;
  snapshots: Array<SnapshotMeta | SnapshotFull>;
  truncated: boolean;
}

async function listSnapshots(input: Record<string, unknown>): Promise<ListResult> {
  const parsed = WorkspaceListSnapshotsInput.parse(input);
  const { doc_id, doc_path, label, limit, include_content } = parsed;

  const resolvedDocId = await resolveDocIdOrThrow({ doc_id, doc_path });

  const contentCol = include_content ? ', content' : '';
  const params: unknown[] = [resolvedDocId];
  let sql = `SELECT id, doc_id, content_bytes, label, reason, created_by, created_at${contentCol}
       FROM doc_snapshots
      WHERE doc_id = $1`;

  if (label) {
    params.push(label);
    sql += ` AND label = $${params.length}`;
  }

  // Fetch limit + 1 so we can detect truncation.
  params.push(limit + 1);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const pool = getDb();
  const res = await pool.query<{
    id: string;
    doc_id: string;
    content_bytes: number;
    label: string | null;
    reason: string | null;
    created_by: string | null;
    created_at: string | Date;
    content?: string;
  }>(sql, params);

  const truncated = res.rows.length > limit;
  const trimmed = truncated ? res.rows.slice(0, limit) : res.rows;

  const snapshots = trimmed.map((r) => {
    const meta: SnapshotMeta = {
      snapshot_id: r.id,
      doc_id: r.doc_id,
      content_bytes: r.content_bytes,
      label: r.label,
      reason: r.reason,
      created_by: r.created_by,
      created_at: typeof r.created_at === 'string' ? r.created_at : isoStamp(r.created_at),
    };
    if (include_content) {
      return { ...meta, content: r.content ?? '' } satisfies SnapshotFull;
    }
    return meta;
  });

  return {
    success: true,
    doc_id: resolvedDocId,
    count: snapshots.length,
    snapshots,
    truncated,
  };
}

const handler: ToolHandler = async (input, _settings, _context) => {
  const result = await listSnapshots(input as Record<string, unknown>);
  return {
    output: JSON.stringify(result, null, 2),
    rawContent: result,
  };
};

export default handler;
