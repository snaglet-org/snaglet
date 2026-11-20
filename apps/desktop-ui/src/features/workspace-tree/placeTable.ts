import { tablesApi } from '@desktop/utils/api';
import { emitTableEvent } from '@desktop/features/database/tableEvents';
import { currentEntryFromError } from '@desktop/features/database/useTableProjectLink';

/**
 * Move one custom table within the workspace tree: link it to `projectId`
 * (`null` = unlinked) at `sortOrder` in that Tables list, or at the bottom
 * when no slot is given. The returned entry is announced on the table bus so
 * every Tables group repaints at once; the server's own `table.updated`
 * echoes (including the siblings it shifted) are idempotent upserts. A
 * refusal that carries the table's current entry announces that instead, so
 * a stale row catches up, and is rethrown for the caller to report. Table
 * placement is not an undo step.
 */
export async function placeTable(
  tableId: string,
  placement: { projectId: string | null; sortOrder?: number }
): Promise<void> {
  try {
    const { table } = await tablesApi.setPlacement(tableId, {
      projectId: placement.projectId,
      ...(placement.sortOrder !== undefined ? { sortOrder: placement.sortOrder } : {}),
    });
    emitTableEvent({ type: 'table.updated', table });
  } catch (err) {
    const current = currentEntryFromError(err);
    if (current?.id === tableId) emitTableEvent({ type: 'table.updated', table: current });
    throw err;
  }
}
