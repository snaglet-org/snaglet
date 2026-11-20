/**
 * Clone API — copy/paste of workspace-tree nodes.
 *
 * Backs the tree's Cmd/Ctrl+C → Cmd/Ctrl+V gesture. The server performs the
 * whole recursive clone (subtree copy, node-reference remap, config-only thread
 * clones) in one transaction and emits `workspace.created` events for every new
 * node, so the tree refreshes via the realtime bridge; the caller also bumps
 * its own reload key for instant feedback.
 */

import { fetchData, getApiUrl } from './core';

interface CloneInput {
  /** Id of the node to copy (doc | container | thread). */
  sourceId: string;
  /** Paste destination: a container id, or `null` for the workspace root. */
  targetContainerId: string | null;
  /** Optional slot under the target; omit to append to the end. */
  sortOrder?: number;
}

/** Wire snapshot of the new top-level (pasted) node. */
interface CloneNodeSnapshot {
  id: string;
  kind: 'container' | 'doc' | 'thread';
  title: string;
  parentId: string | null;
  sortKey: string;
  createdAt: string;
  updatedAt: string;
}

interface CloneResult {
  /** The new top-level node created by the paste. */
  root: CloneNodeSnapshot;
  /** Total nodes created (root + every cloned descendant). */
  count: number;
}

export const cloneApi = {
  clone: (input: CloneInput) =>
    fetchData<CloneResult>(getApiUrl('/clone'), {
      method: 'POST',
      body: JSON.stringify({
        sourceId: input.sourceId,
        targetContainerId: input.targetContainerId,
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      }),
    }),
};
