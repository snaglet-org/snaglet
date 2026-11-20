import type { ToolHandler } from '@server/services/ToolService/types';
import { assertNotArchived } from '@server/services/ToolService/tools/_shared/archiveGuard';
import { getDb } from '@snaglet/db';
import { Docs } from '@snaglet/db/tables/docs';
import { resolveDocIdOrThrow } from '@server/services/WorkspaceService/pathResolver';
import { WorkspaceSnapshotDocInput } from './schemas';
import { randomUUID } from 'node:crypto';
import { isoStamp } from '@snaglet/shared/utils';
import { getCurrentActor } from '@server/realtime/actorContext';
const shortId = (len = 8) => randomUUID().replace(/-/g, '').slice(0, len);

interface SnapshotResult {
  success: true;
  snapshot_id: string;
  doc_id: string;
  doc_title: string;
  content_bytes: number;
  label: string | null;
  reason: string | null;
  created_at: string;
}

async function snapshotDoc(
  input: Record<string, unknown>,
  context?: { agentId?: string }
): Promise<SnapshotResult> {
  const parsed = WorkspaceSnapshotDocInput.parse(input);
  const { doc_id, doc_path, label, reason } = parsed;

  const resolvedDocId = await resolveDocIdOrThrow({ doc_id, doc_path });
  const doc = await Docs.findById(resolvedDocId);
  if (!doc) {
    throw new Error(`Document not found: ${doc_path || doc_id}`);
  }
  assertNotArchived(doc, { allow_archived: parsed.allow_archived });

  const content: string = (doc as { content?: string }).content ?? '';
  const title: string = (doc as { title?: string }).title ?? '';
  const contentBytes = Buffer.byteLength(content, 'utf8');
  const snapshotId = `snap-${Date.now()}-${shortId(8)}`;
  // `context.agentId` is camelCase (ToolHandlerContext) — was misread as the
  // snake_case `agent_id`, which is never set, so created_by was always null.
  // Fall back to the ambient actor (e.g. a user-triggered call with no agent
  // in context) — `doc_snapshots.created_by` is a plain non-FK TEXT column,
  // so it trivially accepts either id shape. Note: other created_by-style
  // columns (docs, containers) store a resolved `members.id` via
  // resolveActorMemberId(); no existing writer to *this* column has ever set
  // a non-null value (docs.routes.ts passes null, edit-doc/tool.ts omits the
  // column), so there's no established convention here to match — storing
  // the raw agent/actor id is the simplest fix. If member-id attribution is
  // wanted later, route through resolveCurrentActorMemberId() instead.
  const createdBy = context?.agentId ?? getCurrentActor()?.actorId ?? null;

  const pool = getDb();
  const inserted = await pool.query<{ created_at: string | Date }>(
    `INSERT INTO doc_snapshots
        (id, doc_id, content, content_bytes, label, reason, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING created_at`,
    [snapshotId, resolvedDocId, content, contentBytes, label ?? null, reason ?? null, createdBy]
  );

  const createdAtRaw = inserted.rows[0]?.created_at ?? new Date();
  const createdAt = typeof createdAtRaw === 'string' ? createdAtRaw : isoStamp(createdAtRaw);

  return {
    success: true,
    snapshot_id: snapshotId,
    doc_id: resolvedDocId,
    doc_title: title,
    content_bytes: contentBytes,
    label: label ?? null,
    reason: reason ?? null,
    created_at: createdAt,
  };
}

const handler: ToolHandler = async (input, _settings, context) => {
  const result = await snapshotDoc(input as Record<string, unknown>, context);
  return {
    output: JSON.stringify(result, null, 2),
    rawContent: result,
  };
};

export default handler;
