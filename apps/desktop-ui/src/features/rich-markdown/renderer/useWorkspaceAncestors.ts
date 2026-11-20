import { useEffect, useMemo, useState } from 'react';
import { containersApi, type LibraryTreeChild } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { findNodeAncestors } from '@desktop/pages/Dashboard/chrome/PathHeader/nodeAncestors';

// Module-level cache of the library tree. Path lookups for chip ancestors
// share this single fetch across every Chip instance and across every chip
// within a single doc — otherwise a prose-heavy doc with N chips would
// trigger N tree fetches. Invalidated on any event that can change a chip's
// path or membership: renames (path segment text), moves (ancestry),
// creation/deletion/archive (whether the node resolves at all), and the
// catch-all tree-invalidated reconcile — both local mutations and
// cross-client WS events land on this bus, so the cache cannot pin a
// session-old tree.
let treeCachePromise: Promise<LibraryTreeChild[]> | null = null;
const subscribers = new Set<() => void>();

function getLibraryTreeCached(): Promise<LibraryTreeChild[]> {
  if (!treeCachePromise) {
    treeCachePromise = containersApi
      .listTree()
      .then((t) => t ?? [])
      .catch(() => [] as LibraryTreeChild[]);
  }
  return treeCachePromise;
}

function invalidateTreeCache(): void {
  treeCachePromise = null;
  for (const fn of subscribers) fn();
}

// Module-level subscription — never unsubscribes; lives for the lifetime of
// the renderer bundle. Renames and structural changes can shift any chip's
// path; created/deleted/archive change whether a chip resolves at all.
if (typeof window !== 'undefined') {
  onLibraryEvent((e) => {
    if (
      e.type === 'renamed' ||
      e.type === 'node-moved' ||
      e.type === 'tree-invalidated' ||
      e.type === 'created' ||
      e.type === 'deleted' ||
      e.type === 'archive-changed'
    ) {
      invalidateTreeCache();
    }
  });
}

/**
 * Resolve the ancestor-container names leading to `nodeId` by walking
 * the (cached) library tree. Returns `null` while loading; returns `[]`
 * for nodes that are in the tree but at root level (no ancestors).
 * Returns the names array (topmost first) for nested nodes. The
 * caller decides whether `[]` and `null` render the same visually.
 *
 * Re-runs when the tree cache is invalidated by a rename or structural
 * (move/create/delete/archive) event.
 */
export function useWorkspaceAncestors(nodeId: string | null | undefined): string[] | null {
  const tree = useWorkspaceTree(!!nodeId);
  // findNodeAncestors returns null when the node isn't found — surface that
  // as `[]` so the consumer can distinguish "no path / not yet resolved"
  // from "loaded, no ancestors". null stays the loading sentinel.
  return useMemo(
    () => (tree && nodeId ? (findNodeAncestors(tree, nodeId) ?? []) : null),
    [tree, nodeId]
  );
}

/**
 * The cached library tree, shared with every chip's path lookup. Returns
 * null while loading or when `enabled` is false (nothing is fetched then),
 * and the fresh tree again after any rename or structural change.
 */
export function useWorkspaceTree(enabled: boolean): LibraryTreeChild[] | null {
  const [tree, setTree] = useState<LibraryTreeChild[] | null>(null);

  useEffect(() => {
    let canceled = false;
    setTree(null);
    if (!enabled) return;

    const apply = () => {
      void getLibraryTreeCached().then((loaded) => {
        if (!canceled) setTree(loaded);
      });
    };

    apply();
    const onInvalidate = () => {
      if (!canceled) apply();
    };
    subscribers.add(onInvalidate);
    return () => {
      canceled = true;
      subscribers.delete(onInvalidate);
    };
  }, [enabled]);

  return tree;
}
