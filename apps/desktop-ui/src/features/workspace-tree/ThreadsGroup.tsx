import type { DragEvent as ReactDragEvent } from 'react';
import type { ThreadTreeNode } from '../../utils/api';
import { DraftRow } from './DraftRow';
import { TreeGroupHeader } from './TreeGroupHeader';
import { TreeRow, type TreeRowSharedProps } from './TreeRow';
import { guideStyle, rowIndent, threadsGroupId } from './treeUtils';
import styles from './WorkspaceTree.module.scss';

interface ThreadsGroupProps {
  /** Owning project, or `null` for the workspace-level group of flat threads. */
  projectId: string | null;
  /** Threads scoped to the owner, in the order the tree payload lists them (their manual order). */
  threads: ThreadTreeNode[];
  /** Indent level of the group header; thread rows sit one level deeper. 0 = workspace level. */
  headerDepth: number;
  /** The tree-wide row props, spread into every thread row. */
  rowProps: TreeRowSharedProps;
}

/**
 * Generated "Threads" group: the threads attached to a project, drawn before
 * the project's folders, or — at the root — the flat threads that belong to
 * no project. Threads are not folder-tree rows, so this header (not a
 * folder) is where a dragged thread lands to change scope: dropping on a
 * project's group scopes it to that project (at the top of its list),
 * dropping on the workspace group makes it flat. Threads keep a manual
 * order: dropping threads above or below a thread row places them there,
 * and new activity never moves a thread. Expansion rides the shared
 * `expanded` set under the group's own key so reveal can open it and it
 * survives reloads.
 */
export function ThreadsGroup({ projectId, threads, headerDepth, rowProps }: ThreadsGroupProps) {
  const {
    expanded,
    onToggle,
    dragSourceRef,
    hoverTargetId,
    setHoverTargetId,
    setHoverZone,
    handleThreadScopeDrop,
    nodeIndex,
    creator,
    draftInputRef,
    commitCreator,
    cancelCreator,
  } = rowProps;
  const groupId = threadsGroupId(projectId);
  const open = expanded.has(groupId);
  const nested = headerDepth > 0;
  const rowDepth = headerDepth + 1;

  // The inline name row for a new thread in this scope, drawn as the group's
  // first row. Opening it expands the group, so `open` is already true.
  const drafting =
    open &&
    creator?.stage === 'editing' &&
    creator.kind === 'thread' &&
    creator.parentContainerId === projectId;
  const draftRow = drafting ? (
    <DraftRow
      depth={rowDepth}
      kind="thread"
      inputRef={draftInputRef}
      onCommit={commitCreator}
      onCancel={cancelCreator}
    />
  ) : null;

  // Only an all-thread drag that would actually change scope lights up the
  // header; anything else keeps the browser's not-allowed cursor.
  const acceptsDrag = (): boolean => {
    const sources = dragSourceRef.current;
    if (!sources || sources.length === 0) return false;
    if (!sources.every((s) => s.kind === 'thread')) return false;
    return sources.some((s) => {
      const node = nodeIndex.get(s.id);
      return node?.kind === 'thread' && node.projectId !== projectId;
    });
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
    handleThreadScopeDrop(projectId);
  };

  const header = (
    <TreeGroupHeader
      label="Threads"
      count={threads.length}
      open={open}
      onToggle={() => onToggle(groupId)}
      depth={headerDepth}
      groupId={groupId}
      dropActive={hoverTargetId === groupId}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    />
  );

  const body = open ? (
    <>
      {draftRow}
      {threads.length === 0 ? (
        drafting ? null : (
          <div className={styles.taskHint} style={{ paddingLeft: rowIndent(rowDepth) }}>
            {projectId === null ? 'No threads outside a project' : 'No threads in this project'}
          </div>
        )
      ) : (
        threads.map((thread) => (
          <TreeRow key={thread.id} {...rowProps} node={thread} depth={rowDepth} />
        ))
      )}
    </>
  ) : null;

  // Under a project the whole group hangs off the project's guide line, like
  // the Files group. At the root there is no parent guide; the rows get their
  // own, anchored at this header's chevron, like children of a root folder.
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
