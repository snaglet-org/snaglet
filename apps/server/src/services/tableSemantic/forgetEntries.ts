import { TableSemantic } from '@snaglet/db/tables/table_semantic';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';

/**
 * A deleted row's vector goes with it. Kept apart from the service so the
 * table domain can call it without loading the embedder; the sweep removes
 * any vector this misses (an undo, a SQL delete).
 */
export async function forgetEntries(tableId: string, entryIds: readonly string[]): Promise<void> {
  try {
    await TableSemantic.deleteEntries(tableId, entryIds);
  } catch (error) {
    logger.warn(`[table-semantic] could not delete vectors: ${getErrorMessage(error)}`);
  }
}
