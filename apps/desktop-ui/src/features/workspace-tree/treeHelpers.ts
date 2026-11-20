import type { ChipTone } from '@desktop/components';
import type { PaletteNodeKind } from '@desktop/utils/api';
import type { LibraryTreeChild } from '../../utils/api';
import type { DropZone } from './types';

/** Workspace-tree filter-chip tone per node kind, through <Chip>'s tone API. */
export const KIND_TO_TONE: Record<PaletteNodeKind, ChipTone> = {
  container: 'primary',
  doc: 'primary',
  thread: 'primary',
  message: 'primary',
  thread_summary: 'primary',
  image: 'primary',
  memory: 'error',
  agent: 'success',
  tool: 'muted',
  table: 'primary',
};

export function fileExtension(name: string): string {
  // dot > 0 (not >= 0) matches Node's path.extname on the server:
  // a dotfile like ".md" has no extension and is not importable.
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * Translate a hovered (target row, drop zone) pair into the wire-level
 * "where does this go" question: target parent id + optional sort_order.
 *
 *  - `inside` (containers only): no positional intent — append to the
 *    container's bucket. `sortOrder` left undefined; the API call omits
 *    the field, which on the server side means "just re-parent."
 *  - `above` / `below`: source lands adjacent to the target in the same
 *    parent. `sortOrder` is the target's slot for `above`, target+1 for
 *    `below`. The server then bumps siblings to make room.
 *
 *  - a thread target (`above` / `below` only): the source joins that
 *    thread's list — its project, or flat — at the same slots. Threads are
 *    not in the folder tree, so the parent is the thread's project.
 *
 * Returns `undefined` for invalid targets (`inside` a thread). The caller
 * treats that as "drop is a no-op."
 */
export function resolveDropTarget(
  target: LibraryTreeChild | null,
  zone: DropZone
): { parentId: string | null; sortOrder: number | undefined } | undefined {
  if (target === null) return { parentId: null, sortOrder: undefined };
  if (target.kind === 'thread') {
    if (zone === 'inside') return undefined;
    return {
      parentId: target.projectId,
      sortOrder: zone === 'above' ? target.sortOrder : target.sortOrder + 1,
    };
  }
  if (target.kind === 'container') {
    // Project-home containers accept drops like any other container — the
    // project is just a badge on the container, not a separate space.
    if (zone === 'inside') return { parentId: target.id, sortOrder: undefined };
    return {
      parentId: target.parentId,
      sortOrder: zone === 'above' ? target.sortOrder : target.sortOrder + 1,
    };
  }
  // doc / image targets have only above/below (no "inside")
  return {
    parentId: target.containerId,
    sortOrder: zone === 'above' ? target.sortOrder : target.sortOrder + 1,
  };
}
