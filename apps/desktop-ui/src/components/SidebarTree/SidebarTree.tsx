import { forwardRef, type DragEvent as ReactDragEvent } from 'react';
import {
  Tree,
  TreeChildren,
  TreeGroup,
  TreeRow as UiTreeRow,
  type TreeRowProps as UiTreeRowProps,
} from '@snaglet/ui/sidebar-tree';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import type { DetailSelection } from '@desktop/pages/Dashboard/selection/types';

export { Tree, TreeChildren, TreeGroup };

export interface TreeRowProps extends UiTreeRowProps {
  /** Desktop-only payload for dragging a shared tree row into a workspace pane. */
  paneSelection?: DetailSelection;
}

export const TreeRow = forwardRef<HTMLElement, TreeRowProps>(function TreeRow(
  { paneSelection, draggable, onDragStart, ...props },
  ref
) {
  const handleDragStart = (event: ReactDragEvent<HTMLElement>) => {
    if (paneSelection && !event.dataTransfer.getData(PANE_ITEM_MIME)) {
      event.dataTransfer.setData(PANE_ITEM_MIME, JSON.stringify(paneSelection));
      event.dataTransfer.effectAllowed = 'all';
    }
    onDragStart?.(event);
  };

  return (
    <UiTreeRow
      {...props}
      ref={ref}
      draggable={draggable ?? Boolean(paneSelection)}
      onDragStart={handleDragStart}
    />
  );
});
