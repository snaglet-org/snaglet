import type { DragEvent, ReactNode } from 'react';
import { containersApi, docsApi, imagesApi, type LibraryTreeChild } from '@desktop/utils/api';
import { selectionFromWorkspaceNode } from '../../selection/types';
import { threadsApi } from '@desktop/utils/api/threads';
import { PANE_ITEM_MIME } from '@desktop/utils/paneDrag';
import { placementParentOf } from '@desktop/features/workspace-tree/treeUtils';
import { formatShortDate } from '@snaglet/shared/utils';

/** Same MIME the WorkspaceTree drag source uses for in-tree moves. ContainerView
 *  body / icon-cell drops listen for this — emitting it from the icon-cell
 *  drag source is what makes cross-pane (and cross-icon) reparent work. */
const TREE_NODE_MIME = 'application/x-snaglet-tree-node';
import { BoxIcon, ChatBubbleIcon, DocIcon, ImageIcon } from '@desktop/components/Icons';
import { ProjectIcon } from '@desktop/components/Icons/ProjectIcon';

/**
 * Folder-first sort (Finder-style): containers, then docs, then threads,
 * then images. Unknown kinds sort to the end via the `?? 3` floor.
 */
const KIND_ORDER: Record<LibraryTreeChild['kind'], number> = {
  container: 0,
  doc: 1,
  thread: 2,
  image: 2.7,
};

export const kindOrder = (node: LibraryTreeChild): number => KIND_ORDER[node.kind] ?? 3;

export function labelFor(node: LibraryTreeChild | undefined): string {
  if (!node) return '';
  if (node.kind === 'container') return node.name || 'Untitled container';
  if (node.kind === 'doc') return node.title || 'Untitled doc';
  if (node.kind === 'thread') return node.title || 'Untitled thread';
  if (node.kind === 'image') return node.name || 'Untitled image';
  return 'Untitled';
}

export function iconFor(node: LibraryTreeChild): ReactNode {
  // A project is a container with category='project'; it draws the container
  // box with a star.
  if (node.kind === 'container') return node.category === 'project' ? <ProjectIcon /> : <BoxIcon />;
  if (node.kind === 'doc') return <DocIcon />;
  if (node.kind === 'thread') return <ChatBubbleIcon />;
  if (node.kind === 'image') return <ImageIcon />;
  return <DocIcon />;
}

export function metaFor(node: LibraryTreeChild): string {
  if (node.kind === 'container') {
    const count = node.children?.length ?? 0;
    return count === 1 ? '1 item' : `${count} items`;
  }
  if (node.kind === 'doc') return formatShortDate(node.updatedAt);
  if (node.kind === 'thread') {
    return node.lastMessageAt ? formatShortDate(node.lastMessageAt) : 'No messages';
  }
  if (node.kind === 'image') return formatShortDate(node.updatedAt);
  return '';
}

/** Start a drag from an icon cell.
 *
 *  Emits two MIMEs so the same drag can satisfy either consumer:
 *    - `PANE_ITEM_MIME`  — pane chrome treats this as "open in a new pane"
 *      (no shift required)
 *    - `TREE_NODE_MIME`  — ContainerView's body + container icon cells treat
 *      this as "reparent into me" (shift-drop)
 *
 *  Without TREE_NODE_MIME, drops into another open container pane / onto a
 *  container icon in the same pane were silently ignored.
 *
 *  Tasks aren't reparentable here. */
export function emitPaneDrag(e: DragEvent<HTMLButtonElement>, node: LibraryTreeChild): void {
  e.dataTransfer.setData(PANE_ITEM_MIME, JSON.stringify(selectionFromWorkspaceNode(node)));
  // TREE_NODE_MIME expects an array; a single-node drag still sends an array
  // so the ContainerView receiver doesn't have to branch. Placement + label
  // ride along so the receiving drop handler can record an undo inverse.
  e.dataTransfer.setData(
    TREE_NODE_MIME,
    JSON.stringify([
      {
        id: node.id,
        kind: node.kind,
        parentId: placementParentOf(node),
        sortOrder: node.sortOrder,
        label: labelFor(node),
      },
    ])
  );
  e.dataTransfer.effectAllowed = 'all';
}

/**
 * Per-kind rename dispatchers. Project containers rename like any container
 * (`containers.update`); an image rename renames its stored file too. `null`
 * signals "no rename API for this kind" — ContainerView treats that as a no-op.
 */
export const RENAME_HANDLERS: Record<
  LibraryTreeChild['kind'],
  ((id: string, name: string) => Promise<unknown>) | null
> = {
  container: (id, name) => containersApi.update(id, { name }),
  doc: (id, name) => docsApi.update(id, { title: name }),
  thread: (id, name) => threadsApi.rename(id, name),
  image: (id, name) => imagesApi.rename(id, name),
};
