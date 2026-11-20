import type { WorkspaceGetDocInput } from './docInputs';
import { getDb } from '@snaglet/db';
import { resolveDocByPath } from '@server/services/WorkspaceService/pathResolver';
import { isArchived } from '@server/services/ToolService/tools/_shared/archiveGuard';
import { expandTransclusions } from '@server/services/transclusions/expandTransclusions';
import {
  cachedDocLoader,
  listTranscludedIn,
  listTransclusions,
  type DocSummary,
  type TransclusionSummary,
} from '@server/services/transclusions/transclusionGraph';

interface DocResult {
  id: string;
  title: string;
  content: string;
  container_id: string | null;
  sort_order: number;
  // Attribution — both are members.id (agent or user) or null.
  created_by: string | null;
  last_edited_by: string | null;
}

interface DocRow extends DocResult {
  archived: boolean | null;
}

export interface WorkspaceGetDocResult extends DocResult {
  /** Docs this doc transcludes directly; omitted when none. */
  transclusions?: TransclusionSummary[];
  /** Docs that transclude this one, the first 20 by title; omitted when none. */
  transcluded_in?: DocSummary[];
  /** How many docs transclude this one, when more than are listed. */
  transcluded_in_total?: number;
  /** Things worth knowing about the content as shown. */
  warnings?: string[];
}

/**
 * Load a doc to read by id or path, with the read rules every read op shares:
 * exactly one of the two, and an archived doc only with `include_archived`.
 */
export async function loadDocForRead(params: {
  doc_id?: string;
  doc_path?: string;
  include_archived?: boolean;
}): Promise<DocResult> {
  const { doc_id, doc_path, include_archived = false } = params;

  if (!doc_id && !doc_path) {
    throw new Error('Must specify either doc_id or doc_path');
  }
  if (doc_id && doc_path) {
    throw new Error('Cannot specify both doc_id and doc_path');
  }

  const resolvedDocId = doc_path ? await resolveDocByPath(doc_path) : doc_id!;

  // Placement (container_id, sort_order) sourced from nodes (SSoT),
  // aliased so DocResult shape is unchanged.
  const docResult = await getDb().query<DocRow>(
    `SELECT d.id, d.title, d.content,
            d.created_by, d.last_edited_by,
            n.container_id AS container_id,
            n.sort_order   AS sort_order,
            n.archived     AS archived
       FROM docs d
       JOIN nodes n ON n.id = d.id
      WHERE d.id = $1`,
    [resolvedDocId]
  );
  const docRow = docResult.rows[0];

  if (!docRow) {
    throw new Error(`Document not found: ${doc_path || doc_id}`);
  }

  // Archived docs are invisible to default reads; surface as not-found unless
  // the caller opts in with include_archived.
  if (!include_archived && isArchived(docRow)) {
    throw new Error(
      `Document not found: ${doc_path || doc_id} (doc is archived; pass include_archived: true to retrieve it)`
    );
  }

  // Strip the archived flag so it never leaks into the tool's result shape.
  const { archived: _archived, ...doc } = docRow;
  return doc;
}

/**
 * Read a doc. By default each transclusion is replaced in place by the
 * transcluded doc's content (see expandTransclusions); `raw` returns the
 * stored source with the `![label](doc-…)` lines intact.
 */
export default async function execute(
  params: WorkspaceGetDocInput,
  opts: { transcludedIn?: boolean } = {}
): Promise<WorkspaceGetDocResult> {
  const doc = await loadDocForRead(params);
  const pool = getDb();
  const stored = doc.content ?? '';
  const load = cachedDocLoader(pool);
  const [transclusions, transcludedIn] = await Promise.all([
    listTransclusions(stored, load),
    opts.transcludedIn === false ? { docs: [], total: 0 } : listTranscludedIn(pool, doc.id),
  ]);
  const expansion = params.raw
    ? null
    : await expandTransclusions({ id: doc.id, content: stored }, load);
  const warnings = (expansion?.tagLike ?? []).map(
    (d) =>
      `"${d.title}" (${d.id}) contains text that looks like a <transcluded-doc> tag; it is that ` +
      "doc's own text, not a transclusion."
  );

  return {
    ...doc,
    content: expansion?.text ?? stored,
    ...(transclusions.length > 0 ? { transclusions } : {}),
    ...(transcludedIn.total > 0 ? { transcluded_in: transcludedIn.docs } : {}),
    ...(transcludedIn.total > transcludedIn.docs.length
      ? { transcluded_in_total: transcludedIn.total }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
