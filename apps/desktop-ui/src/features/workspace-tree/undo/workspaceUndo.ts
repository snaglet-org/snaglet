/**
 * Workspace structural undo/redo: the one history behind Cmd/Ctrl+Z for tree
 * moves and node creation, shared by the sidebar tree and ContainerView panes.
 *
 *  - The surface that fires a mutation captures its inverse (prior parent and
 *    sort_order) at commit time, so undo is exact even after other changes.
 *  - Undo of a create archives the node; redo restores it in place.
 *  - Replay uses `moveNode`: emit `node-moved`, write, then reconcile on
 *    `tree-invalidated` (which also rolls back a rejected write).
 *  - Stacks hold 100 steps; a new action clears redo. A busy flag serializes
 *    replays so a held-down shortcut can't interleave writes.
 *  - The history lives in this window's memory; a reload starts empty.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { archiveApi, containersApi, type LibraryTreeChild } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { showToast } from '@desktop/utils/toast';
import { moveNode, type MovableNodeKind } from '../moveNode';

interface Placement {
  parentId: string | null;
  /** undefined = no positional intent (append to the parent's bucket). */
  sortOrder?: number;
}

export interface UndoMoveItem {
  id: string;
  kind: MovableNodeKind;
  /** Human-readable name, for failure toasts. */
  label: string;
  /**
   * Placement before the user's action — the exact inverse target. For a
   * thread `parentId` is its project (null = flat) and `sortOrder` its slot
   * in that project's list.
   */
  from: { parentId: string | null; sortOrder: number };
  /** Placement the user's action requested — the redo target. */
  to: Placement;
  /** Snapshot for optimistic re-insertion into trees that lost the node. */
  node?: LibraryTreeChild;
}

export interface UndoCreateEntry {
  id: string;
  kind: 'container' | 'doc';
  label: string;
  parentId: string | null;
}

type WorkspaceUndoAction =
  | { type: 'move'; items: UndoMoveItem[] }
  | ({ type: 'create' } & UndoCreateEntry);

const MAX_STACK = 100;

let undoStack: WorkspaceUndoAction[] = [];
let redoStack: WorkspaceUndoAction[] = [];
let busy = false;

function pushBounded(stack: WorkspaceUndoAction[], action: WorkspaceUndoAction): void {
  stack.push(action);
  if (stack.length > MAX_STACK) stack.shift();
}

/** Record a committed move (one drop = one action, no coalescing). */
export function recordMove(items: UndoMoveItem[]): void {
  if (items.length === 0) return;
  pushBounded(undoStack, { type: 'move', items });
  redoStack = [];
}

/** Record a committed doc/container creation. */
export function recordCreate(entry: UndoCreateEntry): void {
  pushBounded(undoStack, { type: 'create', ...entry });
  redoStack = [];
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/**
 * Destination containers must be checked before the write: the server's
 * moveTo doesn't validate the target parent, so replaying a move into an
 * archived/deleted container would strand the node instead of failing. A
 * thread's destination is its project container, probed the same way.
 */
async function isContainerAlive(id: string): Promise<boolean> {
  try {
    // ContainerRecord doesn't surface `archived`, but the server row
    // carries it — narrow locally instead of widening the shared type
    // for this one probe.
    const row = (await containersApi.get(id)) as { archived?: boolean };
    return row.archived !== true;
  } catch {
    return false;
  }
}

type Direction = 'undo' | 'redo';

async function replayMove(
  action: { items: UndoMoveItem[] },
  direction: Direction
): Promise<boolean> {
  const placementOf = (item: UndoMoveItem): Placement => {
    if (direction === 'redo') return item.to;
    // Same-parent up-move correction: the original write bumped the node's
    // former neighbors (old predecessor included) by +1, so its captured
    // slot now sits before that predecessor. Re-inserting at slot+1 lands
    // it exactly where it was. Down-moves and cross-parent moves leave the
    // old neighborhood's slots intact, so the raw captured slot is exact.
    const sameParent = item.to.parentId === item.from.parentId;
    const movedUp = item.to.sortOrder !== undefined && item.to.sortOrder <= item.from.sortOrder;
    return sameParent && movedUp
      ? { parentId: item.from.parentId, sortOrder: item.from.sortOrder + 1 }
      : item.from;
  };
  // Ascending target slots so multi-item replays land without displacing
  // each other (server bumps siblings at/after each written slot). Stable
  // sort keeps original order for append-only (undefined-slot) items.
  const items = [...action.items].sort(
    (a, b) =>
      (placementOf(a).sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (placementOf(b).sortOrder ?? Number.MAX_SAFE_INTEGER)
  );
  const ids = items.map((i) => i.id);

  // Optimistic apply — the tree/panes patch immediately; every later exit
  // path emits tree-invalidated, which reconciles or rolls this back.
  for (const item of items) {
    const p = placementOf(item);
    emitLibraryEvent({
      type: 'node-moved',
      kind: item.kind,
      id: item.id,
      parentId: p.parentId,
      sortOrder: p.sortOrder,
      node: item.node,
    });
  }

  const parentIds = [
    ...new Set(items.map((i) => placementOf(i).parentId).filter((p): p is string => p !== null)),
  ];
  // Threads move between projects, everything else between containers — name
  // the destination the way the user sees it.
  const place = items.every((i) => i.kind === 'thread') ? 'project' : 'container';
  for (const parentId of parentIds) {
    if (!(await isContainerAlive(parentId))) {
      emitLibraryEvent({ type: 'tree-invalidated', ids });
      showToast(
        direction === 'undo'
          ? `Couldn't undo — the ${place} it was in is gone`
          : `Couldn't redo — the destination ${place} is gone`
      );
      return false;
    }
  }

  try {
    for (const item of items) {
      const p = placementOf(item);
      await moveNode(item.kind, item.id, p.parentId, p.sortOrder);
    }
    emitLibraryEvent({ type: 'tree-invalidated', ids });
    return true;
  } catch (err) {
    emitLibraryEvent({ type: 'tree-invalidated', ids });
    showToast(`Couldn't ${direction} — ${getErrorMessage(err, 'move failed')}`);
    return false;
  }
}

async function archiveCreatedNode(action: UndoCreateEntry): Promise<boolean> {
  // Optimistic prune — instant removal. The reload is deferred until the
  // server confirms; an immediate reload would refetch pre-archive state
  // and flash the node back.
  emitLibraryEvent({ type: 'archive-changed', ids: [action.id] });
  try {
    await archiveApi.archive(action.id);
    if (action.kind === 'container') {
      // Containers cascade to children server-side; only a post-confirm
      // refetch sees the cascade's full extent.
      emitLibraryEvent({ type: 'archive-changed', ids: [action.id], reload: true });
    }
    return true;
  } catch (err) {
    emitLibraryEvent({ type: 'tree-invalidated', ids: [action.id] });
    showToast(`Couldn't undo — ${getErrorMessage(err, 'archive failed')}`);
    return false;
  }
}

async function restoreCreatedNode(action: UndoCreateEntry): Promise<boolean> {
  // A restore keeps the row's container_id — restoring into an archived
  // parent would make the node invisible, so fail cleanly instead.
  if (action.parentId !== null && !(await isContainerAlive(action.parentId))) {
    showToast(`Couldn't redo — the container "${action.label}" was created in is gone`);
    return false;
  }
  try {
    await archiveApi.restore(action.id);
    // The node isn't in any local cache; a reload is the only
    // way to bring it back (see the archive-changed contract).
    emitLibraryEvent({ type: 'archive-changed', ids: [action.id], reload: true });
    return true;
  } catch (err) {
    showToast(`Couldn't redo — ${getErrorMessage(err, 'restore failed')}`);
    return false;
  }
}

/** Undo the most recent structural action. No-op while a replay is in flight. */
export async function undoLast(): Promise<void> {
  if (busy) return;
  const action = undoStack.pop();
  if (!action) return;
  busy = true;
  try {
    const ok =
      action.type === 'move' ? await replayMove(action, 'undo') : await archiveCreatedNode(action);
    // A failed undo drops the entry — retrying an inverse that just failed
    // would loop the same error at the user.
    if (ok) pushBounded(redoStack, action);
  } finally {
    busy = false;
  }
}

/** Redo the action most recently undone. No-op while a replay is in flight. */
export async function redoLast(): Promise<void> {
  if (busy) return;
  const action = redoStack.pop();
  if (!action) return;
  busy = true;
  try {
    const ok =
      action.type === 'move' ? await replayMove(action, 'redo') : await restoreCreatedNode(action);
    // Redo re-arms undo directly — it is not a fresh action, so the rest
    // of the redo stack survives.
    if (ok) pushBounded(undoStack, action);
  } finally {
    busy = false;
  }
}

/** Test-only: reset stacks + busy flag between cases. */
export function __resetWorkspaceUndoForTests(): void {
  undoStack = [];
  redoStack = [];
  busy = false;
}

/** Test-only: observe stack depths without replaying. */
export function __workspaceUndoDepthsForTests(): { undo: number; redo: number } {
  return { undo: undoStack.length, redo: redoStack.length };
}
