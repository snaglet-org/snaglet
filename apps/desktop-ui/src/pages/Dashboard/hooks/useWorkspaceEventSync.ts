import { useEffect, useRef } from 'react';
import { getErrorMessage } from '@snaglet/shared/utils';
import { archiveApi, containersApi, FetchError } from '@desktop/utils/api';
import {
  applyDocSavedToNode,
  applyFileRenameToFileNode,
  applyImageMetadataToNode,
  applyRenameToNode,
  onLibraryEvent,
  type LibraryEvent,
} from '@desktop/utils/workspaceEvents';
import { mapSelections, type LayoutNode } from '../layout/paneTree';
import type { DetailSelection } from '../selection/types';
import { indexWorkspaceNodes } from '../selection/workspaceNodeIndex';

/**
 * Apply a workspace mutation to the hydrated node cached by one pane
 * selection. The selection's focus/navigation fields are preserved.
 */
export function applyWorkspaceEventToSelection(
  selection: DetailSelection,
  event: LibraryEvent
): DetailSelection {
  if (!selection) return selection;

  const patchNode = (node: Parameters<typeof applyRenameToNode>[0]) => {
    if (event.type === 'renamed') {
      return applyRenameToNode(node, event.id, event.name);
    }
    if (event.type === 'doc-saved') {
      return applyDocSavedToNode(node, event.id, event.content, event.updatedAt);
    }
    if (event.type === 'image-metadata-saved') {
      return applyImageMetadataToNode(node, event.id, event);
    }
    return node;
  };

  switch (selection.kind) {
    case 'doc': {
      if (!selection.node) return selection;
      const node = patchNode(selection.node);
      return node.kind === 'doc' && node !== selection.node ? { ...selection, node } : selection;
    }
    case 'thread': {
      if (!selection.node) return selection;
      const node = patchNode(selection.node);
      return node.kind === 'thread' && node !== selection.node ? { ...selection, node } : selection;
    }
    case 'container': {
      if (!selection.node) return selection;
      const node = patchNode(selection.node);
      return node.kind === 'container' && node !== selection.node
        ? { ...selection, node }
        : selection;
    }
    case 'image': {
      if (!selection.node) return selection;
      const node = patchNode(selection.node);
      return node.kind === 'image' && node !== selection.node ? { ...selection, node } : selection;
    }
    case 'file': {
      if (event.type !== 'file-renamed') return selection;
      const node = applyFileRenameToFileNode(selection.node, event);
      return node !== selection.node ? { ...selection, node } : selection;
    }
    default:
      return selection;
  }
}

/**
 * Propagates workspace mutations from local UI actions and realtime server
 * events into every pane's cached node and history entry, so user and agent
 * edits (a rename, a saved doc body) repaint without a refetch.
 */
export function useWorkspaceEventSync(
  setLayout: React.Dispatch<React.SetStateAction<LayoutNode>>
): void {
  useEffect(() => {
    return onLibraryEvent((event) => {
      if (
        event.type !== 'renamed' &&
        event.type !== 'doc-saved' &&
        event.type !== 'image-metadata-saved' &&
        event.type !== 'file-renamed'
      )
        return;
      setLayout((previous) =>
        mapSelections(previous, (selection) => applyWorkspaceEventToSelection(selection, event))
      );
    });
  }, [setLayout]);
}

/**
 * Workspace node id of a selection whose pane renders from its cached node
 * (docs, folders and projects, images). Without that node the pane looks the
 * item up and explains why it is unavailable, instead of rendering a copy of
 * an item that is gone.
 */
function cachedNodeId(selection: DetailSelection): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case 'doc':
      return selection.node ? selection.doc_id : null;
    case 'container':
      return selection.node ? selection.container_id : null;
    case 'image':
      return selection.node ? selection.image_id : null;
    default:
      return null;
  }
}

/** Drop the cached node of a selection that points at a removed item. */
function forgetRemovedNode(
  selection: DetailSelection,
  removedIds: ReadonlySet<string>
): DetailSelection {
  const id = cachedNodeId(selection);
  if (!selection || id === null || !removedIds.has(id)) return selection;
  switch (selection.kind) {
    case 'doc':
    case 'container':
    case 'image':
      return { ...selection, node: undefined };
    default:
      return selection;
  }
}

function cachedNodeIds(layout: LayoutNode): Set<string> {
  const ids = new Set<string>();
  mapSelections(layout, (selection) => {
    const id = cachedNodeId(selection);
    if (id) ids.add(id);
    return selection;
  });
  return ids;
}

/**
 * Keeps panes and their back/forward history from showing an archived or
 * deleted item as if it were live. A delete drops the cached node at once;
 * `archive-changed` also covers moves and restores, so each shown id is
 * checked with the server first, and the pane then says the item was
 * archived or is gone. The event names only an archived folder, so other
 * shown items missing from the live workspace tree are checked the same way.
 */
export function useRemovedNodeSync(
  layout: LayoutNode,
  setLayout: React.Dispatch<React.SetStateAction<LayoutNode>>
): void {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    let active = true;
    const forget = (id: string) => {
      if (!active) return;
      const removed = new Set([id]);
      setLayout((previous) =>
        mapSelections(previous, (selection) => forgetRemovedNode(selection, removed))
      );
    };
    const forgetIfArchived = (id: string) => {
      archiveApi
        .counts(id)
        .then(({ node }) => {
          if (node.archived) forget(id);
        })
        .catch((err: unknown) => {
          if (err instanceof FetchError && err.status === 404) forget(id);
        });
    };
    const forgetLeftTree = (ids: readonly string[]) => {
      containersApi
        .listTree()
        .then((tree) => {
          if (!active) return;
          const live = indexWorkspaceNodes(tree);
          for (const id of ids) if (!live.has(id)) forgetIfArchived(id);
        })
        .catch((err: unknown) => {
          console.error(
            'useRemovedNodeSync: failed to read the workspace tree',
            getErrorMessage(err)
          );
        });
    };
    const stop = onLibraryEvent((event) => {
      if (event.type === 'deleted') {
        forget(event.id);
        return;
      }
      if (event.type !== 'archive-changed') return;
      const shown = cachedNodeIds(layoutRef.current);
      const changed = new Set(event.ids);
      for (const id of changed) if (shown.has(id)) forgetIfArchived(id);
      // An event naming no node (an agent archived or restored) cannot cascade.
      const others = [...shown].filter((id) => !changed.has(id));
      if (changed.size > 0 && others.length > 0) forgetLeftTree(others);
    });
    return () => {
      active = false;
      stop();
    };
  }, [setLayout]);
}
