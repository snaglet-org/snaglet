/**
 * restore_snapshot — revert a doc's content to a prior snapshot.
 *
 * Safety: by default we first snapshot the *current* content (with label
 * "pre-restore") so the restore is itself reversible. Disable via
 * `create_safety_snapshot: false`.
 *
 * Idempotency: when the target's current content already equals the
 * snapshot's content, we report `noop: true` and skip both the safety
 * snapshot and the update.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { assertNoTransclusionLoop, Docs, getDb } from '@snaglet/db';
import { randomUUID } from 'node:crypto';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { emitDocBodySaved } from '@server/realtime/surfaces/tree';
import { embedDocNow } from '@server/services/embedding/embedDoc';
import { getErrorMessage } from '@snaglet/shared/utils';
import { getCurrentActor } from '@server/realtime/actorContext';

const shortId = (len = 8) => randomUUID().replace(/-/g, '').slice(0, len);

interface Input {
  snapshot_id: string;
  doc_id?: string;
  create_safety_snapshot?: boolean;
  label?: string;
  validate_only?: boolean;
}

interface SnapshotRow {
  id: string;
  doc_id: string;
  content: string;
  content_bytes: number | null;
  label: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string | Date;
}

const handler: ToolHandler = async (rawInput, _settings, context) => {
  const input = (rawInput ?? {}) as unknown as Input;
  const snapshotId = (input.snapshot_id ?? '').trim();
  if (!snapshotId) {
    throw new Error('restore_snapshot: `snapshot_id` is required');
  }
  const createSafety = input.create_safety_snapshot ?? true;
  const validateOnly = input.validate_only ?? false;

  const pool = getDb();

  // Load the snapshot
  const snapRes = await pool.query<SnapshotRow>(
    `SELECT id, doc_id, content, content_bytes, label, reason, created_by, created_at
       FROM doc_snapshots
      WHERE id = $1
      LIMIT 1`,
    [snapshotId]
  );
  const snap = snapRes.rows[0];
  if (!snap) {
    throw new Error(`restore_snapshot: snapshot not found: ${snapshotId}`);
  }

  // Load the doc
  const targetDocId = input.doc_id ?? snap.doc_id;
  if (input.doc_id && input.doc_id !== snap.doc_id) {
    throw new Error(
      `restore_snapshot: doc_id mismatch — snapshot ${snapshotId} belongs to doc ${snap.doc_id}, not ${input.doc_id}`
    );
  }
  const doc = await Docs.findById(targetDocId);
  if (!doc) {
    throw new Error(`restore_snapshot: target doc not found: ${targetDocId}`);
  }

  const currentContent = doc.content ?? '';
  const snapshotContent = snap.content ?? '';
  const isNoop = currentContent === snapshotContent;
  // Checked before validate_only returns and before the safety snapshot, so a
  // restore that would bring back a transclusion loop writes nothing.
  if (!isNoop) {
    await assertNoTransclusionLoop(pool, {
      id: targetDocId,
      title: doc.title,
      content: snapshotContent,
      previous: currentContent,
    });
  }

  if (validateOnly) {
    const result = {
      success: true,
      validate_only: true,
      noop: isNoop,
      snapshot: {
        id: snap.id,
        doc_id: snap.doc_id,
        created_at: snap.created_at,
        label: snap.label,
        bytes: snap.content_bytes,
      },
      current_bytes: currentContent.length,
      message: isNoop
        ? `restore_snapshot: validate_only — current content already matches snapshot ${snapshotId}; restore would be a noop`
        : `restore_snapshot: validate_only — would overwrite doc ${targetDocId} (${currentContent.length}B) with snapshot ${snapshotId} (${snapshotContent.length}B)`,
    };
    return { output: JSON.stringify(result, null, 2), rawContent: result };
  }

  if (isNoop) {
    const result = {
      success: true,
      noop: true,
      doc_id: targetDocId,
      snapshot_id: snap.id,
      message: `restore_snapshot: doc ${targetDocId} already matches snapshot ${snap.id}; no action taken`,
    };
    return { output: JSON.stringify(result, null, 2), rawContent: result };
  }

  // Safety snapshot of current state
  let safetySnapshotId: string | undefined;
  let safetySkippedReason: string | undefined;
  if (createSafety) {
    const safetyId = `snap-${Date.now()}-${shortId(8)}`;
    const safetyLabel = input.label ?? 'pre-restore';
    // `context.agentId` is camelCase (ToolHandlerContext) — was misread as the
    // snake_case `agent_id`, which is never set, so created_by was always
    // null. Fall back to the ambient actor for user-triggered calls; see the
    // longer note in history/snapshot.ts on the created_by id shape.
    const createdBy = context?.agentId ?? getCurrentActor()?.actorId ?? null;
    try {
      await pool.query(
        `INSERT INTO doc_snapshots (id, doc_id, content, content_bytes, label, reason, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          safetyId,
          targetDocId,
          currentContent,
          currentContent.length,
          safetyLabel,
          `auto: pre-restore of snapshot ${snap.id}`,
          createdBy,
        ]
      );
      safetySnapshotId = safetyId;
    } catch (err) {
      // Don't block the restore on snapshot failure — record and continue.
      safetySkippedReason = getErrorMessage(err);
    }
  } else {
    safetySkippedReason = 'create_safety_snapshot=false';
  }

  // Restore the doc
  const updated = await Docs.update(targetDocId, { content: snapshotContent });
  if (!updated) {
    throw new Error(`restore_snapshot: failed to update doc ${targetDocId}`);
  }
  emitDocBodySaved(targetDocId, snapshotContent, updated.updatedAt, updated.lastEditedBy);
  embedDocNow(updated.id, updated.title, updated.content);

  const result = {
    success: true,
    doc_id: targetDocId,
    restored_from_snapshot_id: snap.id,
    safety_snapshot_id: safetySnapshotId,
    safety_skipped_reason: safetySkippedReason,
    bytes_before: currentContent.length,
    bytes_after: snapshotContent.length,
    link: linkForm('doc', targetDocId, updated.title),
    message: `Restored doc ${targetDocId} from snapshot ${snap.id} (${currentContent.length}B → ${snapshotContent.length}B)${safetySnapshotId ? `, safety snapshot ${safetySnapshotId}` : ''}`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
