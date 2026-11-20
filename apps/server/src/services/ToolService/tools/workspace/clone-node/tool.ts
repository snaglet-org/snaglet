/**
 * clone_node — copy/paste a workspace node (and, for containers, its whole
 * subtree) with fresh ids.
 *
 * A thin surface over `NodeCloneService.cloneNode` — the same engine that
 * backs the tree's Cmd/Ctrl+C → Cmd/Ctrl+V gesture and the POST /api/clone
 * route. This tool calls `cloneNode` DIRECTLY (not over HTTP) so per-kind
 * rules, node-reference remap, the atomic transaction, realtime tree events, and
 * embedding enqueue are all shared with the mouse gesture — one clone
 * implementation.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { cloneNode } from '@server/domains/clone/NodeCloneService';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import type { LinkNodeType } from '@snaglet/db/tables/links';

interface Input {
  id?: string;
  target_container_id?: string | null;
  sort_order?: number;
  allow_archived?: boolean;
}

const handler: ToolHandler = async (rawInput) => {
  const input = (rawInput ?? {}) as unknown as Input;

  const sourceId = typeof input.id === 'string' ? input.id.trim() : '';
  if (!sourceId) {
    throw new Error('clone_node: `id` (the node to clone) is required');
  }

  if (
    input.sort_order !== undefined &&
    (typeof input.sort_order !== 'number' || !Number.isFinite(input.sort_order))
  ) {
    throw new Error('clone_node: `sort_order` must be a finite number when provided');
  }

  // target_container_id tri-state (mirrors POST /api/clone): absent → paste
  // beside the original (source's parent); null or empty string → workspace
  // root; a non-empty string → that container.
  let targetContainerId: string | null | undefined;
  if (!('target_container_id' in input)) {
    targetContainerId = undefined;
  } else if (input.target_container_id === null) {
    targetContainerId = null;
  } else if (typeof input.target_container_id === 'string') {
    targetContainerId = input.target_container_id.length > 0 ? input.target_container_id : null;
  } else {
    throw new Error('clone_node: `target_container_id` must be a string or null');
  }

  const { root, count } = await cloneNode({
    sourceId,
    targetContainerId,
    sortOrder: input.sort_order,
    allowArchived: input.allow_archived === true,
  });

  // Snapshot kind maps 1:1 onto the link scheme (doc | container | thread |
  // image); linkForm drops the scheme for prefixed ids, so this is just the
  // ready-to-paste `[Title](id)` reference for the clone's new root.
  const link = linkForm(root.kind as LinkNodeType, root.id, root.title);

  const result = {
    success: true,
    kind: root.kind,
    node: {
      id: root.id,
      title: root.title,
      container_id: root.parentId,
      sort_order: root.sortKey ? Number(root.sortKey) : undefined,
    },
    node_count: count,
    link,
    message: `Cloned ${root.kind} ${sourceId} → "${root.title}" (${root.id}); ${count} node(s) created`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
