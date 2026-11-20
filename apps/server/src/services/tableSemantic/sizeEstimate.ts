import type { SemanticSizeEstimate } from '@snaglet/shared/types';

/** Most rows a table may index without a person confirming the larger size. */
export const SEMANTIC_ROW_CAP = 10_000;

/**
 * Bytes one indexed row takes on disk. A 768-dimension float4 vector is 3,072
 * bytes, but a ~3.2 KB tuple packs only two to an 8 KB page, and the card hash
 * and primary key entry come on top: measured, 30,000 rows took 125 MB
 * (4.37 KB a row). Rounded up. There is no ANN index on `table_entry_embeddings`.
 */
export const SEMANTIC_BYTES_PER_ROW = 4_400;

export function estimateSemanticSize(rows: number): SemanticSizeEstimate {
  const bytes = Math.max(0, Math.round(rows)) * SEMANTIC_BYTES_PER_ROW;
  const megabytes = bytes / (1024 * 1024);
  const label =
    megabytes >= 1
      ? `~${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`
      : `~${Math.max(1, Math.round(bytes / 1024))} KB`;
  return { rows, bytes, label };
}
