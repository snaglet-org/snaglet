import { useEffect, useRef, useState } from 'react';
import { containersApi, type ContainerTreeNode } from '@desktop/utils/api';
import {
  applyNodeMoveToTree,
  applyRenameToNode,
  onLibraryEvent,
} from '@desktop/utils/workspaceEvents';
import { findContainerInTree } from './dnd';

/** Selection snapshots are an initial placeholder, never an authoritative cache. */
export function useContainerContents(container: ContainerTreeNode) {
  const snapshot = useRef(container);
  snapshot.current = container;
  const [current, setCurrent] = useState(container);
  const id = container.id;

  useEffect(() => {
    let canceled = false;
    let sequence = 0;
    setCurrent(snapshot.current);

    const reconcile = async () => {
      const request = ++sequence;
      try {
        // Fetch category first: only a project can use the project-scoped tree.
        const record = await containersApi.get(id);
        if (canceled || request !== sequence) return;
        const tree = await containersApi.listTree(record.category === 'project' ? id : null);
        if (canceled || request !== sequence) return;
        const fresh = findContainerInTree(tree, id);
        setCurrent((previous) => ({
          ...previous,
          ...fresh,
          category: record.category ?? null,
          // Deleted/archived containers must not retain phantom cards.
          children: fresh?.children ?? [],
        }));
      } catch {
        // Keep the last usable snapshot while offline. Reconnect invalidates it.
      }
    };

    const unsubscribe = onLibraryEvent((event) => {
      if (event.type === 'node-moved') {
        // Invalidate reads begun before an optimistic undo/redo. Its follow-up
        // tree-invalidated reconciles after the server write has settled.
        ++sequence;
        setCurrent((previous) => ({
          ...previous,
          children: applyNodeMoveToTree(previous.children ?? [], event, { rootParentId: id }),
        }));
      } else if (event.type === 'renamed') {
        ++sequence;
        setCurrent(
          (previous) => applyRenameToNode(previous, event.id, event.name) as ContainerTreeNode
        );
        void reconcile();
      } else if (
        event.type === 'archive-changed' ||
        event.type === 'tree-invalidated' ||
        event.type === 'doc-saved' ||
        event.type === 'image-metadata-saved' ||
        event.type === 'created' ||
        event.type === 'deleted'
      ) {
        void reconcile();
      }
    });
    // Subscribe before reading, including on a restored pane with a stale snapshot.
    void reconcile();
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [id]);

  // Never display a previous container while the new selection's effect starts.
  const visible = current.id === id ? current : container;
  const category = visible.category ?? null;
  const children = visible.children ?? [];
  return {
    // Threads attach to projects, never to folders: a project's contents
    // include its threads, while a stale snapshot of a plain folder (saved
    // before threads left the tree) must not surface any.
    children: category === 'project' ? children : children.filter((n) => n.kind !== 'thread'),
    category,
  };
}
