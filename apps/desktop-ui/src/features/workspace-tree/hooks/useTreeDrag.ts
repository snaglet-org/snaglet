import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '../../../utils/api';
import type { TableProjectLink } from '@desktop/features/database/useTableProjectLink';
import { showMoveConfirmation } from '@desktop/utils/moveConfirmation';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  isProjectNode,
  labelOfNode,
  placementParentOf,
  tablesGroupId,
  threadsGroupId,
} from '../treeUtils';
import { resolveDropTarget } from '../treeHelpers';
import { moveNode } from '../moveNode';
import { placeTable } from '../placeTable';
import { tableRowDropPlacement, tablesMovingTo } from '../tableRowDrag';
import { recordMove, type UndoMoveItem } from '../undo/workspaceUndo';
import type { DragPayload, DropZone } from '../types';

export interface UseTreeDragArgs {
  /** Id → node index over the loaded tree (descendant / no-op / project-rule checks). */
  nodeIndex: Map<string, LibraryTreeChild>;
  /** Visible-row order index — keeps multi-row drops in on-screen sequence. */
  visibleOrderIndex: Map<string, number>;
  /** Currently-expanded container and group ids — gates the move-confirmation banner. */
  expanded: Set<string>;
  /** Surfaces a move failure without disturbing the tree. */
  reportError: (message: string) => void;
  /** Bumps the tree refetch key after non-task moves. */
  setReloadKey: Dispatch<SetStateAction<number>>;
  /** The loaded table catalog (`null` before it loads) — resolves a dropped `table` chip. */
  tables: TableCatalogEntry[] | null;
  /** Id → entry for every table drawn in a Tables group — resolves dragged table rows. */
  tableIndex: Map<string, TableCatalogEntry>;
  /** The shared table→project link mutation; it reports its own refusals. */
  linkTable: TableProjectLink['setProject'];
}

const hasThreads = (sources: DragPayload[]): boolean => sources.some((s) => s.kind === 'thread');
const hasTables = (sources: DragPayload[]): boolean => sources.some((s) => s.kind === 'table');
/** Rows placed in a project's generated group, never inside a folder. */
const isScopedKind = (kind: DragPayload['kind']): boolean => kind === 'thread' || kind === 'table';

/**
 * Drag-and-drop for the workspace tree: the drag source channel, the hover
 * target and zone rows paint from, and the drop pipeline (cycle guard,
 * whole-batch no-op check, sequential moves in visible order).
 *
 * Threads land on a project, a Threads group header or beside another
 * thread; tables likewise with Tables groups. Any other target rejects the
 * whole batch. A `table` chip from outside the tree links to the project it
 * is dropped on (or unlinks, on the workspace Tables header).
 */
export function useTreeDrag({
  nodeIndex,
  visibleOrderIndex,
  expanded,
  reportError,
  setReloadKey,
  tables,
  tableIndex,
  linkTable,
}: UseTreeDragArgs) {
  const [hoverTargetId, setHoverTargetId] = useState<string | null>(null);
  const [hoverZone, setHoverZone] = useState<DropZone | null>(null);
  // An array of payloads (length 1 for a single row), sorted into visible
  // order before dispatch.
  const dragSourceRef = useRef<DragPayload[] | null>(null);

  const isDescendant = (sourceId: string, descId: string): boolean => {
    if (sourceId === descId) return true;
    const source = nodeIndex.get(sourceId);
    if (!source || source.kind !== 'container') return false;
    const stack: LibraryTreeChild[] = [...(source.children ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === descId) return true;
      if (n.kind === 'container') stack.push(...(n.children ?? []));
    }
    return false;
  };

  /** Clear the drag channel and hover affordance — every drop path starts here. */
  const takeSources = (): DragPayload[] | null => {
    const sources = dragSourceRef.current;
    dragSourceRef.current = null;
    setHoverTargetId(null);
    setHoverZone(null);
    return sources && sources.length > 0 ? sources : null;
  };

  /** Dragged rows in their current visible order, so a multi-row drop keeps
   *  the on-screen sequence rather than click order. */
  const inVisibleOrder = (sources: DragPayload[]): DragPayload[] =>
    [...sources].sort((a, b) => {
      const ai = visibleOrderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = visibleOrderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });

  /**
   * Whether the user can see where the rows just landed. Root-level folder
   * drops are always visible; a container must be expanded; a thread's
   * destination is a Threads group and a table's a Tables group, which must
   * be expanded along with the project that holds it.
   */
  const destinationVisible = (parentId: string | null, sources: DragPayload[]): boolean => {
    const containerOpen = parentId === null || expanded.has(parentId);
    if (hasThreads(sources) && !expanded.has(threadsGroupId(parentId))) return false;
    if (hasTables(sources) && !expanded.has(tablesGroupId(parentId))) return false;
    return containerOpen;
  };

  /** Display name of a dragged row: a tree node or a Tables group row. */
  const labelOfSource = (src: DragPayload): string => {
    const node = nodeIndex.get(src.id);
    if (node) return labelOfNode(node) || src.id;
    return tableIndex.get(src.id)?.name || src.label || src.id;
  };

  /**
   * Persist a bulk move: row i goes to `parentId` at `baseSortOrder + i`, or
   * to its kind's default place without a slot. Table moves are not undo steps.
   * Moves run one at a time, not with Promise.all: each `sort_order` write
   * bumps siblings on the server, and concurrent bumps race. A failure stops
   * the loop and keeps rows already moved (no rollback); one refetch at the end.
   */
  const performBulkMove = async (
    sources: DragPayload[],
    parentId: string | null,
    baseSortOrder: number | undefined
  ) => {
    // Inverse capture at commit time (undo contract): each row's parent +
    // slot before the first write, read from the same index the no-op
    // check used. Pushed only after every write lands, so a failed drop
    // never leaves a bogus undo entry.
    const slots = sources.map((_, i) =>
      baseSortOrder === undefined ? undefined : baseSortOrder + i
    );
    const captured: UndoMoveItem[] = [];
    let capturedAll = true;
    sources.forEach((src, i) => {
      if (src.kind === 'table') return;
      const node = nodeIndex.get(src.id);
      if (!node) {
        capturedAll = false;
        return;
      }
      captured.push({
        id: src.id,
        kind: node.kind,
        label: labelOfNode(node) || src.id,
        from: { parentId: placementParentOf(node), sortOrder: node.sortOrder },
        to: { parentId, sortOrder: slots[i] },
        node,
      });
    });
    try {
      for (let i = 0; i < sources.length; i++) {
        const { kind, id } = sources[i];
        if (kind === 'table') await placeTable(id, { projectId: parentId, sortOrder: slots[i] });
        else await moveNode(kind, id, parentId, slots[i]);
      }
      if (capturedAll && captured.length > 0) recordMove(captured);
      setReloadKey((v) => v + 1);
      // Confirmation banner when the destination wasn't visually verifiable
      // — dropping into a collapsed container or Threads group. Skip
      // same-parent reorders that already animate in-view.
      if (!destinationVisible(parentId, sources)) {
        const destinationNode = parentId === null ? null : nodeIndex.get(parentId);
        if (parentId !== null && !destinationNode) return;
        const destinationLabel = destinationNode
          ? labelOfNode(destinationNode) || 'destination'
          : 'Workspace';
        const sourceLabel =
          sources.length === 1 ? labelOfSource(sources[0]) : `${sources.length} items`;
        const destinationDetail = sources.every((s) => s.kind === 'table')
          ? 'Tables'
          : hasThreads(sources)
            ? 'Threads'
            : undefined;
        showMoveConfirmation({
          sourceLabel,
          destinationLabel,
          destinationDetail,
          sourceKind: sources.length === 1 ? sources[0].kind : 'multi',
          destinationId: parentId,
        });
      }
    } catch (err) {
      reportError(`Move failed: ${getErrorMessage(err)}`);
      setReloadKey((v) => v + 1);
    }
  };

  const handleDrop = (target: LibraryTreeChild | null, zone: DropZone) => {
    const sources = takeSources();
    if (!sources) return;

    // Drop on a row that's in the dragged set is a no-op (can't drop
    // onto yourself or move-to-self-as-sibling). Bail before we
    // resolve the target.
    if (target && sources.some((s) => s.id === target.id)) return;

    // Containers can't be moved into their own descendants. If any
    // dragged container would cycle, abort the whole batch (don't
    // partial-apply — clearer failure mode).
    if (target) {
      for (const s of sources) {
        if (s.kind === 'container' && isDescendant(s.id, target.id)) return;
      }
    }

    // Beside a thread, only threads land (they join its list at that slot).
    // Otherwise a thread or table only lands inside a project container
    // (rows reject every other hover; this is the same rule for the drop
    // itself). The whole batch is rejected, like the cycle guard above.
    if (target?.kind === 'thread') {
      if (zone === 'inside' || !sources.every((s) => s.kind === 'thread')) return;
    } else if (
      sources.some((s) => isScopedKind(s.kind)) &&
      !(isProjectNode(target) && zone === 'inside')
    ) {
      return;
    }

    // Projects nest freely, so there is no project guard here. (The DB
    // enforces one project marker per container with a partial unique index,
    // which a move never hits.)

    const resolved = resolveDropTarget(target, zone);
    if (!resolved) return;
    const { parentId, sortOrder } = resolved;

    // Dropped into a project without a slot, a thread already scoped to it
    // or a table already linked to it has nothing to
    // move, so it leaves a mixed batch here instead of becoming a no-op write
    // and a bogus undo item.
    const ordered = inVisibleOrder(sources).filter((src) => {
      if (sortOrder !== undefined) return true;
      if (src.kind === 'table') return tableIndex.get(src.id)?.projectId !== parentId;
      const node = nodeIndex.get(src.id);
      return !(node?.kind === 'thread' && node.projectId === parentId);
    });
    if (ordered.length === 0) return;

    // No-op detection for the *whole batch*: if every dragged row is
    // already in the right parent and the request has no positional
    // intent (or the slot would land it back where it is), the move
    // does nothing. A multi-row drag goes through if any row would move.
    const allNoOps = ordered.every((src) => {
      const node = nodeIndex.get(src.id);
      if (!node) return false;
      if (placementParentOf(node) !== parentId) return false;
      if (sortOrder === undefined) return true; // same parent, no positional intent
      return node.sortOrder === sortOrder;
    });
    if (allNoOps) return;

    void performBulkMove(ordered, parentId, sortOrder);
  };

  /**
   * Drop on a Threads group header: scope every dragged thread to
   * `projectId` (`null` = the workspace-level group, i.e. make it flat).
   * Only an all-thread batch is accepted — the header rejects the hover
   * otherwise — and rows already in that scope are left alone.
   */
  const handleThreadScopeDrop = (projectId: string | null) => {
    const sources = takeSources();
    if (!sources || !sources.every((s) => s.kind === 'thread')) return;
    const moving = sources.filter((s) => {
      const node = nodeIndex.get(s.id);
      return node?.kind === 'thread' && node.projectId !== projectId;
    });
    if (moving.length === 0) return;
    void performBulkMove(inVisibleOrder(moving), projectId, undefined);
  };

  /**
   * Drop on a Tables group header from the tree: move every dragged table
   * row into that scope (`null` = the workspace-level group, i.e. unlink
   * it), at the bottom of its list. Only an all-table batch is accepted — the
   * header rejects the hover otherwise — and tables already there are left
   * alone.
   */
  const handleTableScopeDrop = (projectId: string | null) => {
    const sources = takeSources();
    if (!sources) return;
    const moving = tablesMovingTo(sources, projectId, tableIndex);
    if (moving.length === 0) return;
    void performBulkMove(inVisibleOrder(moving), projectId, undefined);
  };

  /**
   * Drop dragged table rows above or below a table row: they join that
   * table's scope at its slot (the target's for `above`, the next for
   * `below`), keeping their on-screen order. A single table dropped right
   * beside itself would not move, so it makes no request.
   */
  const handleTableRowDrop = (target: TableCatalogEntry, zone: 'above' | 'below') => {
    const sources = takeSources();
    const placement = sources && tableRowDropPlacement(sources, target, zone, tableIndex);
    if (!sources || !placement) return;
    void performBulkMove(inVisibleOrder(sources), placement.projectId, placement.sortOrder);
  };

  /**
   * Drop a `table` chip on a project row or a Tables group header: link the
   * table to that project (`null` = the workspace-level group, i.e. unlink
   * it). A table already in that scope makes no request. Not an undo step.
   * The shared link mutation announces the change and reports refusals; only
   * a chip that cannot be resolved is reported here.
   */
  const handleTableDrop = (tableId: string, projectId: string | null) => {
    setHoverTargetId(null);
    setHoverZone(null);
    const table = tables?.find((entry) => entry.id === tableId);
    if (!table) {
      reportError('Failed to move table: it is not in the loaded table catalog');
      return;
    }
    if (table.origin !== 'custom') {
      reportError('Failed to move table: built-in tables are workspace-wide');
      return;
    }
    if (table.projectId === projectId) return;
    void linkTable(table, projectId);
  };

  return {
    dragSourceRef,
    hoverTargetId,
    hoverZone,
    setHoverTargetId,
    setHoverZone,
    isDescendant,
    handleDrop,
    handleThreadScopeDrop,
    handleTableScopeDrop,
    handleTableRowDrop,
    handleTableDrop,
  };
}
