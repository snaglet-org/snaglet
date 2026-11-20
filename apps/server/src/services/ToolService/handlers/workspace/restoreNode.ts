import { z } from 'zod';
import { restoreItem } from '@server/services/ArchiveService';
import { toolActor } from '@server/services/ToolService/handlers/_shared/toolActor';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

export const WorkspaceRestoreNodeInput = z.object({
  node_id: z.string().describe('The ID of the archived node to restore.'),
  container_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Optional target container_id. When provided overrides auto-placement (drag-to-restore semantics). ' +
        'Pass null explicitly to restore to root. When omitted, the node keeps its existing container_id ' +
        '(which will be NULL for items that were orphan-nulled). Not applicable to threads: a thread ' +
        'restores into its project, or becomes flat when the project is gone.'
    ),
});

export type WorkspaceRestoreNodeInput = z.infer<typeof WorkspaceRestoreNodeInput>;

interface RestoreResult {
  success: boolean;
  node_id: string;
  type: string | null;
  container_id: string | null;
  /** The still-archived container the node was moved out of, when it was re-parented. */
  reparented_from?: string;
  restored_in_cohort: number;
  already_active: boolean;
  message: string;
}

function placement(result: Awaited<ReturnType<typeof restoreItem>>): string {
  if (result.reparentedFrom === undefined) return '';
  const where = result.containerId === null ? 'the root' : `container ${result.containerId}`;
  return ` Its container ${result.reparentedFrom} is still archived, so it was moved to ${where}.`;
}

/**
 * Restore an archived workspace node or custom Database table
 * (catalog id) through the shared ArchiveService. Without container_id, a
 * node whose container is still archived moves to the nearest live ancestor
 * (or the root), so a later sweep of that container cannot delete it.
 */
export default async function execute(
  params: WorkspaceRestoreNodeInput,
  _settings?: Record<string, unknown>,
  context?: ToolHandlerContext
): Promise<RestoreResult> {
  const { node_id, container_id } = params;
  if (!node_id) throw new Error('node_id is required');
  const result = await restoreItem(node_id, {
    actor: toolActor(context),
    emitHooks: true,
    ...(context?.hookOrigin ? { hookOrigin: context.hookOrigin } : {}),
    ...(container_id !== undefined ? { containerId: container_id } : {}),
  });
  const isTable = result.type === 'table';
  const message = result.alreadyActive
    ? isTable
      ? `Table ${result.node?.title ?? node_id} is already active.`
      : `Node ${node_id} (type=${result.type}) is already active.`
    : isTable
      ? `Restored table ${result.node?.title ?? node_id}.`
      : `Restored node ${node_id} (type=${result.type}); restored ${result.cohortIds.length} item(s) in cohort.${placement(result)}`;
  return {
    success: true,
    node_id,
    type: result.type,
    container_id: result.containerId,
    ...(result.reparentedFrom !== undefined ? { reparented_from: result.reparentedFrom } : {}),
    restored_in_cohort: result.cohortIds.length,
    already_active: result.alreadyActive,
    message,
  };
}
