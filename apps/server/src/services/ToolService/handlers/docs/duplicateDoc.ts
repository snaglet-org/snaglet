/**
 * duplicate_doc — clone a single doc to a new title (and optionally a new
 * container).
 *
 * A THIN surface over the shared clone engine (`NodeCloneService.cloneNode`):
 * this tool owns the doc-specific ergonomics — resolve the source/target by id
 * OR path, pick a `new_title` (default `<source> (copy)`), and reject a sibling
 * title collision — then delegates the actual copy (content, node-reference remap,
 * atomic write, realtime tree event, embedding enqueue) to `cloneNode`. That
 * keeps ONE clone implementation shared with `clone_node`, the tree's
 * Cmd/Ctrl+C → Cmd/Ctrl+V gesture, and `POST /api/clone`. Content is copied
 * verbatim, so links and transclusions inside the copy continue to point at the
 * *original* targets — a single doc has nothing else in the copy to re-point to.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { Docs } from '@snaglet/db';
import {
  resolveContainerByPath,
  resolveDocByPath,
} from '@server/services/WorkspaceService/pathResolver';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { cloneNode } from '@server/domains/clone/NodeCloneService';
import { assertNotArchived } from '@server/services/ToolService/tools/_shared/archiveGuard';

interface Input {
  source_id?: string;
  source_path?: string;
  new_title?: string;
  target_container_id?: string | null;
  target_container_path?: string;
  sort_order?: number;
  allow_archived?: boolean;
}

const handler: ToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as unknown as Input;

  // Validate identification
  if (!input.source_id && !input.source_path) {
    throw new Error('duplicate_doc: provide either `source_id` or `source_path`');
  }
  if (input.source_id && input.source_path) {
    throw new Error('duplicate_doc: pass either `source_id` or `source_path`, not both');
  }
  const hasTargetId = input.target_container_id !== undefined;
  const hasTargetPath = typeof input.target_container_path === 'string';
  if (hasTargetId && hasTargetPath) {
    throw new Error(
      'duplicate_doc: pass either `target_container_id` or `target_container_path`, not both'
    );
  }
  if (
    input.sort_order !== undefined &&
    (typeof input.sort_order !== 'number' || !Number.isFinite(input.sort_order))
  ) {
    throw new Error('duplicate_doc: `sort_order` must be a finite number when provided');
  }

  // Resolve source
  const sourceId = input.source_id ? input.source_id : await resolveDocByPath(input.source_path!);
  const source = await Docs.findById(sourceId);
  if (!source) {
    throw new Error(`duplicate_doc: source doc not found: ${sourceId}`);
  }
  assertNotArchived(source, { allow_archived: input.allow_archived });

  // Resolve target container
  let targetContainerId: string | null;
  if (hasTargetId) {
    targetContainerId = input.target_container_id ?? null;
  } else if (hasTargetPath) {
    const p = (input.target_container_path ?? '').trim();
    if (p === '' || p === '/') {
      targetContainerId = null;
    } else {
      const resolved = await resolveContainerByPath(p);
      if (!resolved) {
        throw new Error(`duplicate_doc: target container not found at path "${p}"`);
      }
      targetContainerId = resolved;
    }
  } else {
    targetContainerId = source.containerId;
  }

  // Decide new title and check sibling uniqueness
  // duplicate_doc keeps its throw-on-collision contract (unlike the generic
  // clone engine, which auto-suffixes) — a duplicate with an explicit title
  // should surface the clash rather than silently rename.
  const newTitle = (input.new_title ?? '').trim() || `${source.title} (copy)`;
  const siblings = await Docs.listByContainer(targetContainerId);
  const collision = siblings.find(
    (d) => d.title.localeCompare(newTitle, undefined, { sensitivity: 'accent' }) === 0
  );
  if (collision) {
    throw new Error(
      `duplicate_doc: target container already has a doc titled "${newTitle}" (id=${collision.id})`
    );
  }

  // Delegate the copy to the shared clone engine
  // cloneNode carries content verbatim, remaps node references, writes
  // atomically, and enqueues the embed + realtime event.
  // `titleOverride` gives the clone our chosen title (no collision now, so it
  // lands verbatim without a suffix).
  const { root } = await cloneNode({
    sourceId,
    targetContainerId,
    sortOrder: input.sort_order,
    allowArchived: input.allow_archived,
    titleOverride: newTitle,
  });

  const result = {
    success: true,
    source: { id: source.id, title: source.title },
    doc: {
      id: root.id,
      title: root.title,
      container_id: root.parentId,
      sort_order: root.sortKey ? Number(root.sortKey) : undefined,
      created_at: root.createdAt,
    },
    link: linkForm('doc', root.id, root.title),
    message: `Duplicated doc "${source.title}" (${source.id}) to "${root.title}" (${root.id})`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
