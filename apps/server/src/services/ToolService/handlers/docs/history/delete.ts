/**
 * delete_snapshot — permanently remove ONE snapshot from a doc's
 * version history.
 *
 * Safety: the snapshot is addressed by its exact id, and an optional
 * `doc_id` acts as a defensive target check (mismatch → error, nothing
 * deleted). Only the `doc_snapshots` row is removed — the live doc and
 * every other snapshot are untouched. There is no cascade and no
 * side-effect on doc content, so this can never delete the document
 * itself.
 *
 * The deleted snapshot's identity (id, doc, label, created_at) is
 * echoed back so the caller can log exactly which version is gone.
 * A missing snapshot is a hard error, never a silent success.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { getDb } from '@snaglet/db';

interface Input {
  snapshot_id: string;
  doc_id?: string;
}

interface SnapshotRow {
  id: string;
  doc_id: string;
  label: string | null;
  reason: string | null;
  created_at: string | Date;
}

const handler: ToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as unknown as Input;
  const snapshotId = (input.snapshot_id ?? '').trim();
  if (!snapshotId) {
    throw new Error('delete_snapshot: `snapshot_id` is required');
  }

  const pool = getDb();

  // Load the snapshot so the delete can be verified and echoed
  const snapRes = await pool.query<SnapshotRow>(
    `SELECT id, doc_id, label, reason, created_at
       FROM doc_snapshots
      WHERE id = $1
      LIMIT 1`,
    [snapshotId]
  );
  const snap = snapRes.rows[0];
  if (!snap) {
    throw new Error(`delete_snapshot: snapshot not found: ${snapshotId}`);
  }
  if (input.doc_id && input.doc_id !== snap.doc_id) {
    throw new Error(
      `delete_snapshot: doc_id mismatch — snapshot ${snapshotId} belongs to doc ${snap.doc_id}, not ${input.doc_id}`
    );
  }

  // Delete exactly that row
  const delRes = await pool.query<{ id: string }>(
    `DELETE FROM doc_snapshots
      WHERE id = $1 AND doc_id = $2
      RETURNING id`,
    [snap.id, snap.doc_id]
  );
  if (delRes.rows.length === 0) {
    // Raced with another delete between SELECT and DELETE.
    throw new Error(`delete_snapshot: snapshot not found: ${snapshotId}`);
  }

  const result = {
    success: true,
    deleted_snapshot_id: snap.id,
    doc_id: snap.doc_id,
    label: snap.label,
    reason: snap.reason,
    created_at: snap.created_at,
    message: `Deleted snapshot ${snap.id}${snap.label ? ` ("${snap.label}")` : ''} from doc ${snap.doc_id}'s version history. The live doc and its other snapshots are untouched.`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
