import { type FC, type MouseEvent as ReactMouseEvent } from 'react';
import type { ContainerTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import { BoxIcon } from '@desktop/components/Icons';
import { EmptyState } from '@desktop/components';
import styles from './ContainerView.module.scss';
import { kindOrder } from './helpers';
import { IconCell } from './IconCell';
import { ListRow } from './ListRow';

export type ViewMode = 'icons' | 'list';

interface IconsModeProps {
  container: ContainerTreeNode;
  /** Live children — overrides container.children. Owned by ContainerView
   *  so it can refetch on workspace mutation events without props mutation. */
  children: readonly LibraryTreeChild[];
  viewMode: ViewMode;
  renamingId: string | null;
  onNavigateInto: (node: LibraryTreeChild) => void;
  onContextMenu: (node: LibraryTreeChild, e: ReactMouseEvent) => void;
  onCommitRename: (node: LibraryTreeChild, value: string) => void;
  onCancelRename: () => void;
  /** Per-cell shift-drop: dragged chip lands inside the targeted container
   *  cell (one level deeper than the pane's own container). */
  onDropIntoChild: (dataTransfer: DataTransfer, targetContainerId: string) => void | Promise<void>;
}

/**
 * IconsMode — container child renderer. Despite the name (kept for
 * symmetry with the user-facing "Icons" view-mode toggle), this also
 * dispatches the list-mode rendering by swapping cell types. The
 * orchestrator (ContainerView) owns the toggle state.
 */
export const IconsMode: FC<IconsModeProps> = ({
  container: _container,
  children,
  viewMode,
  renamingId,
  onNavigateInto,
  onContextMenu,
  onCommitRename,
  onCancelRename,
  onDropIntoChild,
}) => {
  if (children.length === 0) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="Empty container"
        body="Add containers, docs, or threads from the Workspace sidebar."
      />
    );
  }

  const sorted = [...children].sort((a, b) => kindOrder(a) - kindOrder(b));
  const Cell = viewMode === 'icons' ? IconCell : ListRow;
  const containerClass = viewMode === 'icons' ? styles.iconGrid : styles.list;

  return (
    <div className={containerClass}>
      {sorted.map((node) => (
        <Cell
          key={node.id}
          node={node}
          renaming={renamingId === node.id}
          onClick={() => onNavigateInto(node)}
          onContextMenu={(e) => onContextMenu(node, e)}
          onCommitRename={(value) => onCommitRename(node, value)}
          onCancelRename={onCancelRename}
          // Container kids (incl. project-root containers) accept shift-drops
          // to reparent the chip into themselves. Non-container cells fall
          // through — they have no children, so "drop into" is meaningless.
          acceptDropInto={node.kind === 'container' ? node.id : null}
          onDropInto={onDropIntoChild}
        />
      ))}
    </div>
  );
};
