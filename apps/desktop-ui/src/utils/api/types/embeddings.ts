export type EmbeddingMaintenanceOperation = 'backfill';

export type EmbeddingMaintenanceNodeType =
  | 'container'
  | 'doc'
  | 'memory'
  | 'message'
  | 'thread_summary'
  | 'file'
  | 'image'
  | 'table_entry';

interface EmbeddingMaintenanceNodeTypeCoverage {
  nodeType: EmbeddingMaintenanceNodeType;
  fresh: number;
  missing: number;
  stale: number;
}

/**
 * Coverage returned by `GET /embeddings/maintenance/models`: one entry for the
 * built-in local embedding model, or none when its catalog row is missing.
 */
export interface EmbeddingMaintenanceModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  /** Stored vector rows. Chunked content can contribute more than one row. */
  existing: number;
  /** Embeddable source items with no current vector set. */
  missing: number;
  /** Embeddable source items whose content changed after their last embedding. */
  stale: number;
  /** Embeddable source items whose current content has a vector set. */
  fresh: number;
  storageBytes: number;
  estimatedMissingTokens: number;
  estimatedStaleTokens: number;
  /** Optional only for compatibility with servers built before per-kind coverage landed. */
  nodeTypeCoverage?: EmbeddingMaintenanceNodeTypeCoverage[];
}

/** Current singleton maintenance job returned by the status/job endpoints. */
export interface EmbeddingMaintenanceStatus {
  running: boolean;
  jobId: string | null;
  operation: EmbeddingMaintenanceOperation | null;
  modelId: string | null;
  providerId: string | null;
  modelKey: string | null;
  requestedNodeType: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  cancelRequested: boolean;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  deleted: number;
  estimatedTokensTotal: number;
  estimatedTokensProcessed: number;
  currentNodeType: string | null;
  currentNodeId: string | null;
  lastError: string | null;
}
