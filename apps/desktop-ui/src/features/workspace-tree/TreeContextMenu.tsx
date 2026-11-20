import type { LibraryTreeChild } from '@desktop/utils/api';
import { ContextMenu } from '@desktop/components/ContextMenu';

export interface TreeContextMenuState {
  node: LibraryTreeChild;
  x: number;
  y: number;
}

interface TreeContextMenuProps {
  state: TreeContextMenuState;
  canPaste: boolean;
  onClose: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onArchive: () => void;
}

/** Workspace-specific actions using the shared accessible menu. */
export function TreeContextMenu({
  state,
  canPaste,
  onClose,
  onRename,
  onDuplicate,
  onCopy,
  onPaste,
  onArchive,
}: TreeContextMenuProps) {
  const isImage = state.node.kind === 'image';
  return (
    <ContextMenu
      x={state.x}
      y={state.y}
      ariaLabel="Workspace item actions"
      onClose={onClose}
      items={[
        { label: 'Rename', onSelect: onRename },
        { label: 'Duplicate', disabled: isImage, onSelect: onDuplicate },
        { label: 'Copy', disabled: isImage, onSelect: onCopy },
        { label: 'Paste', disabled: !canPaste, onSelect: onPaste },
        { label: 'Archive', onSelect: onArchive },
      ]}
    />
  );
}
