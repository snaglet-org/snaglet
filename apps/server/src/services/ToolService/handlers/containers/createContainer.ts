import { validateProjectFolderChange } from '@server/services/projectFolderImpact';
/**
 * create_container — create a container in the library hierarchy.
 *
 * Parent resolution (delegated to `resolveParentContainerOrThrow`):
 *   - `parent_id` (validated to exist) XOR `parent_path` (resolved via name walk),
 *     or neither → thread's container, else root.
 *   - `container_id` / `container_path` are accepted as aliases (conflicting
 *     values are rejected), matching create_doc.
 *   - Loose keys (`container`, `parent`, `container_name`, `parent_name`) are
 *     recognized and resolved leniently (id first, then path/name walk).
 *   - A parent reference that is PROVIDED but does not resolve throws loudly
 *     — it never silently falls back to root.
 *
 * Enforces case-insensitive sibling-name uniqueness, since ContainerModel.create
 * does not. Auto-defaults `sort_order` to (max sibling + 1).
 */

import { Containers } from '@snaglet/db/tables/containers';
import { isContainerCategory } from '@snaglet/shared/constants';
import type { ContainerCategory } from '@snaglet/shared/constants';
import type { ToolHandler } from '@server/services/ToolService/types';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { emitTreeNodeCreated, snapshotFromContainer } from '@server/realtime/surfaces/tree';
import {
  pickLooseParentRef,
  resolveParentContainerOrThrow,
} from '@server/services/ToolService/tools/_shared/parentContainerResolution';

interface CreateContainerInputShape {
  name: string;
  parent_id?: string;
  parent_path?: string;
  loose_parent?: { key: string; value: string };
  category?: ContainerCategory;
  folder_path?: string;
  github_url?: string;
  sort_order?: number;
}

function parseInput(input: unknown): CreateContainerInputShape {
  if (!input || typeof input !== 'object') {
    throw new Error('create_container: input must be an object');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || i.name.trim().length === 0) {
    throw new Error('create_container: `name` is required and must be a non-empty string');
  }
  if (i.parent_id !== undefined && i.parent_id !== null && typeof i.parent_id !== 'string') {
    throw new Error('create_container: `parent_id` must be a string when provided');
  }
  if (i.parent_path !== undefined && i.parent_path !== null && typeof i.parent_path !== 'string') {
    throw new Error('create_container: `parent_path` must be a string when provided');
  }
  if (
    i.container_id !== undefined &&
    i.container_id !== null &&
    typeof i.container_id !== 'string'
  ) {
    throw new Error('create_container: `container_id` must be a string when provided');
  }
  if (
    i.container_path !== undefined &&
    i.container_path !== null &&
    typeof i.container_path !== 'string'
  ) {
    throw new Error('create_container: `container_path` must be a string when provided');
  }
  const parentId = (i.parent_id as string | undefined) || undefined;
  const parentPath = (i.parent_path as string | undefined) || undefined;
  const containerId = (i.container_id as string | undefined) || undefined;
  const containerPath = (i.container_path as string | undefined) || undefined;
  // Reject conflicting aliases — surfaces caller bugs instead of silently dropping one.
  if (parentId !== undefined && containerId !== undefined && parentId !== containerId) {
    throw new Error(
      'create_container: `parent_id` and `container_id` were both provided with different values. Use only `parent_id`.'
    );
  }
  if (parentPath !== undefined && containerPath !== undefined && parentPath !== containerPath) {
    throw new Error(
      'create_container: `parent_path` and `container_path` were both provided with different values. Use only `parent_path`.'
    );
  }
  if (
    i.sort_order !== undefined &&
    (typeof i.sort_order !== 'number' || !Number.isFinite(i.sort_order))
  ) {
    throw new Error('create_container: `sort_order` must be a finite number when provided');
  }
  // Validate the taxonomy fields against the shared value lists (the DB CHECK
  // is the authoritative backstop; this is the friendly fast-fail).
  if (i.category !== undefined && i.category !== null && !isContainerCategory(i.category)) {
    throw new Error('create_container: `category` must be `project` when provided');
  }
  // Project facets (folder_path / github_url) — trivially accepted at creation
  // so a project can be minted in one call, matching the UI promote flow. Only
  // meaningful when category='project'; harmless (a nullable column) otherwise.
  if (i.folder_path !== undefined && i.folder_path !== null && typeof i.folder_path !== 'string') {
    throw new Error('create_container: `folder_path` must be a string when provided');
  }
  if (i.github_url !== undefined && i.github_url !== null && typeof i.github_url !== 'string') {
    throw new Error('create_container: `github_url` must be a string when provided');
  }
  const folderPath =
    typeof i.folder_path === 'string' && i.folder_path.trim().length > 0
      ? i.folder_path.trim()
      : undefined;
  const githubUrl =
    typeof i.github_url === 'string' && i.github_url.trim().length > 0
      ? i.github_url.trim()
      : undefined;
  return {
    name: i.name.trim(),
    parent_id: parentId ?? containerId,
    parent_path: parentPath ?? containerPath,
    // Loose keys (`container`, `parent`, …) — recognized so a provided-but-
    // unresolvable parent reference errors instead of silently landing at root.
    loose_parent: pickLooseParentRef(i, 'create_container'),
    category: (i.category as ContainerCategory | undefined) || undefined,
    folder_path: folderPath,
    github_url: githubUrl,
    sort_order: i.sort_order as number | undefined,
  };
}

const handler: ToolHandler = async (input, _settings, context) => {
  const params = parseInput(input);

  // Resolve the parent: loud failure for any provided-but-unresolvable
  // reference. When no parent is given at all, nest the new container under
  // the calling thread's container so it lands "here" instead of at root.
  const parentId = await resolveParentContainerOrThrow(
    'create_container',
    {
      parentId: params.parent_id,
      parentPath: params.parent_path,
      looseValue: params.loose_parent?.value,
      looseKey: params.loose_parent?.key,
    },
    context?.threadId ?? null
  );

  // Enforce sibling-name uniqueness (case-insensitive).
  const siblings = await Containers.listByParent(parentId);
  const collision = siblings.find(
    (c) => c.name.localeCompare(params.name, undefined, { sensitivity: 'accent' }) === 0
  );
  if (collision) {
    throw new Error(
      `create_container: a container named "${params.name}" already exists at this level (id=${collision.id})`
    );
  }

  const sortOrder =
    params.sort_order ??
    (siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.sortOrder ?? 0)) + 1);

  let folderWarnings: string[] = [];
  if (params.folder_path) {
    const impact = await validateProjectFolderChange(params.folder_path);
    params.folder_path = impact.folderPath;
    folderWarnings = impact.warnings;
  }
  const created = await Containers.create({
    name: params.name,
    parentId,
    category: params.category ?? null,
    folderPath: params.folder_path ?? null,
    githubUrl: params.github_url ?? null,
    sortOrder,
  });
  emitTreeNodeCreated(snapshotFromContainer(created));

  const result = {
    success: true,
    container: {
      id: created.id,
      name: created.name,
      parent_id: created.parentId,
      category: created.category,
      folder_path: created.folderPath,
      github_url: created.githubUrl,
      sort_order: created.sortOrder,
      created_at: created.createdAt,
    },
    link: linkForm('container', created.id, created.name),
    // The link went through, but the folder looked unusual. The agent must see why.
    ...(folderWarnings.length > 0 ? { folder_warnings: folderWarnings } : {}),
  };

  return {
    output: JSON.stringify(result, null, 2),
    rawContent: result,
  };
};

export default handler;
