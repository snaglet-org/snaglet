import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { LibraryTreeChild } from '../../../utils/api';
import {
  applyDocSavedToNode,
  applyNodeMoveToTree,
  applyRenameToNode,
  onLibraryEvent,
  pruneNodesById,
} from '../../../utils/workspaceEvents';

export interface UseTreeLibraryEventsArgs {
  /** Tree roots setter — patched surgically per event type. */
  setRoots: Dispatch<SetStateAction<LibraryTreeChild[] | null>>;
  /** Bumps the tree refetch key for events that demand a full reload. */
  setReloadKey: Dispatch<SetStateAction<number>>;
}

/**
 * Library-event reconciliation: subscribes to the cross-surface library
 * event bus and patches the tree's local caches in place so the sidebar
 * stays in lock-step with the rest of the UI without full refetches.
 * Handles renames and doc saves (surgical node patches), archive changes
 * (optimistic pruning from the tree, with caller-opt-in refetch for
 * restores/cascades), and tree invalidations (drop caches and refetch).
 */
export function useTreeLibraryEvents({ setRoots, setReloadKey }: UseTreeLibraryEventsArgs) {
  // Patch local tree state when a rename happens elsewhere (e.g. from a
  // container browser pane). Avoids a full refetch and keeps the sidebar
  // in lock-step with the rest of the UI.
  useEffect(() => {
    return onLibraryEvent((event) => {
      if (event.type === 'renamed') {
        setRoots((prev) => {
          if (!prev) return prev;
          const next = prev.map((n) => applyRenameToNode(n, event.id, event.name));
          return next.some((n, i) => n !== prev[i]) ? next : prev;
        });
        return;
      }
      if (event.type === 'doc-saved') {
        // Patch the cached doc node so reopening it shows the just-saved
        // content (the tree fetch is one-shot, never refetched on save).
        setRoots((prev) => {
          if (!prev) return prev;
          const next = prev.map((n) =>
            applyDocSavedToNode(n, event.id, event.content, event.updatedAt)
          );
          return next.some((n, i) => n !== prev[i]) ? next : prev;
        });
        return;
      }
      if (event.type === 'node-moved') {
        // Optimistic undo/redo replay: patch the node into its new spot
        // immediately. Best-effort — when the patch can't apply (node or
        // destination not in this tree) the undo store's follow-up
        // tree-invalidated reconciles instead.
        setRoots((prev) => (prev ? applyNodeMoveToTree(prev, event) : prev));
        return;
      }
      if (event.type === 'archive-changed') {
        // Optimistically prune the archived ids from the tree so the dragged
        // row disappears the instant the drop succeeds — no waiting on the
        // server round-trip + refetch. Restores (ids that were re-added
        // elsewhere) aren't in the current tree, so pruning is a no-op
        // for them — the caller flags `reload: true` so the refetch
        // below brings them back.
        if (event.ids.length > 0) {
          const idSet = new Set(event.ids);
          setRoots((prev) => {
            if (!prev) return prev;
            // Drop any archived node that's a top-level root, then recurse
            // into surviving containers to prune nested archived nodes
            // (e.g. a doc inside a container).
            const next = prev.filter((n) => !idSet.has(n.id)).map((n) => pruneNodesById(n, idSet));
            return next;
          });
        }
        // Caller-opt-in tree refetch: only for restores (id wasn't in
        // the local tree, prune was a no-op) and cascading archives
        // (container/project archives trigger server-side cascades whose
        // child ids aren't in `ids`). Skipping the refetch for leaf
        // archives avoids the visible flicker from the cache-wipe
        // effect attached to `reloadKey`.
        if (event.reload) {
          setReloadKey((k) => k + 1);
        }
        return;
      }
      if (event.type === 'tree-invalidated') {
        // External signal — WS-bridged tree mutations from another
        // client. Drop caches and refetch.
        setReloadKey((k) => k + 1);
        return;
      }
    });
  }, [setRoots, setReloadKey]);
}
