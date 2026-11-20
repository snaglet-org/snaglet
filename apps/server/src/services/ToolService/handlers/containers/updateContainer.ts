import {
  assertProjectFolderIdle,
  validateProjectFolderChange,
} from '@server/services/projectFolderImpact';
/**
 * update_container — change a container's description and/or project facets
 * (folder_path, github_url) in place.
 *
 * Agents can set/clear a project container's folder_path/github_url, or
 * set/clear any container's description. A container's category is fixed at
 * creation: `project` is the only category, and threads and tables are scoped
 * to a project container, so there is nothing to change it to (the model and a
 * DB trigger refuse a change too).
 *
 * "Field present with null" means UNSET; an omitted field is left unchanged —
 * so the handler keys off whether the property is present on the input object.
 * folder_path/github_url/description normalize like the projects PATCH route:
 * an empty string is treated as a clear (null). Renames go through
 * workspace_rename and moves through workspace_move; this tool touches only
 * the annotation + facet + description columns (ContainerModel.update, which
 * already owns folder_path/github_url/description).
 *
 * `description` is not category-gated — any container's description is
 * embedded as a retrieval signal, and a project container's description feeds
 * scope injection — so it is exposed here rather than gated to
 * category='project'.
 */

import { Containers } from '@snaglet/db/tables/containers';
import type { ToolHandler } from '@server/services/ToolService/types';
import { resolveContainerByPath } from '@server/services/WorkspaceService/pathResolver';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { emitTreeNodeUpdated } from '@server/realtime/surfaces/tree';
import { hooks } from '@server/services/HookService';

interface UpdateContainerUpdate {
  folderPath?: string | null;
  githubUrl?: string | null;
  description?: string | null;
}

/**
 * Normalize an optional facet string. Mirrors the projects PATCH route's
 * `normalizeOptional`: an explicit `null` or a blank string is a clear; a
 * non-empty string is trimmed; anything else is rejected.
 */
function parseFacet(raw: unknown, field: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error(`update_container: \`${field}\` must be a string or null`);
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const handler: ToolHandler = async (input, _settings, context) => {
  if (!input || typeof input !== 'object') {
    throw new Error('update_container: input must be an object');
  }
  const i = input as Record<string, unknown>;

  const containerId = typeof i.container_id === 'string' ? i.container_id.trim() : '';
  const containerPath = typeof i.container_path === 'string' ? i.container_path.trim() : '';
  if (containerId && containerPath) {
    throw new Error('update_container: pass either `container_id` or `container_path`, not both');
  }
  if (!containerId && !containerPath) {
    throw new Error('update_container: provide `container_id` or `container_path`');
  }

  // Present-with-null = unset; absent = leave unchanged.
  const update: UpdateContainerUpdate = {};
  if ('folder_path' in i) {
    update.folderPath = parseFacet(i.folder_path, 'folder_path');
  }
  if ('github_url' in i) {
    update.githubUrl = parseFacet(i.github_url, 'github_url');
  }
  if ('description' in i) {
    update.description = parseFacet(i.description, 'description');
  }

  if (
    update.folderPath === undefined &&
    update.githubUrl === undefined &&
    update.description === undefined
  ) {
    throw new Error(
      'update_container: provide at least one field to change (`folder_path`, `github_url`, and/or `description`)'
    );
  }

  const resolvedId = containerId || (await resolveContainerByPath(containerPath));
  if (!resolvedId) {
    throw new Error(`update_container: container not found at path "${containerPath}"`);
  }
  const existing = await Containers.findById(resolvedId);
  if (!existing) {
    throw new Error(`update_container: container not found: ${resolvedId}`);
  }
  if (update.folderPath !== undefined) assertProjectFolderIdle(resolvedId);
  let folderWarnings: string[] = [];
  if (update.folderPath) {
    const impact = await validateProjectFolderChange(
      update.folderPath,
      resolvedId,
      existing.folderPath
    );
    update.folderPath = impact.folderPath;
    folderWarnings = impact.warnings;
  }
  const updated = await Containers.update(resolvedId, update);
  if (!updated) {
    throw new Error(`update_container: update failed for ${resolvedId}`);
  }

  emitTreeNodeUpdated({
    id: updated.id,
    kind: 'container',
    parentId: updated.parentId,
    sortKey: String(updated.sortOrder),
    category: updated.category,
    updatedAt: updated.updatedAt,
  });

  hooks.emit('container:update', {
    id: resolvedId,
    changed: Object.keys(update),
    ...(context?.hookOrigin ? { origin: context.hookOrigin } : {}),
  });

  const result = {
    success: true,
    container: {
      id: updated.id,
      name: updated.name,
      parent_id: updated.parentId,
      category: updated.category,
      folder_path: updated.folderPath,
      github_url: updated.githubUrl,
      description: updated.description,
    },
    link: linkForm('container', updated.id, updated.name),
    // The link went through, but the folder looked unusual. The agent must see why.
    ...(folderWarnings.length > 0 ? { folder_warnings: folderWarnings } : {}),
  };

  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
