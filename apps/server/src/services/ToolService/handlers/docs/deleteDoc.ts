import type { ToolHandler } from '@server/services/ToolService/types';
import { getDb } from '@snaglet/db';
import { Docs } from '@snaglet/db/tables/docs';
import { resolveDocIdOrThrow } from '@server/services/WorkspaceService/pathResolver';
import { WorkspaceDeleteDocInput } from './docInputs';
import { emitTreeNodeDeleted } from '@server/realtime/surfaces/tree';
import { getErrorMessage } from '@snaglet/shared/utils';
import { listReferrers, type Referrer } from '@server/services/transclusions/transclusionGraph';

interface DeleteResult {
  success: boolean;
  doc_id: string;
  doc_title: string;
  deleted: boolean;
  dry_run: boolean;
  forced: boolean;
  /** Docs that transclude this one; after a forced delete they show a missing marker. */
  transcluded_in: Referrer[];
  /** Docs that only link to this one; after a forced delete those links break. */
  linked_from: Referrer[];
  snapshots_deleted: number;
  warnings: string[];
}

async function deleteDoc(input: Record<string, unknown>): Promise<DeleteResult> {
  const parsed = WorkspaceDeleteDocInput.parse(input);
  const { doc_id, doc_path, force, dry_run } = parsed;

  const resolvedDocId = await resolveDocIdOrThrow({ doc_id, doc_path });
  const doc = await Docs.findById(resolvedDocId);
  if (!doc) {
    throw new Error(`Document not found: ${doc_path || doc_id}`);
  }
  const docTitle: string = (doc as { title?: string }).title ?? '';

  // Always compute the blast radius first: other docs that transclude it or
  // link to it, archived ones included.
  const pool = getDb();
  const { transcluded_in: transcludedIn, linked_from: linkedFrom } = await listReferrers(
    pool,
    resolvedDocId
  );
  const names = (docs: Referrer[]) =>
    docs.map((d) => `"${d.title}" (${d.id})${d.archived ? ' [archived]' : ''}`).join(', ');
  const blastRadius = [
    transcludedIn.length > 0
      ? `${transcludedIn.length} transclude it (${names(transcludedIn)})`
      : '',
    linkedFrom.length > 0 ? `${linkedFrom.length} only link to it (${names(linkedFrom)})` : '',
  ]
    .filter(Boolean)
    .join(' and ');

  const warnings: string[] = [];
  if (blastRadius && !force) {
    // Refuse: name the docs so the caller can decide what to do.
    throw new Error(
      `Refusing to delete "${docTitle}" (${resolvedDocId}): of the other docs, ${blastRadius}. ` +
        'Pass force:true to delete anyway (a transclusion then shows it as missing and a link breaks), ' +
        'or remove those references first.'
    );
  }

  if (transcludedIn.length > 0 && force) {
    warnings.push(
      `Forced delete: ${names(transcludedIn)} transclude this doc and will show it as missing.`
    );
  }
  if (linkedFrom.length > 0 && force) {
    warnings.push(`Forced delete: ${names(linkedFrom)} link to this doc; those links will break.`);
  }

  // Count snapshots that will cascade (informational only).
  let snapshotsDeleted = 0;
  try {
    const snapCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM doc_snapshots WHERE doc_id = $1`,
      [resolvedDocId]
    );
    snapshotsDeleted = Number(snapCount.rows[0]?.count ?? 0);
  } catch (err) {
    // doc_snapshots table may not exist yet on older DBs — don't fail the delete.
    warnings.push(
      `Could not count snapshots (table may not be provisioned): ${getErrorMessage(err)}`
    );
  }

  if (dry_run) {
    return {
      success: true,
      doc_id: resolvedDocId,
      doc_title: docTitle,
      deleted: false,
      dry_run: true,
      forced: force ?? false,
      transcluded_in: transcludedIn,
      linked_from: linkedFrom,
      snapshots_deleted: snapshotsDeleted,
      warnings,
    };
  }

  // Delete the node row — cascade FKs will remove docs, links, snapshots, etc.
  // (docs.id, links.source_id, links.target_id all reference nodes(id) ON DELETE CASCADE)
  await pool.query(`DELETE FROM nodes WHERE id = $1`, [resolvedDocId]);
  emitTreeNodeDeleted(resolvedDocId, 'doc');

  return {
    success: true,
    doc_id: resolvedDocId,
    doc_title: docTitle,
    deleted: true,
    dry_run: false,
    forced: force ?? false,
    transcluded_in: transcludedIn,
    linked_from: linkedFrom,
    snapshots_deleted: snapshotsDeleted,
    warnings,
  };
}

const handler: ToolHandler = async (input, _settings, _context) => {
  const result = await deleteDoc(input as Record<string, unknown>);
  return {
    output: JSON.stringify(result, null, 2),
    rawContent: result,
  };
};

export default handler;
