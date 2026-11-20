import type { LibraryTreeChild } from '@desktop/utils/api';
import { containersApi } from '@desktop/utils/api';
import type { PaneNavigationTarget } from '@snaglet/shared/types';
import { type DetailSelection, selectionFromWorkspaceNode } from './types';
import { indexWorkspaceNodes } from './workspaceNodeIndex';

/**
 * Turn an agent's id-based `PaneNavigationTarget` (the `ui.navigate_pane` wire
 * shape) into a `DetailSelection`. Node-backed kinds (doc, container, image)
 * are looked up in the workspace tree and mapped by
 * `selectionFromWorkspaceNode`, the same mapper tree clicks use; if the lookup
 * fails they fall back to an id-only selection the Dashboard hydrates later.
 * Threads and providers need no node. A project is a container
 * (`category === 'project'`), so agents reach it with a `container` target.
 */

/** Find a node anywhere in the workspace tree by id. */
async function findNodeById(id: string): Promise<LibraryTreeChild | null> {
  try {
    const tree = await containersApi.listTree();
    return indexWorkspaceNodes(tree).get(id) ?? null;
  } catch (err) {
    // Network/load failure — caller falls back to an ID-native selection.
    console.error('[resolveNavigationTarget] failed to load workspace tree', err);
    return null;
  }
}

/**
 * Resolve a wire navigation target to a `DetailSelection`, or `null` when the
 * target kind is unsupported.
 */
export async function resolveNavigationTarget(
  target: PaneNavigationTarget
): Promise<DetailSelection> {
  switch (target.kind) {
    // ID-native kinds: render from the ID alone (no node fetch)
    case 'thread':
      return {
        kind: 'thread',
        thread_id: target.threadId,
        focusAgentId: target.agentId,
      };
    case 'providers':
      // The wire target's `providerId` is ignored: the providers catalog has
      // no per-provider focus.
      return { kind: 'providers' };

    // Node-backed kinds: resolve ID -> node via the container tree
    case 'doc':
    case 'container':
    case 'image': {
      const id =
        target.kind === 'doc'
          ? target.docId
          : target.kind === 'container'
            ? target.containerId
            : target.imageId;
      const node = await findNodeById(id);
      if (node) return selectionFromWorkspaceNode(node);
      // Resolution failed — keep the canonical ID-only selection. Dashboard
      // hydration retries it against the workspace tree.
      if (target.kind === 'doc') return { kind: 'doc', doc_id: target.docId };
      if (target.kind === 'container')
        return { kind: 'container', container_id: target.containerId };
      return { kind: 'image', image_id: target.imageId };
    }

    default:
      return null;
  }
}
