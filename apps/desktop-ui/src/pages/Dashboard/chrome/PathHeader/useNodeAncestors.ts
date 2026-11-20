import { useEffect, useState } from 'react';
import { subscribeWorkspaceTree } from '@desktop/features/workspace-tree/workspaceTreeFeed';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { findNodeAncestorNodes, type AncestorContainer } from './nodeAncestors';

/**
 * Resolves the containers above a node (topmost first) by walking the library
 * tree: the breadcrumb's names, and the parent ⌘↑ opens.
 * Returns `[]` while loading or if the node isn't found (orphan / pre-fetch).
 * Refetches when the node id changes and whenever the tree is reshaped
 * (a node moved — a thread changing project — or a tree invalidation), so
 * the header follows the node rather than its placement at open time.
 *
 * The tree comes from the shared, coalesced workspace tree feed, so every
 * open pane header and the sidebar ride one fetch per burst of events, and
 * each landed fetch repaints the path whichever reader asked for it.
 */
export function useNodeAncestors(nodeId: string | null | undefined): AncestorContainer[] {
  const [ancestors, setAncestors] = useState<AncestorContainer[]>([]);

  useEffect(() => {
    setAncestors([]);
    if (!nodeId) return;

    const subscription = subscribeWorkspaceTree({
      onTree: (tree) => setAncestors(findNodeAncestorNodes(tree, nodeId) ?? []),
      onError: (err) => {
        // Decorative — failure leaves the title-only fallback.
        console.error('useNodeAncestors: failed to load workspace tree', err);
      },
    });
    const unsubscribe = onLibraryEvent((event) => {
      if (
        event.type === 'node-moved' ||
        event.type === 'tree-invalidated' ||
        event.type === 'renamed' ||
        event.type === 'archive-changed'
      ) {
        subscription.request();
      }
    });
    subscription.request();
    return () => {
      subscription.close();
      unsubscribe();
    };
  }, [nodeId]);

  return ancestors;
}
