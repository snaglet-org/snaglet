/**
 * move — relocate a doc, container, or thread in the library hierarchy.
 *
 * Resolves the node (by id or path), resolves the destination parent
 * (by id or path; null/"/" = root), then delegates to the model's
 * `moveTo()` method which handles sort_order resolution + sibling bumps.
 *
 * Threads are not in the folder tree: a thread is scoped to a project
 * container or is flat, so for `kind: thread` the destination must be a
 * project container id (or null for flat) and the move goes through
 * `Threads.moveTo`. Any other container is refused with the nearest project
 * named. `sort_order` is the thread's slot in that project's list (0 = top);
 * a project change without one lands at the top.
 *
 * The destination must be a live, non-archived container: `nodes.container_id`
 * cascades on delete, so parenting under a doc or thread would make deleting
 * that doc delete the moved subtree too. The tool checks this up front for a
 * clear message, and every model `moveTo()` enforces it again in its
 * transaction (the HTTP move routes go through the same models). Container
 * cycles are refused by the `trg_nodes_container_no_cycle` DB trigger, which
 * ContainerModel.moveTo reports as a 400.
 */
import type { ToolHandler } from '@server/services/ToolService/types';
import { Containers, Docs, Projects, Threads } from '@snaglet/db';
import {
  resolveContainerByPath,
  resolveNodeByPath,
} from '@server/services/WorkspaceService/pathResolver';
import { linkForm } from '@server/services/ToolService/lib/linkForm';
import { emitTreeNodeUpdated } from '@server/realtime/surfaces/tree';
import { getCurrentActor } from '@server/realtime/actorContext';
import { hooks } from '@server/services/HookService';
import {
  assertNotArchived,
  isArchived,
} from '@server/services/ToolService/tools/_shared/archiveGuard';
type MoveKind = 'doc' | 'container' | 'thread';

interface Input {
  id?: string;
  path?: string;
  kind?: MoveKind;
  new_parent_id?: string | null;
  new_parent_path?: string;
  sort_order?: number;
  allow_archived?: boolean;
}

type SourceNode = {
  id: string;
  archived?: boolean | null;
  archived_at?: string | null;
  containerId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
};
type ClassifyResult = { kind: MoveKind; node: SourceNode };

async function classifyId(id: string): Promise<ClassifyResult> {
  const [doc, container, thread] = await Promise.all([
    Docs.findById(id),
    Containers.findById(id),
    Threads.findById(id),
  ]);
  if (doc) return { kind: 'doc', node: doc as SourceNode };
  if (container) return { kind: 'container', node: container as SourceNode };
  if (thread) return { kind: 'thread', node: thread as SourceNode };
  throw new Error(`workspace_move: node not found for id "${id}"`);
}

/**
 * Refuse a destination that is not a live container before any write. A doc,
 * thread id resolves to no container row, and an archived
 * container would hide the moved node.
 */
async function assertLiveDestination(parentId: string): Promise<void> {
  const parent = await Containers.findById(parentId);
  if (!parent) {
    throw new Error(
      `workspace_move: destination "${parentId}" is not a container. Only containers can hold ` +
        'other nodes; docs and threads cannot be parents.'
    );
  }
  if (isArchived(parent)) {
    throw new Error(
      `workspace_move: destination container "${parentId}" is archived. Restore it first, or ` +
        'choose a live container.'
    );
  }
}

/**
 * A thread's destination is a project. A plain folder or nested non-project
 * container is refused, naming the nearest project at or
 * above it so the caller can retry with that id.
 */
async function assertProjectDestination(projectId: string): Promise<void> {
  const target = await Containers.findById(projectId);
  if (target?.category === 'project') return;
  const nearest = await Projects.nearestProjectForContainer(projectId);
  const hint = nearest
    ? `The nearest project above it is "${nearest}"; pass that as new_parent_id.`
    : 'No project encloses it; pass a project container id, or null to make the thread flat.';
  throw new Error(
    `workspace_move: "${projectId}" is a ${target?.category ?? 'plain'} container, not a project — ` +
      `threads attach to a project, not to any other container. ${hint}`
  );
}

const handler: ToolHandler = async (rawInput, _settings, context) => {
  const input = (rawInput ?? {}) as unknown as Input;

  // Validate target identification
  if (!input.id && !input.path) {
    throw new Error('workspace_move: provide either `id` or `path`');
  }
  if (input.id && input.path) {
    throw new Error('workspace_move: pass either `id` or `path`, not both');
  }

  // Validate destination
  const hasParentId = input.new_parent_id !== undefined;
  const hasParentPath = typeof input.new_parent_path === 'string';
  if (hasParentId && hasParentPath) {
    throw new Error('workspace_move: pass either `new_parent_id` or `new_parent_path`, not both');
  }
  if (!hasParentId && !hasParentPath && input.sort_order === undefined) {
    throw new Error(
      'workspace_move: provide at least one of `new_parent_id`, `new_parent_path`, or `sort_order`'
    );
  }

  // Validate sort_order (early so bad input fails fast)
  if (
    input.sort_order !== undefined &&
    (typeof input.sort_order !== 'number' || !Number.isFinite(input.sort_order))
  ) {
    throw new Error('workspace_move: `sort_order` must be a finite number when provided');
  }

  // Resolve the node
  let kind: MoveKind;
  let nodeId: string;
  let prefetchedSourceNode: SourceNode | null = null;
  if (input.id) {
    nodeId = input.id;
    if (input.kind) {
      kind = input.kind;
    } else {
      const classified = await classifyId(input.id);
      kind = classified.kind;
      prefetchedSourceNode = classified.node;
    }
  } else {
    // Threads are not path-addressable here; only doc/container
    // hints feed the path resolver.
    const pathKindHint = input.kind === 'thread' ? undefined : input.kind;
    const resolved = await resolveNodeByPath(input.path!, pathKindHint);
    kind = resolved.kind;
    nodeId = resolved.id;
  }

  // Fetch source node (archive guard, reused for parent resolution)
  // If classifyId already fetched the node, reuse it — no second round-trip.
  let sourceNode: SourceNode | null = prefetchedSourceNode;
  if (!sourceNode) {
    if (kind === 'doc') {
      sourceNode = (await Docs.findById(nodeId)) as SourceNode | null;
      if (!sourceNode) throw new Error(`workspace_move: doc not found: ${nodeId}`);
    } else if (kind === 'thread') {
      sourceNode = (await Threads.findById(nodeId)) as SourceNode | null;
      if (!sourceNode) throw new Error(`workspace_move: thread not found: ${nodeId}`);
    } else {
      sourceNode = (await Containers.findById(nodeId)) as SourceNode | null;
      if (!sourceNode) throw new Error(`workspace_move: container not found: ${nodeId}`);
    }
  }

  assertNotArchived(sourceNode, { allow_archived: input.allow_archived });

  // Resolve destination parent
  let newParentId: string | null | undefined;
  if (hasParentId) {
    newParentId = input.new_parent_id ?? null;
  } else if (hasParentPath) {
    const p = (input.new_parent_path ?? '').trim();
    if (p === '' || p === '/') {
      newParentId = null;
    } else {
      const resolved = await resolveContainerByPath(p);
      if (!resolved) {
        throw new Error(`workspace_move: destination container not found at path "${p}"`);
      }
      newParentId = resolved;
    }
  }
  // If neither was provided, we keep current parent (pass-through; the model
  // requires a parentId for moveTo, so fetch current). A thread's parent is
  // its project, so a thread given only sort_order reorders within it.
  if (newParentId === undefined) {
    // Reuse the already-fetched sourceNode — no second lookup needed.
    if (kind === 'doc') {
      newParentId = sourceNode.containerId ?? null;
    } else if (kind === 'thread') {
      newParentId = sourceNode.projectId ?? null;
    } else {
      newParentId = sourceNode.parentId ?? null;
    }
  }

  if ((hasParentId || hasParentPath) && newParentId !== null) {
    await assertLiveDestination(newParentId);
    if (kind === 'thread') await assertProjectDestination(newParentId);
  }

  // Perform the move
  // Actor member id (from the ambient run/request context) is recorded on the
  // placement_events row the model writes for a container-changing move.
  const movedBy = getCurrentActor()?.actorId ?? null;
  const origin = context?.hookOrigin;
  let titleField: string;
  let sortOrder: number;
  let updatedAt: string;
  if (kind === 'doc') {
    // Previous parent, captured ahead of the move for the doc:move lifecycle hook.
    const oldContainerId = sourceNode.containerId ?? null;
    const moved = await Docs.moveTo(nodeId, newParentId, input.sort_order, movedBy);
    if (!moved) throw new Error(`workspace_move: doc not found: ${nodeId}`);
    titleField = moved.title;
    sortOrder = moved.sortOrder;
    updatedAt = moved.updatedAt;
    if (oldContainerId !== (newParentId ?? null)) {
      hooks.emit('doc:move', {
        id: nodeId,
        fromContainerId: oldContainerId,
        toContainerId: newParentId ?? null,
        ...(origin ? { origin } : {}),
      });
    }
  } else if (kind === 'thread') {
    // A thread's "parent" is its project; null makes it flat. Without
    // sort_order a project change lands at the top of that list. The model
    // shifts the siblings and records the change in placement_events itself.
    const oldProjectId = sourceNode.projectId ?? null;
    const moved = await Threads.moveTo(nodeId, {
      projectId: newParentId,
      ...(input.sort_order !== undefined ? { sortOrder: input.sort_order } : {}),
    });
    if (!moved) throw new Error(`workspace_move: thread not found: ${nodeId}`);
    titleField = moved.title ?? '';
    sortOrder = moved.sortOrder;
    updatedAt = moved.updatedAt ?? moved.createdAt;
    if (oldProjectId !== newParentId) {
      hooks.emit('thread:move', {
        id: nodeId,
        fromProjectId: oldProjectId,
        toProjectId: newParentId,
        fromContainerId: oldProjectId,
        toContainerId: newParentId,
        ...(origin ? { origin } : {}),
      });
    }
  } else {
    const oldParentId = sourceNode.parentId ?? null;
    const moved = await Containers.moveTo(nodeId, newParentId, input.sort_order, movedBy);
    if (!moved) throw new Error(`workspace_move: container not found: ${nodeId}`);
    titleField = moved.name;
    sortOrder = moved.sortOrder;
    updatedAt = moved.updatedAt;
    if (oldParentId !== (newParentId ?? null)) {
      hooks.emit('container:move', {
        id: nodeId,
        fromParentId: oldParentId,
        toParentId: newParentId ?? null,
        ...(origin ? { origin } : {}),
      });
    }
  }

  emitTreeNodeUpdated({
    id: nodeId,
    kind,
    parentId: newParentId,
    sortKey: String(sortOrder),
    updatedAt,
  });

  // Every MoveKind is also a link scheme (ids are self-identifying).
  const linkScheme = kind;
  const result = {
    success: true,
    kind,
    moved: {
      id: nodeId,
      title: titleField,
      new_parent_id: newParentId,
      sort_order: sortOrder,
    },
    link: linkForm(linkScheme, nodeId, titleField),
    message:
      kind === 'thread'
        ? `Moved thread "${titleField}" (${nodeId}) to project=${newParentId ?? 'none (flat)'} sort_order=${sortOrder}`
        : `Moved ${kind} "${titleField}" (${nodeId}) to parent=${newParentId ?? 'root'} sort_order=${sortOrder}`,
  };
  return { output: JSON.stringify(result, null, 2), rawContent: result };
};

export default handler;
