import { type FC } from 'react';
import styles from './ContainerView.module.scss';
import { emitPaneDrag, iconFor, labelFor, metaFor } from './helpers';
import { RenameInput } from './RenameInput';
import type { CellProps } from './IconCell';

export const ListRow: FC<CellProps> = ({
  node,
  renaming,
  onClick,
  onContextMenu,
  onCommitRename,
  onCancelRename,
}) => {
  const draggable = !renaming;

  // Build kind-specific class for icon coloring
  let kindClass = styles[`kind-${node.kind}`] ?? '';
  if (node.kind === 'container' && node.category) {
    kindClass = styles[`kind-container-${node.category}`] ?? kindClass;
  }

  const className = `${styles.listRow} ${kindClass} ${renaming ? styles.cellRenaming : ''}`;

  const body = (
    <>
      <span className={styles.rowIcon} aria-hidden>
        {iconFor(node)}
      </span>
      {renaming ? (
        <RenameInput
          initialValue={labelFor(node)}
          className={styles.renameInputRow}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      ) : (
        <>
          <span className={styles.rowLabel}>{labelFor(node)}</span>
          <span className={styles.rowMeta}>{metaFor(node)}</span>
          <span className={styles.rowChevron} aria-hidden>
            ›
          </span>
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
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={(e) => emitPaneDrag(e, node)}
    >
      {body}
    </button>
  );
};
