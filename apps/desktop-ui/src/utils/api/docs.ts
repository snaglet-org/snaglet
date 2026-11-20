import { fetchData, getApiUrl } from './core';
import type { DocPriority } from '@snaglet/shared';

export interface DocRecord {
  id: string;
  containerId: string | null;
  title: string;
  content: string;
  /** Optional work-item fields — nullable, meaningful on any doc. */
  dueAt: string | null;
  assignedTo: string | null;
  priority: DocPriority | null;
  /** Read-only — members.id of the actor who created the doc (creation stamp). */
  createdBy: string | null;
  /** Read-only — members.id of the actor who last edited title/content. */
  lastEditedBy: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransclusionLoopStep {
  id: string;
  title: string;
}

interface DocInput {
  title: string;
  containerId?: string | null;
  content?: string;
}

export interface DocUpdate {
  title?: string;
  content?: string;
  containerId?: string | null;
  /**
   * Work-item fields. Editing these is a deliberate act, never triggered by
   * a move. `null` clears; omit to leave unchanged.
   */
  dueAt?: string | null;
  assignedTo?: string | null;
  priority?: DocPriority | null;
  /**
   * Positional move within the target container. When set, the server
   * atomically bumps any sibling already at this slot (or beyond) by +1
   * so the drop has room — see DocModel.moveTo.
   */
  sortOrder?: number;
}

export const docsApi = {
  get: (id: string) => fetchData<DocRecord>(getApiUrl(`/docs/${id}`)),
  create: (data: DocInput) =>
    fetchData<DocRecord>(getApiUrl('/docs'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /**
   * Convert an uploaded file (md/txt/json/csv/yaml/pdf/…) into a doc.
   * The server derives the title from the filename and the content from
   * the file type (PDF text extraction, fenced blocks for data formats).
   * `sortOrder` slots the doc among its siblings (drop-between-rows).
   */
  importFile: (data: {
    name: string;
    dataUrl: string;
    containerId?: string | null;
    sortOrder?: number;
  }) =>
    fetchData<DocRecord>(getApiUrl('/docs/import'), {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: DocUpdate) =>
    fetchData<DocRecord>(getApiUrl(`/docs/${id}`), {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  /**
   * The loop transcluding `target` into doc `id` would close (`[A, B, A]`,
   * first and last the same doc), or null when it is safe. Saves are refused
   * by the same server check either way.
   */
  transclusionLoop: (id: string, target: string) =>
    fetchData<{ loop: TransclusionLoopStep[] | null }>(
      getApiUrl(`/docs/${id}/transclusion-loop?target=${encodeURIComponent(target)}`)
    ),
  delete: (id: string) => fetchData<null>(getApiUrl(`/docs/${id}`), { method: 'DELETE' }),
  listSnapshots: (id: string) =>
    fetchData<DocSnapshotListResult>(getApiUrl(`/docs/${id}/snapshots`)),
  /**
   * Take a manual snapshot of the doc's current content. Server stores
   * it in `doc_snapshots` with `reason='manual'` so the Versions
   * dropdown can distinguish user-initiated snapshots from auto ones.
   * Optional `label` is surfaced inline with the row in the dropdown.
   */
  createSnapshot: (id: string, opts?: { label?: string }) =>
    fetchData<{ snapshot: DocSnapshotMeta }>(getApiUrl(`/docs/${id}/snapshots`), {
      method: 'POST',
      body: JSON.stringify(opts?.label ? { label: opts.label } : {}),
    }).then((data) => data.snapshot),
  /**
   * Fetch a single snapshot's full content for preview-in-editor mode.
   * Server returns the snapshot with `content` populated.
   */
  getSnapshot: (id: string, snapshotId: string) =>
    fetchData<{ snapshot: DocSnapshotRecord }>(
      getApiUrl(`/docs/${id}/snapshots/${snapshotId}`)
    ).then((data) => data.snapshot),
  /**
   * Restore the doc to a prior snapshot's content. The server takes a
   * safety "pre-restore" snapshot of the current body first, then writes
   * the snapshot content back via the normal update path. Returns the
   * updated doc so the client can re-render in live mode immediately.
   */
  restoreSnapshot: (id: string, snapshotId: string) =>
    fetchData<{ doc: DocRecord }>(getApiUrl(`/docs/${id}/snapshots/${snapshotId}/restore`), {
      method: 'POST',
    }).then((data) => data.doc),
  /**
   * Permanently delete one snapshot from the doc's version history.
   * Scoped server-side to the doc, so a stale snapshotId can never
   * remove another doc's version. The live doc body and every other
   * snapshot are untouched. 404s (throws) when the snapshot is already
   * gone — a delete that removed nothing is never reported as success.
   */
  deleteSnapshot: (id: string, snapshotId: string) =>
    fetchData<{ deleted: boolean; id: string; doc_id: string }>(
      getApiUrl(`/docs/${id}/snapshots/${snapshotId}`),
      { method: 'DELETE' }
    ),
  /**
   * Permanently delete every snapshot in the doc's version history
   * ("Clear all versions"). One scoped server-side statement, so other
   * docs' histories and the live doc body are untouched. An already-empty
   * history resolves with `deleted_count: 0` rather than throwing; only
   * a missing doc 404s.
   */
  clearSnapshots: (id: string) =>
    fetchData<{ deleted: boolean; doc_id: string; deleted_count: number }>(
      getApiUrl(`/docs/${id}/snapshots`),
      { method: 'DELETE' }
    ),
};

export interface DocSnapshotMeta {
  id: string;
  label: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  content_bytes: number;
}

export interface DocSnapshotListResult {
  doc_id: string;
  /** True total for the doc — may exceed `snapshots.length` (list is capped at 200). */
  count: number;
  snapshots: DocSnapshotMeta[];
}

/**
 * A snapshot with its full content payload — returned by the
 * single-snapshot GET endpoint that powers preview-in-editor mode.
 */
export interface DocSnapshotRecord extends DocSnapshotMeta {
  doc_id: string;
  content: string;
}
