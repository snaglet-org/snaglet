import type { ContainerCategory } from '@snaglet/shared/constants';
import type { ContainerTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import { moveNode } from '@desktop/features/workspace-tree/moveNode';

export const TREE_NODE_MIME = 'application/x-snaglet-tree-node';

type MovableKind = 'container' | 'doc' | 'thread';
export interface TreeDragPayload {
  id: string;
  kind: string;
  /**
   * Pre-drag placement + display name, stamped at dragstart by the source
   * surface (tree row or icon cell). Read after a successful drop to record
   * an exact undo inverse. Optional — older/external producers may omit it.
   */
  parentId?: string | null;
  sortOrder?: number;
  label?: string;
}

/**
 * Kinds a drop can move at all. Whether a given target accepts one is
 * `canDropInto` — a thread is movable, but only onto a project.
 */
const MOVABLE: Set<string> = new Set<MovableKind>(['container', 'doc', 'thread']);
const isMovableKind = (kind: string): kind is MovableKind => MOVABLE.has(kind);

/**
 * Whether a dragged node may be dropped into a container of this category.
 * Folders and docs reparent anywhere; a thread never lives in a folder, so it
 * is droppable only onto a project (it attaches to it).
 */
export function canDropInto(kind: string, targetCategory: ContainerCategory | null): boolean {
  if (kind === 'thread') return targetCategory === 'project';
  return MOVABLE.has(kind);
}

/**
 * Re-parent one dropped node into `containerId` through the shared move
 * mutation, which already turns a thread's move into a project scope change
 * (the server refuses a non-project target). Moving into self is a no-op.
 */
export async function moveNodeInto(payload: TreeDragPayload, containerId: string): Promise<void> {
  const { id, kind } = payload;
  if (id === containerId || !isMovableKind(kind)) return;
  await moveNode(kind, id, containerId);
}

/** Walk a hydrated tree to find a container by id. Used to refresh the
 *  current pane's children from a listTree response without an extra
 *  per-container endpoint. */
export function findContainerInTree(
  nodes: LibraryTreeChild[],
  id: string
): ContainerTreeNode | null {
  for (const n of nodes) {
    if (n.kind !== 'container') continue;
    if (n.id === id) return n;
    const inChildren = findContainerInTree(n.children ?? [], id);
    if (inChildren) return inChildren;
  }
  return null;
}
