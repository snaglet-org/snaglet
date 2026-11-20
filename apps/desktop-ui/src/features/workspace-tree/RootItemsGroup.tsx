import type { DragEvent as ReactDragEvent } from 'react';
import type { LibraryTreeChild } from '../../utils/api';
import { DraftRow } from './DraftRow';
import { TreeGroupHeader } from './TreeGroupHeader';
import { TreeRow, type TreeRowSharedProps } from './TreeRow';
import { ROOT_ITEMS_GROUP_ID, guideStyle, rowIndent } from './treeUtils';
import { draftsInRootItems } from './types';
import styles from './WorkspaceTree.module.scss';

interface RootItemsGroupProps {
  /** Every top-level row that is not a project — folders, docs, images — in their order. */
  items: LibraryTreeChild[];
  /** Projects are drawn above, so the workspace-level groups start after a gap. */
  spaced: boolean;
  /** The tree-wide row props, spread into every row. */
  rowProps: TreeRowSharedProps;
}

/**
 * Generated "Docs & context" group: the top-level folders, docs
 * and images that belong to no project, drawn after the projects and before
 * the workspace Threads and Tables groups. Without their own
 * header these rows sat right under the last project's groups and read as
 * part of that project. The rows are ordinary root rows — dragging, ordering
 * and creating work as before — and the header is a drop target that moves
 * dragged folders and docs to the bottom of the top level, as tree
 * whitespace does. A root-level draft row
 * (any kind but a project, thread, table or board) is drawn as its first row.
 */
export function RootItemsGroup({ items, spaced, rowProps }: RootItemsGroupProps) {
  const {
    expanded,
    onToggle,
    dragSourceRef,
    hoverTargetId,
    setHoverTargetId,
    setHoverZone,
    handleDrop,
    creator,
    draftInputRef,
    commitCreator,
    cancelCreator,
  } = rowProps;
  const groupId = ROOT_ITEMS_GROUP_ID;
  const open = expanded.has(groupId);

  // Picking a kind at the root expands this group, so `open` is already true.
  const draftKind =
    open &&
    creator?.stage === 'editing' &&
    creator.parentContainerId === null &&
    draftsInRootItems(creator.kind)
      ? creator.kind
      : null;

  // Takes what tree whitespace takes — folder-tree rows, moved to the bottom
  // of the top level — and refuses threads and tables.
  const acceptsDrag = (): boolean => {
    const sources = dragSourceRef.current;
    if (!sources || sources.length === 0) return false;
    return !sources.some((s) => s.kind === 'thread' || s.kind === 'table');
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!acceptsDrag()) return;
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
    if (!dragSourceRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    handleDrop(null, 'inside');
  };

  const body = open ? (
    <>
      {draftKind !== null && (
        <DraftRow
          depth={1}
          kind={draftKind}
          inputRef={draftInputRef}
          onCommit={commitCreator}
          onCancel={cancelCreator}
        />
      )}
      {items.length === 0
        ? draftKind === null && (
            <div className={styles.taskHint} style={{ paddingLeft: rowIndent(1) }}>
              No containers or docs outside a project
            </div>
          )
        : items.map((node) => <TreeRow key={node.id} {...rowProps} node={node} depth={1} />)}
    </>
  ) : null;

  return (
    <div role="group" className={spaced ? styles.workspaceGroupsStart : undefined}>
      <TreeGroupHeader
        label="Docs & context"
        count={items.length}
        open={open}
        onToggle={() => onToggle(groupId)}
        depth={0}
        groupId={groupId}
        dropActive={hoverTargetId === groupId}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      />
      {body && (
        <div role="group" className={styles.indentGuide} style={guideStyle(0)}>
          {body}
        </div>
      )}
    </div>
  );
}
