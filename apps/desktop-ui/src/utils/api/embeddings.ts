import { fetchData, getApiUrl } from './core';
import type {
  EmbeddingMaintenanceModel,
  EmbeddingMaintenanceOperation,
  EmbeddingMaintenanceStatus,
} from './types';

export const embeddingsApi = {
  listMaintenanceModels: () =>
    fetchData<EmbeddingMaintenanceModel[]>(getApiUrl('/embeddings/maintenance/models')),

  /** Current singleton maintenance job; cheap enough to poll while running. */
  getMaintenanceStatus: () =>
    fetchData<EmbeddingMaintenanceStatus>(getApiUrl('/embeddings/maintenance/status')),

  /** Backfill missing and stale content in one job, optionally scoped to a kind. */
  startMaintenanceJob: (input: {
    operation: EmbeddingMaintenanceOperation;
    modelId?: string | null;
    nodeType?: string | null;
    confirmation?: string;
  }) =>
    fetchData<EmbeddingMaintenanceStatus>(getApiUrl('/embeddings/maintenance/jobs'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Request cancellation; the active item finishes before the job stops. */
  cancelMaintenanceJob: () =>
    fetchData<EmbeddingMaintenanceStatus>(getApiUrl('/embeddings/maintenance/cancel'), {
      method: 'POST',
    }),
};
