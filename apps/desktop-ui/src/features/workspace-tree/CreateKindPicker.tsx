import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BoxIcon, ChatBubbleIcon, DocIcon, TableIcon } from '@desktop/components/Icons';
import { ProjectIcon } from '@desktop/components/Icons/ProjectIcon';
import { toFixedLayer } from '@desktop/utils/cssZoom';
import styles from './WorkspaceTree.module.scss';
import type { TreePickerKind } from './types';

interface CreateKindPickerProps {
  /** Rect px (from the + button's `getBoundingClientRect`). */
  anchorLeft: number;
  anchorTop: number;
  /**
   * Kinds to offer, in menu order — `useTreeCreator().creatableKinds`, which
   * drops `thread` and `table` inside plain folders.
   */
  kinds: readonly TreePickerKind[];
  onSelectKind: (kind: TreePickerKind) => void;
}

const KIND_ITEMS: Record<TreePickerKind, { label: string; icon: ReactNode }> = {
  container: { label: 'Container', icon: <BoxIcon /> },
  project: { label: 'Project', icon: <ProjectIcon /> },
  doc: { label: 'Doc', icon: <DocIcon /> },
  thread: { label: 'Thread', icon: <ChatBubbleIcon /> },
  table: { label: 'Table', icon: <TableIcon /> },
};

/**
 * Kind-picker popover for the tree's create flow. Portaled to body so it
 * escapes the sidebar's stacking context: the sidebar has `backdrop-filter`,
 * which creates a new containing block — without the portal,
 * `position: fixed` is resolved relative to the sidebar (which is
 * `overflow: hidden`), and the popover gets clipped by the main pane area on
 * the right. On `<body>` it sits inside the root zoom, so the rect-px anchor
 * is converted to the fixed layer's CSS px (see utils/cssZoom).
 *
 * "Project" creates a container with category 'project'. "Table" opens the
 * table draft pane rather than an inline name row (see `useTreeCreator`).
 */
export function CreateKindPicker({
  anchorLeft,
  anchorTop,
  kinds,
  onSelectKind,
}: CreateKindPickerProps) {
  return createPortal(
    <div
      className={styles.picker}
      style={toFixedLayer({ left: anchorLeft, top: anchorTop })}
      role="menu"
    >
      {kinds.map((kind) => (
        <button
          key={kind}
          type="button"
          className={styles.pickerItem}
          onClick={() => onSelectKind(kind)}
          role="menuitem"
        >
          <span aria-hidden>{KIND_ITEMS[kind].icon}</span>
          <span>{KIND_ITEMS[kind].label}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}
