import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { CopyToClipboardButton } from '@desktop/components';
import { TableIcon } from '@desktop/components/Icons';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { nodeToChipMarkdown, readChipDragData } from '@desktop/utils/nodeChip';
import { DraftRow } from './DraftRow';
import { tableRowDragProps } from './tableRowDrag';
import { TreeGroupHeader } from './TreeGroupHeader';
import type { TreeRowSharedProps } from './TreeRow';
import { buildDragPayloads, payloadOfTable } from './treeRowDnd';
import { guideStyle, rowIndent, tablesGroupId } from './treeUtils';
import styles from './WorkspaceTree.module.scss';

interface TablesGroupProps {
  /** Owning project, or `null` for the workspace-level group of unlinked tables. */
  projectId: string | null;
  /** Catalog tables in this scope, in their manual order, or `null` while the catalog loads. */
  tables: TableCatalogEntry[] | null;
  /** Indent level of the group header; table rows sit one level deeper. 0 = workspace level. */
  headerDepth: number;
  /** The tree-wide row props: expansion, selection and the drag/drop channel. */
  rowProps: Pick<
    TreeRowSharedProps,
    | 'expanded'
    | 'onToggle'
    | 'clickTable'
    | 'selectedIds'
    | 'activeTableId'
    | 'nodeIndex'
    | 'tableIndex'
    | 'visibleOrderIndex'
    | 'dragSourceRef'
    | 'hoverTargetId'
    | 'hoverZone'
    | 'setHoverTargetId'
    | 'setHoverZone'
    | 'handleTableDrop'
    | 'handleTableScopeDrop'
    | 'handleTableRowDrop'
    | 'creator'
    | 'draftInputRef'
    | 'commitCreator'
    | 'cancelCreator'
    | 'startScopedDraft'
  >;
}

/**
 * Generated "Tables" group: the Database catalog tables linked to a project
 * (`TableCatalogEntry.projectId`), drawn after the project's Threads group,
 * or — at the root — the user's own tables that belong to no project.
 * Tables are not workspace nodes, but their rows behave like tree rows: a
 * plain click selects the row and opens the table pane, cmd/ctrl-click and
 * shift-click extend the tree's multi-selection, and a drag carries every
 * selected row. Rows keep a manual order: dropping table rows above or
 * below a row places them there (in that row's scope); dropping them on a
 * project row or a group header moves them to the bottom of that scope, so
 * the workspace header is where a table is unlinked; dropping them on the
 * sidebar trash archives them (one step, with an Undo). Each row also drags
 * as the same `table` chip the Database sidebar emits, for chat and pane
 * drops (the shared `tableRowDragProps`), and this header still takes a
 * dropped `table` chip. Expansion rides the shared `expanded` set under the
 * group's own key so reveal can open it and it survives reloads. The
 * header's `+` opens a new table draft in the group's scope.
 */
export function TablesGroup({ projectId, tables, headerDepth, rowProps }: TablesGroupProps) {
  const {
    expanded,
    onToggle,
    clickTable,
    selectedIds,
    activeTableId,
    nodeIndex,
    tableIndex,
    visibleOrderIndex,
    dragSourceRef,
    hoverTargetId,
    hoverZone,
    setHoverTargetId,
    setHoverZone,
    handleTableDrop,
    handleTableScopeDrop,
    handleTableRowDrop,
    creator,
    draftInputRef,
    commitCreator,
    cancelCreator,
    startScopedDraft,
  } = rowProps;
  const nav = useDashboardNavigation();
  const groupId = tablesGroupId(projectId);
  const open = expanded.has(groupId);
  const nested = headerDepth > 0;
  const rowDepth = headerDepth + 1;

  // The inline name row for a new table in this scope, drawn as the group's
  // first row. Opening it expands the group, so `open` is already true.
  const drafting =
    open &&
    creator?.stage === 'editing' &&
    creator.kind === 'table' &&
    creator.parentContainerId === projectId;
  const draftRow = drafting ? (
    <DraftRow
      depth={rowDepth}
      kind="table"
      inputRef={draftInputRef}
      onCommit={commitCreator}
      onCancel={cancelCreator}
    />
  ) : null;

  /**
   * The dragged `table` chip when this header can take it: a chip drag from
   * outside the tree (no tree rows in flight) of a table not already in
   * this scope. Tree drags go through `acceptsTreeDrag` instead.
   */
  const acceptedTable = (dt: DataTransfer) => {
    if (dragSourceRef.current) return null;
    const chip = readChipDragData(dt);
    if (chip?.kind !== 'table') return null;
    return tables?.some((t) => t.id === chip.id) ? null : chip;
  };
  /** A tree drag of table rows only, at least one of them from another scope. */
  const acceptsTreeDrag = (): boolean => {
    const sources = dragSourceRef.current;
    if (!sources || sources.length === 0) return false;
    if (!sources.every((s) => s.kind === 'table')) return false;
    return sources.some((s) => tableIndex.get(s.id)?.projectId !== projectId);
  };
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!acceptsTreeDrag() && !acceptedTable(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (hoverTargetId !== groupId) setHoverTargetId(groupId);
    setHoverZone('inside');
  };
  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (hoverTargetId !== groupId) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !e.currentTarget.contains(related)) {
      setHoverTargetId(null);
      setHoverZone(null);
    }
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (dragSourceRef.current) {
      // Tree rows other than tables (folders, docs, threads) have no place in
      // a Tables group: the drop is swallowed so it does not bubble to the
      // tree's detach-to-root gesture, the same way a Threads group header
      // keeps a rejected drop.
      e.preventDefault();
      e.stopPropagation();
      handleTableScopeDrop(projectId);
      return;
    }
    const table = acceptedTable(e.dataTransfer);
    if (!table) return;
    e.preventDefault();
    e.stopPropagation();
    handleTableDrop(table.id, projectId);
  };

  // One focusable tree item per table, like a TreeRow: Enter or Space opens
  // the pane, the copy action inside keeps its own keys.
  const renderTable = (table: TableCatalogEntry) => {
    const openPane = () => nav?.openTable?.(table.id);
    const selected = selectedIds.has(table.id);
    const activeZone = hoverTargetId === table.id ? hoverZone : null;
    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (clickTable(table, e)) openPane();
      }
    };
    return (
      <div
        key={table.id}
        className={[
          styles.row,
          selected ? styles.rowSelected : '',
          // The table the active pane shows, like a node row's active highlight.
          activeTableId === table.id ? styles.rowActive : '',
          activeZone === 'above' ? styles.rowDropAbove : '',
          activeZone === 'below' ? styles.rowDropBelow : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: rowIndent(rowDepth) }}
        role="treeitem"
        aria-label={table.name}
        aria-level={rowDepth + 1}
        aria-selected={selected}
        tabIndex={0}
        data-table-id={table.id}
        onClick={(e) => {
          e.stopPropagation();
          if (clickTable(table, e)) openPane();
        }}
        onKeyDown={onKeyDown}
        {...tableRowDragProps({
          table,
          payloads: () =>
            buildDragPayloads(
              payloadOfTable(table),
              selectedIds,
              nodeIndex,
              tableIndex,
              visibleOrderIndex
            ),
          onRowDrop: handleTableRowDrop,
          dragSourceRef,
          hoverTargetId,
          hoverZone,
          setHoverTargetId,
          setHoverZone,
        })}
      >
        <span className={[styles.chevron, styles.chevronEmpty].join(' ')} aria-hidden />
        <span className={styles.icon} aria-hidden>
          <TableIcon />
        </span>
        <span className={styles.label} title={table.name}>
          {table.name}
        </span>
        <div className={styles.rowActions}>
          <CopyToClipboardButton
            value={nodeToChipMarkdown({ id: table.id, kind: 'table', title: table.name })}
            className={styles.copyLinkBtn}
            stopPropagation
            idleTitle="Copy link"
            copiedTitle="Link copied!"
            aria-label={`Copy link to ${table.name}`}
          />
        </div>
      </div>
    );
  };

  // The header `+` opens the inline name row at the top of this group, in
  // its scope (the project, or workspace-wide for the root group).
  const onAdd = startScopedDraft ? () => startScopedDraft('table', projectId) : undefined;

  const header = (
    <TreeGroupHeader
      label="Tables"
      count={tables?.length}
      open={open}
      onToggle={() => onToggle(groupId)}
      depth={headerDepth}
      groupId={groupId}
      dropActive={hoverTargetId === groupId}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onAdd={onAdd}
      addLabel="New table"
    />
  );

  const body = open ? (
    tables === null ? (
      <div className={styles.taskHint} style={{ paddingLeft: rowIndent(rowDepth) }}>
        Loading tables…
      </div>
    ) : (
      <>
        {draftRow}
        {tables.length === 0 ? (
          drafting ? null : (
            <div className={styles.taskHint} style={{ paddingLeft: rowIndent(rowDepth) }}>
              {projectId === null ? 'No unlinked tables' : 'No linked tables'}
            </div>
          )
        ) : (
          tables.map(renderTable)
        )}
      </>
    )
  ) : null;

  // Under a project the whole group hangs off the project's guide line, like
  // the Files group. At the root there is no parent guide; the rows get their
  // own, anchored at this header's chevron, like the workspace Threads group.
  if (nested) {
    return (
      <div role="group" className={styles.indentGuide} style={guideStyle(headerDepth - 1)}>
        {header}
        {body}
      </div>
    );
  }
  return (
    <div role="group">
      {header}
      {body && (
        <div role="group" className={styles.indentGuide} style={guideStyle(headerDepth)}>
          {body}
        </div>
      )}
    </div>
  );
}
