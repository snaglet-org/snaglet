import {
  containersApi,
  docsApi,
  imagesApi,
  threadsApi,
  type LibraryTreeChild,
} from '@desktop/utils/api';

export type MovableNodeKind = LibraryTreeChild['kind'];

/**
 * The single client-side move mutation. Wraps the per-kind API differences
 * (containers PATCH `parentId`, docs PATCH `containerId`, images have a
 * dedicated move endpoint, threads attach to a project) so every mover —
 * tree drag-and-drop, ContainerView drops, and undo/redo replay — goes
 * through one path and inherits the same server-side semantics.
 *
 * `sortOrder` set = positional intent (server bumps siblings at the slot);
 * omitted = pure re-parent (server appends at MAX+1).
 *
 * A thread is not in the folder tree: `parentId` is the project container
 * it belongs to (`null` = flat at the workspace level) and `sortOrder` is
 * its slot in that list; without one the server puts it at the top.
 */
export async function moveNode(
  kind: MovableNodeKind,
  id: string,
  parentId: string | null,
  sortOrder?: number
): Promise<void> {
  if (kind === 'container') {
    await containersApi.update(id, {
      parentId,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    });
  } else if (kind === 'doc') {
    await docsApi.update(id, {
      containerId: parentId,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    });
  } else if (kind === 'thread') {
    await threadsApi.setPlacement(id, {
      projectId: parentId,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    });
  } else if (kind === 'image') {
    await imagesApi.move(id, parentId, sortOrder !== undefined ? { sortOrder } : undefined);
  }
}
