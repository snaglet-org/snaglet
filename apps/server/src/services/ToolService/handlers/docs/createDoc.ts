/**
 * create_doc — create a markdown doc in the library hierarchy.
 *
 * Parent resolution (delegated to `resolveParentContainerOrThrow`):
 *   - `parent_id` XOR `parent_path`, or neither → thread's container, else root.
 *   - `container_id` / `container_path` are accepted as aliases.
 *   - Loose keys (`container`, `parent`, `container_name`, `parent_name`) are
 *     recognized and resolved leniently (id first, then path/name walk).
 *   - A parent reference that is provided but does not resolve throws loudly;
 *     it never silently falls back to root.
 *   - Passing conflicting references is rejected to surface caller bugs.
 *
 * Enforces case-insensitive sibling-title uniqueness within the container.
 * Auto-defaults `sort_order` to (max sibling + 1).
 */

import { Docs } from '@snaglet/db/tables/docs';
import type { ToolHandler } from '@server/services/ToolService/types';
import { lintCanonicalWorkspaceReferencesInContent } from '@server/services/SocketService/outboundMessageLinter';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { emitTreeNodeCreated, snapshotFromDoc } from '@server/realtime/surfaces/tree';
import { embedDocNow } from '@server/services/embedding/embedDoc';
import {
  pickLooseParentRef,
  resolveParentContainerOrThrow,
} from '@server/services/ToolService/tools/_shared/parentContainerResolution';

interface CreateDocInputShape {
  title: string;
  parent_id?: string;
  parent_path?: string;
  loose_parent?: { key: string; value: string };
  content?: string;
  sort_order?: number;
}

function coerceOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`create_doc: \`${field}\` must be a string when provided`);
  }
  return value.length > 0 ? value : undefined;
}

function parseInput(input: unknown): CreateDocInputShape {
  if (!input || typeof input !== 'object') {
    throw new Error('create_doc: input must be an object');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.title !== 'string' || i.title.trim().length === 0) {
    throw new Error('create_doc: `title` is required and must be a non-empty string');
  }

  const parentId = coerceOptionalString(i.parent_id, 'parent_id');
  const parentPath = coerceOptionalString(i.parent_path, 'parent_path');
  const containerId = coerceOptionalString(i.container_id, 'container_id');
  const containerPath = coerceOptionalString(i.container_path, 'container_path');

  // Reject conflicting aliases — surfaces caller bugs instead of silently dropping one.
  if (parentId !== undefined && containerId !== undefined && parentId !== containerId) {
    throw new Error(
      'create_doc: `parent_id` and `container_id` were both provided with different values. Use only `parent_id`.'
    );
  }
  if (parentPath !== undefined && containerPath !== undefined && parentPath !== containerPath) {
    throw new Error(
      'create_doc: `parent_path` and `container_path` were both provided with different values. Use only `parent_path`.'
    );
  }

  if (i.content !== undefined && typeof i.content !== 'string') {
    throw new Error('create_doc: `content` must be a string when provided');
  }
  if (
    i.sort_order !== undefined &&
    (typeof i.sort_order !== 'number' || !Number.isFinite(i.sort_order))
  ) {
    throw new Error('create_doc: `sort_order` must be a finite number when provided');
  }
  return {
    title: i.title.trim(),
    parent_id: parentId ?? containerId,
    parent_path: parentPath ?? containerPath,
    // Loose keys (`container`, `parent`, …) — recognized so a provided-but-
    // unresolvable parent reference errors instead of silently landing at root.
    loose_parent: pickLooseParentRef(i, 'create_doc'),
    content: (i.content as string | undefined) ?? '',
    sort_order: i.sort_order as number | undefined,
  };
}

const handler: ToolHandler = async (input, _settings, context) => {
  const params = parseInput(input);

  // Resolve the parent: loud failure for any provided-but-unresolvable
  // reference. When no parent is given at all, drop the doc in the calling
  // thread's container so it lands "here" instead of at workspace root.
  const containerId = await resolveParentContainerOrThrow(
    'create_doc',
    {
      parentId: params.parent_id,
      parentPath: params.parent_path,
      looseValue: params.loose_parent?.value,
      looseKey: params.loose_parent?.key,
    },
    context?.threadId ?? null
  );

  const referenceLint = await lintCanonicalWorkspaceReferencesInContent(params.content ?? '');
  if (referenceLint.infrastructureError) {
    throw new Error('create_doc: workspace reference validation is temporarily unavailable');
  }
  if (referenceLint.issues.length > 0) {
    const details = referenceLint.issues
      .map((issue) => `${issue.id} (${issue.reason.replace('_', ' ')})`)
      .join(', ');
    throw new Error(`create_doc: content contains unverified workspace reference(s): ${details}`);
  }

  // Enforce sibling-title uniqueness (case-insensitive).
  const siblings = await Docs.listByContainer(containerId);
  const collision = siblings.find(
    (d) => d.title.localeCompare(params.title, undefined, { sensitivity: 'accent' }) === 0
  );
  if (collision) {
    throw new Error(
      `create_doc: a doc titled "${params.title}" already exists in this container (id=${collision.id})`
    );
  }

  const sortOrder =
    params.sort_order ??
    (siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.sortOrder ?? 0)) + 1);

  const created = await Docs.create({
    title: params.title,
    containerId,
    content: params.content ?? '',
    sortOrder,
  });

  emitTreeNodeCreated(snapshotFromDoc(created));
  embedDocNow(created.id, created.title, created.content);

  const result = {
    success: true,
    doc: {
      id: created.id,
      title: created.title,
      container_id: created.containerId,
      content: created.content,
      sort_order: created.sortOrder,
      created_at: created.createdAt,
      // Attribution is derived, not settable: created_by is stamped with the
      // acting member (the calling agent/user), or null if unattributed.
      created_by: created.createdBy,
    },
    link: linkForm('doc', created.id, created.title),
  };

  return {
    output: JSON.stringify(result, null, 2),
    rawContent: result,
  };
};

export default handler;
