/**
 * surfaces/tree.ts — typed emit helpers for the workspace tree surface.
 *
 * The workspace tree is a single visual surface containing nodes of several
 * kinds (doc / container / thread / image). Most mutations are
 * polymorphic — a rename or move tool can target any kind — so all tree
 * helpers live in one file.
 *
 * ## The chokepoint rule
 *
 * Routes and tools must call helpers from this module. Do not import
 * `emitWorkspaceEvent` directly from `@server/realtime/emit` outside this
 * `surfaces/` directory. The helpers below are the only sanctioned way to
 * publish workspace-tree events.
 *
 * See `docs/architecture.md` for the full runbook.
 */

import { NODE_KIND } from '@snaglet/shared/constants';
import type { ContainerCategory } from '@snaglet/shared/constants';
import type {
  WorkspaceNodeKind,
  WorkspaceNodeSnapshot,
  WorkspaceNodePatch,
} from '@snaglet/shared/types/workspace-events';
import { emitWorkspaceEvent } from '../emit';
import { hooks } from '@server/services/HookService';
import { getCurrentActor } from '@server/realtime/actorContext';

// DB rows use kind-specific shapes (DocRow has `containerId` + numeric
// `sortOrder`, ContainerRow has `parentId`, ThreadRow has `projectId` and a
// nullable `title`, etc.). The wire schema uses a single normalized shape.
// These mappers are the canonical translation point so route + tool authors
// don't have to hand-roll it.

interface DocRowLike {
  id: string;
  containerId: string | null;
  title: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface ContainerRowLike {
  id: string;
  parentId: string | null;
  name: string;
  category?: ContainerCategory | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Threads are not placed in the folder tree: `projectId` is the project
 * container the thread is scoped to, or null for a flat thread, and
 * `sortOrder` is its manual position in that project's list. Extra
 * `ThreadRow` fields are accepted so a full row can be passed.
 */
export interface ThreadRowLike {
  id: string;
  title: string | null;
  projectId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string | null;
}

interface ImageRowLike {
  id: string;
  name: string;
  containerId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function snapshotFromDoc(doc: DocRowLike): WorkspaceNodeSnapshot {
  return {
    id: doc.id,
    kind: 'doc',
    title: doc.title,
    parentId: doc.containerId,
    sortKey: String(doc.sortOrder),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function snapshotFromContainer(container: ContainerRowLike): WorkspaceNodeSnapshot {
  return {
    id: container.id,
    kind: 'container',
    title: container.name,
    parentId: container.parentId,
    sortKey: String(container.sortOrder),
    category: container.category ?? null,
    createdAt: container.createdAt,
    updatedAt: container.updatedAt,
  };
}

/**
 * Map a `ThreadRow` to the wire snapshot. On the tree surface a thread's
 * parent is its project (null = the flat list at the root) and its `sortKey`
 * is its manual position in that list. Threads may have `updatedAt: null`
 * (never updated since creation) — fall back to `createdAt` so the wire
 * schema's `updatedAt: string` invariant holds.
 */
export function snapshotFromThread(thread: ThreadRowLike): WorkspaceNodeSnapshot {
  return {
    id: thread.id,
    kind: 'thread',
    title: thread.title ?? '',
    parentId: thread.projectId,
    sortKey: String(thread.sortOrder),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt ?? thread.createdAt,
  };
}

export function snapshotFromImage(image: ImageRowLike): WorkspaceNodeSnapshot {
  return {
    id: image.id,
    kind: 'image',
    title: image.name,
    parentId: image.containerId,
    sortKey: String(image.sortOrder),
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
  };
}

/**
 * Emit a `workspace.created` event with a full node snapshot.
 *
 * Call after the DB mutation has committed successfully. Failures inside
 * the emit are logged and swallowed by `emit.ts` — they never fail the
 * mutation.
 */
export function emitTreeNodeCreated(node: WorkspaceNodeSnapshot): void {
  emitWorkspaceEvent({
    type: 'workspace.created',
    node,
  });
  if (node.kind === NODE_KIND.DOC) {
    hooks.emit('doc:create', {
      id: node.id,
      title: node.title,
      parentContainerId: node.parentId,
      createdBy: getCurrentActor()?.actorId ?? null,
    });
  } else if (node.kind === NODE_KIND.CONTAINER) {
    hooks.emit('container:create', {
      id: node.id,
      name: node.title,
      category: node.category ?? null,
      parentId: node.parentId,
    });
  }
}

/**
 * Emit a `workspace.updated` event with a partial patch.
 *
 * The patch must include the node's `kind` so cross-client adapters can
 * route to the correct kind-scoped store without a snapshot lookup. Only
 * fields that actually changed should be present beyond `id` / `kind` /
 * `updatedAt`.
 */
export function emitTreeNodeUpdated(patch: WorkspaceNodePatch): void {
  emitWorkspaceEvent({
    type: 'workspace.updated',
    patch,
  });
}

/**
 * Emit a `workspace.deleted` event.
 *
 * `kind` is required so receivers can prune kind-scoped caches without
 * resolving the id first.
 */
export function emitTreeNodeDeleted(id: string, kind: WorkspaceNodeKind): void {
  emitWorkspaceEvent({
    type: 'workspace.deleted',
    id,
    kind,
  });
}

/**
 * Emit a `workspace.archived` event.
 *
 * Archive is a first-class wire event (not folded into `workspace.updated`)
 * so clients can apply archive-specific UI without inspecting patches.
 */
export function emitTreeNodeArchived(
  id: string,
  kind: WorkspaceNodeKind,
  archivedAt: string
): void {
  emitWorkspaceEvent({
    type: 'workspace.archived',
    id,
    kind,
    archivedAt,
  });
}

/**
 * Emit a `workspace.restored` event with a full snapshot of the restored
 * node so clients can re-insert it without a refetch.
 */
export function emitTreeNodeRestored(node: WorkspaceNodeSnapshot): void {
  emitWorkspaceEvent({
    type: 'workspace.restored',
    id: node.id,
    kind: node.kind,
    node,
  });
}

/**
 * Emit a `doc.saved` event with the full new body.
 *
 * Separate from `workspace.updated` so the common rename/move event stays small
 * and open editors can filter for body changes cheaply. No body diffs: the
 * event carries the whole body.
 *
 * `lastEditedBy` is the members.id the save stamped on the doc (the row's
 * `lastEditedBy`). It rides along so open doc headers can refresh "Edited
 * by"; a null/undefined editor (unattributed save) leaves it off the wire.
 */
export function emitDocBodySaved(
  id: string,
  body: string,
  updatedAt: string,
  lastEditedBy?: string | null
): void {
  emitWorkspaceEvent({
    type: 'doc.saved',
    id,
    body,
    updatedAt,
    ...(lastEditedBy ? { lastEditedBy } : {}),
  });
}
