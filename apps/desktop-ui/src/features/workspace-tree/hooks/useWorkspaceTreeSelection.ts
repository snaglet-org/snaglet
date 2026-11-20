import { useMemo } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '@desktop/utils/api';
import {
  ROOT_ITEMS_GROUP_ID,
  partitionRootNodes,
  partitionThreads,
  tablesGroupId,
  threadsGroupId,
} from '../treeUtils';
import { useRowSelection, type RowSelectionEvent } from './useRowSelection';

export type WorkspaceTreeSelectionEvent = RowSelectionEvent;

interface UseWorkspaceTreeSelectionArgs {
  roots: LibraryTreeChild[] | null;
  expanded: Set<string>;
  /** Each project's Tables group rows, in drawn order (`null` while the catalog loads). */
  tablesByProject: Map<string, TableCatalogEntry[]> | null;
  /** The workspace Tables group rows (unlinked tables), in drawn order. */
  workspaceTables: TableCatalogEntry[] | null;
  onNodeClick?: (node: LibraryTreeChild) => void;
}

export function useWorkspaceTreeSelection({
  roots,
  expanded,
  tablesByProject,
  workspaceTables,
  onNodeClick,
}: UseWorkspaceTreeSelectionArgs) {
  // On-screen row order, mirroring what the tree draws. At the root: the
  // top-level projects, then the workspace Docs & context group (recursing
  // into expanded containers), then the workspace Threads and Tables
  // groups. Inside an expanded project: its Threads and Tables groups
  // first, then its folders and docs. A group's rows count only while that
  // group is expanded. Table ids share the order with node ids.
  const visibleOrder = useMemo(() => {
    const order: string[] = [];
    const pushGroups = (threadIds: string[], scopeId: string | null) => {
      if (threadIds.length > 0 && expanded.has(threadsGroupId(scopeId))) order.push(...threadIds);
      const tables = scopeId === null ? workspaceTables : tablesByProject?.get(scopeId);
      if (tables && tables.length > 0 && expanded.has(tablesGroupId(scopeId))) {
        for (const table of tables) order.push(table.id);
      }
    };
    const pushRow = (n: LibraryTreeChild) => {
      order.push(n.id);
      if (n.kind === 'container' && expanded.has(n.id)) {
        walk(n.children, n.category === 'project' ? n.id : null);
      }
    };
    const walk = (nodes: LibraryTreeChild[] | undefined, scopeId: string | null) => {
      const { threads, others } = partitionThreads(nodes ?? []);
      if (scopeId !== null)
        pushGroups(
          threads.map((n) => n.id),
          scopeId
        );
      for (const n of others) pushRow(n);
    };
    const { threads: flatThreads, others: rootRows } = partitionThreads(roots ?? []);
    const { projects, items } = partitionRootNodes(rootRows);
    for (const n of projects) pushRow(n);
    if (expanded.has(ROOT_ITEMS_GROUP_ID)) for (const n of items) pushRow(n);
    pushGroups(
      flatThreads.map((n) => n.id),
      null
    );
    return order;
  }, [roots, expanded, tablesByProject, workspaceTables]);

  const {
    selectedIds,
    setSelectedIds,
    selectionAnchorId,
    setSelectionAnchorId,
    visibleOrderIndex,
    selectRow,
  } = useRowSelection(visibleOrder);

  const clickRow = (node: LibraryTreeChild, e: WorkspaceTreeSelectionEvent) => {
    if (selectRow(node.id, e)) onNodeClick?.(node);
  };

  /** Same gestures for a Tables group row; true means a plain click (open the table). */
  const clickTable = (table: TableCatalogEntry, e: WorkspaceTreeSelectionEvent): boolean =>
    selectRow(table.id, e);

  return {
    selectedIds,
    setSelectedIds,
    selectionAnchorId,
    setSelectionAnchorId,
    visibleOrderIndex,
    clickRow,
    clickTable,
  };
}
