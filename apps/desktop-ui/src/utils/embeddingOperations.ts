import type { EmbeddingMaintenanceOperation } from '@desktop/utils/api';

/** Plain name for an embedding maintenance job, e.g. "Backfill missing". */
export function embeddingOperationLabel(operation: EmbeddingMaintenanceOperation | null): string {
  return operation === 'backfill' ? 'Backfill' : 'Indexing';
}
