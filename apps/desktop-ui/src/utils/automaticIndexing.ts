import type { WorkerStatusResponse } from '@snaglet/shared/types';

/** Keep environment gating distinct from the user's worker switches and manual jobs. */
export function automaticIndexingMessage(status: WorkerStatusResponse | null): string {
  if (status?.automaticLocalIntelligenceEnabled === false)
    return 'Automatic indexing is off in this environment. Backfill runs on demand.';
  if (status?.automaticLocalIntelligenceEnabled !== true)
    return 'Automatic indexing status is unavailable. Backfill runs on demand.';
  if (!status.policy.envEnabled)
    return 'Background workers are off in this environment. Backfill runs on demand.';
  if (!status.policy.embeddingsEnabled)
    return 'Background embeddings workers are disabled. Backfill runs on demand.';
  if (!status.policy.active)
    return 'Background indexing is paused or stopped. Backfill runs on demand.';
  return 'Background indexing continues automatically. Backfill can also run on demand.';
}
