import type { DragEvent as ReactDragEvent, MutableRefObject } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { DetailSelection } from '@desktop/pages/Dashboard/selection/types';
import { clearChipDragPayload, setChipDragPayload } from '@desktop/utils/nodeChip';
import { applyTableRowDragData, dropZoneForPointer, showMultiDragGhost } from './treeRowDnd';
import type { DragPayload, DropZone } from './types';

/**
 * The drag state a tree shares between its table rows: the rows in flight
 * and the row (or group) the pointer is over, with the zone it would land in.
 */
interface TableRowDragChannel {
  dragSourceRef: MutableRefObject<DragPayload[] | null>;
  hoverTargetId: string | null;
  hoverZone: DropZone | null;
  setHoverTargetId: (id: string | null) => void;
  setHoverZone: (zone: DropZone | null) => void;
}

interface TableRowDragOptions extends TableRowDragChannel {
  table: TableCatalogEntry;
  /** What a drag from this row carries: the selection when it holds this row, else the row. */
  payloads: () => DragPayload[];
  /** Table rows dropped above or below this row. Without it the row takes no drops. */
  onRowDrop?: (table: TableCatalogEntry, zone: 'above' | 'below') => void;
}

/** A drag of table rows only, none of them `target` — what lands beside a table row. */
function landsBeside(sources: DragPayload[] | null, target: TableCatalogEntry): boolean {
  if (!sources || sources.length === 0) return false;
  return sources.every((s) => s.kind === 'table') && !sources.some((s) => s.id === target.id);
}

/**
 * The drag handlers of one table row in a sidebar tree — the workspace
 * tree's Tables groups and the Database sidebar both use them. The row drags
 * as its `table` chip (chat and pane drops keep working) and, on top, as tree
 * rows carrying every selected row, so the tree reorders or moves them and
 * the sidebar trash archives them. With `onRowDrop`, dragged table rows land
 * above or below the row, with the insertion line on `hoverZone`.
 */
export function tableRowDragProps({
  table,
  payloads,
  onRowDrop,
  dragSourceRef,
  hoverTargetId,
  hoverZone,
  setHoverTargetId,
  setHoverZone,
}: TableRowDragOptions) {
  const paneSelection: DetailSelection = { kind: 'table', table_id: table.id, table };
  const drops = onRowDrop
    ? {
        onDragOver: (e: ReactDragEvent<HTMLElement>) => {
          if (!landsBeside(dragSourceRef.current, table)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const zone = dropZoneForPointer(e, false);
          if (hoverTargetId !== table.id) setHoverTargetId(table.id);
          if (hoverZone !== zone) setHoverZone(zone);
        },
        onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
          if (hoverTargetId !== table.id) return;
          const related = e.relatedTarget as HTMLElement | null;
          if (!related || !e.currentTarget.contains(related)) {
            setHoverTargetId(null);
            setHoverZone(null);
          }
        },
        onDrop: (e: ReactDragEvent<HTMLElement>) => {
          // A drag this row refused (it holds the row) falls through to
          // whatever around it took the hover.
          if (!landsBeside(dragSourceRef.current, table)) return;
          e.preventDefault();
          e.stopPropagation();
          // Read the half from the drop itself: the last dragover's zone may
          // not have rendered yet when the drop lands.
          onRowDrop(table, dropZoneForPointer(e, false) === 'above' ? 'above' : 'below');
        },
      }
    : {};
  return {
    draggable: true,
    onDragStart: (e: ReactDragEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest('button, input, textarea, select')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      setChipDragPayload(e, {
        chip: { id: table.id, kind: 'table', title: table.name },
        dragLabel: table.name,
        paneSelection,
      });
      const carried = payloads();
      dragSourceRef.current = carried;
      applyTableRowDragData(e, carried);
      if (carried.length > 1) showMultiDragGhost(e, carried.length);
    },
    onDragEnd: () => {
      dragSourceRef.current = null;
      setHoverTargetId(null);
      setHoverZone(null);
      clearChipDragPayload();
      document.body.removeAttribute('data-dragging');
    },
    ...drops,
  };
}

/**
 * Where table rows dropped beside `target` land: in its project, at its slot
 * (`above`) or the next one (`below`). `null` when the drag is not all
 * tables, holds the target, or is one table dropped right beside itself,
 * which would not move.
 */
export function tableRowDropPlacement(
  sources: readonly DragPayload[],
  target: TableCatalogEntry,
  zone: 'above' | 'below',
  tableIndex: ReadonlyMap<string, TableCatalogEntry>
): { projectId: string | null; sortOrder: number } | null {
  if (sources.length === 0 || !sources.every((s) => s.kind === 'table')) return null;
  if (sources.some((s) => s.id === target.id)) return null;
  const slot = zone === 'above' ? target.sortOrder : target.sortOrder + 1;
  if (sources.length === 1) {
    const table = tableIndex.get(sources[0].id);
    if (
      table?.projectId === target.projectId &&
      (table.sortOrder === slot || table.sortOrder + 1 === slot)
    ) {
      return null;
    }
  }
  return { projectId: target.projectId, sortOrder: slot };
}

/**
 * The dragged table rows a drop on the `projectId` scope moves (`null` = the
 * workspace-wide list): those not there already. None unless every dragged
 * row is a table.
 */
export function tablesMovingTo(
  sources: readonly DragPayload[],
  projectId: string | null,
  tableIndex: ReadonlyMap<string, TableCatalogEntry>
): DragPayload[] {
  if (!sources.every((s) => s.kind === 'table')) return [];
  return sources.filter((s) => tableIndex.get(s.id)?.projectId !== projectId);
}
