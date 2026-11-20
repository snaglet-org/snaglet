import { useState, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import type { LibraryTreeChild } from '@desktop/utils/api';
import styles from './ContainerView.module.scss';
import { emitPaneDrag, iconFor, labelFor, metaFor } from './helpers';
import { RenameInput } from './RenameInput';

const TREE_NODE_MIME = 'application/x-snaglet-tree-node';

export interface CellProps {
  node: LibraryTreeChild;
  renaming: boolean;
  onClick: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  /** When non-null, this cell is a container that accepts drops to move the
   *  dragged node into the container with this id. Null disables the drop
   *  target. */
  acceptDropInto?: string | null;
  onDropInto?: (dataTransfer: DataTransfer, targetContainerId: string) => void | Promise<void>;
}

export const IconCell: FC<CellProps> = ({
  node,
  renaming,
  onClick,
  onContextMenu,
  onCommitRename,
  onCancelRename,
  acceptDropInto = null,
  onDropInto,
}) => {
  const draggable = !renaming;
  const [dragOver, setDragOver] = useState(false);

  // Build kind-specific class for icon coloring
  let kindClass = styles[`kind-${node.kind}`] ?? '';
  if (node.kind === 'container' && node.category) {
    kindClass = styles[`kind-container-${node.category}`] ?? kindClass;
  }

  const className = `${styles.iconCell} ${kindClass} ${
    renaming ? styles.cellRenaming : ''
  } ${dragOver ? styles.cellDropTarget : ''}`;
  const canAcceptDrop = acceptDropInto !== null && !!onDropInto;

  const body = (
    <>
      <span className={styles.iconBig} aria-hidden>
        {iconFor(node)}
      </span>
      {renaming ? (
        <RenameInput
          initialValue={labelFor(node)}
          className={styles.renameInputIcon}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <>
          <span className={styles.iconLabel}>{labelFor(node)}</span>
          <span className={styles.iconMeta}>{metaFor(node)}</span>
        </>
      )}
    </>
  );

  if (renaming) {
    return (
      <div className={className} onContextMenu={(e) => e.preventDefault()}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      onDoubleClick={onClick}
      onContextMenu={onContextMenu}
      title={labelFor(node)}
      draggable={draggable}
      onDragStart={(e) => emitPaneDrag(e, node)}
      // Marks this cell as a container drop target so the surrounding pane's
      // split-zone overlay defers to it (see usePaneDropZone).
      data-pane-drop-target={canAcceptDrop ? 'container-cell' : undefined}
      // Per-cell drop: hovering a dragged node over a container icon lights it
      // up and accepts the drop, moving the node one level deeper without first
      // navigating into the target container. This takes priority over the
      // pane's split-screen overlay — stopPropagation keeps the surrounding
      // pane drop zone from claiming the drag while we're over a container.
      onDragOver={
        canAcceptDrop
          ? (e) => {
              if (!e.dataTransfer.types.includes(TREE_NODE_MIME)) return;
              e.preventDefault();
              e.stopPropagation(); // outrank the pane's split-zone overlay + body drop
              e.dataTransfer.dropEffect = 'move';
              if (!dragOver) setDragOver(true);
            }
          : undefined
      }
      onDragLeave={
        canAcceptDrop
          ? () => {
              if (dragOver) setDragOver(false);
            }
          : undefined
      }
      onDrop={
        canAcceptDrop
          ? (e) => {
              setDragOver(false);
              if (!e.dataTransfer.types.includes(TREE_NODE_MIME)) return;
              e.preventDefault();
              e.stopPropagation();
              void onDropInto!(e.dataTransfer, acceptDropInto!);
            }
          : undefined
      }
    >
      {body}
    </button>
  );
};
