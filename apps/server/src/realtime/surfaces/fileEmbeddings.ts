/**
 * Realtime invalidation for project file-search coverage.
 *
 * File embeddings are keyed by content hash and may be shared across projects,
 * so the event intentionally carries no project id. Each open project surface
 * refetches its own owner/prefix-scoped aggregate.
 */
import { emitWorkspaceEvent } from '../emit';
import type { FileIndexingImpact } from '@server/services/fileIndexing/scan';
import type { ProjectIndexingRuntime } from '@snaglet/shared/types';

export function emitFileEmbeddingCoverageChanged(): void {
  emitWorkspaceEvent({ type: 'file.embedding_coverage_changed' });
}

export function emitFileIndexingImpactChanged(projectId: string, impact: FileIndexingImpact): void {
  emitWorkspaceEvent({ type: 'file.indexing_impact_changed', projectId, ...impact });
}

/** A project's indexing runtime changed (scan/backfill/clear lifecycle). */
export function emitProjectIndexingStatusChanged(
  projectId: string,
  runtime: ProjectIndexingRuntime
): void {
  emitWorkspaceEvent({ type: 'file.indexing_status_changed', projectId, runtime });
}
