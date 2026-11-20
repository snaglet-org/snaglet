import { Containers } from '@snaglet/db';
import { resolveContainerByPath } from '@server/services/WorkspaceService/pathResolver';
import { archiveItem } from '@server/services/ArchiveService';
import { toolActor } from '@server/services/ToolService/handlers/_shared/toolActor';
import type { ToolHandlerContext } from '@server/services/ToolService/types';

interface ArchiveNodeInput {
  id?: string;
  node_id?: string;
  path?: string;
  kind?: 'node' | 'container';
}

interface ArchiveResult {
  success: boolean;
  node_id: string;
  type: string | null;
  archived_at: string | null;
  cohort_size: number;
  already_archived: boolean;
  message: string;
}

function archiveMessage(id: string, result: Awaited<ReturnType<typeof archiveItem>>): string {
  if (result.type === 'table')
    return result.alreadyArchived
      ? `Table ${result.node?.title ?? id} was already archived.`
      : `Archived table ${result.node?.title ?? id}; its data is kept and restore_node brings it back.`;
  if (result.alreadyArchived) return `Node ${id} (type=${result.type}) was already archived.`;
  return `Archived node ${id} (type=${result.type}); cohort size ${result.cohortIds.length}.`;
}

/**
 * Archive a workspace node or custom Database table (catalog
 * id) through the shared ArchiveService; a table's archive is a step in the
 * agent's undo history.
 */
async function archiveNodeById(
  node_id: string,
  context?: ToolHandlerContext
): Promise<ArchiveResult> {
  if (!node_id) throw new Error('node_id is required');
  const result = await archiveItem(node_id, {
    actor: toolActor(context),
    emitHooks: true,
    ...(context?.hookOrigin ? { hookOrigin: context.hookOrigin } : {}),
  });
  return {
    success: true,
    node_id,
    type: result.type,
    archived_at: result.archivedAt,
    cohort_size: result.cohortIds.length,
    already_archived: result.alreadyArchived,
    message: archiveMessage(node_id, result),
  };
}

export default async function execute(
  params: ArchiveNodeInput,
  _settings?: Record<string, unknown>,
  context?: ToolHandlerContext
): Promise<ArchiveResult> {
  if (params.id && params.path) {
    throw new Error('archive_node: pass either `id` or `path`, not both');
  }
  if (params.path && params.kind !== 'container') {
    throw new Error('archive_node: `path` is supported only with kind "container"');
  }

  let nodeId = params.node_id ?? params.id;
  if (!nodeId && params.path) {
    nodeId = (await resolveContainerByPath(params.path)) ?? undefined;
    if (!nodeId) {
      throw new Error(`archive_node: no container found at path "${params.path}"`);
    }
  }
  if (!nodeId) {
    throw new Error('archive_node: provide either `id` or a container `path`');
  }

  if (params.kind === 'container') {
    const container = await Containers.findById(nodeId);
    if (!container) {
      throw new Error(`archive_node: container "${nodeId}" not found`);
    }
  }

  return archiveNodeById(nodeId, context);
}
