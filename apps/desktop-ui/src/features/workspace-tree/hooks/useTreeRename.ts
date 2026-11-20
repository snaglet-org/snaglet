import { useState, type Dispatch, type SetStateAction } from 'react';
import { containersApi, docsApi, imagesApi, type LibraryTreeChild } from '../../../utils/api';
import { threadsApi } from '../../../utils/api/threads';
import { applyRenameToNode, emitLibraryEvent } from '../../../utils/workspaceEvents';
import { getErrorMessage } from '@snaglet/shared/utils';
import { labelOfNode } from '../treeUtils';

export interface UseTreeRenameArgs {
  /** Tree roots setter — used for the optimistic rename patch + revert. */
  setRoots: Dispatch<SetStateAction<LibraryTreeChild[] | null>>;
  /** Surfaces a rename failure without disturbing the tree. */
  reportError: (message: string) => void;
}

/**
 * Inline (double-click) rename for tree rows. Owns the `renamingId` state
 * that switches a row's label into an input, plus the commit pipeline:
 * trim → no-op on empty/unchanged → optimistic local patch via
 * `applyRenameToNode` → kind-appropriate API call → broadcast a
 * `library renamed` event so other surfaces (pane title, container
 * browser) stay in sync without a full refetch. The failure path reverts
 * the optimistic patch and reports the error.
 */
export function useTreeRename({ setRoots, reportError }: UseTreeRenameArgs) {
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const startRename = (id: string) => setRenamingId(id);
  const cancelRename = () => setRenamingId(null);

  /**
   * Commit a double-click rename. Trim → no-op on empty/unchanged → optimistic
   * local patch via `applyRenameToNode` → kind-appropriate API call → broadcast
   * `library renamed` so other surfaces (pane title, container browser) stay
   * in sync without a full refetch. Failure path reverts the optimistic patch
   * and reports the error.
   */
  const commitRename = async (node: LibraryTreeChild, rawValue: string) => {
    setRenamingId(null);
    const trimmed = rawValue.trim();
    const previous = labelOfNode(node);
    if (!trimmed || trimmed === previous) return;

    setRoots((prev) => {
      if (!prev) return prev;
      const next = prev.map((n) => applyRenameToNode(n, node.id, trimmed));
      return next.some((n, i) => n !== prev[i]) ? next : prev;
    });

    try {
      if (node.kind === 'container') {
        await containersApi.update(node.id, { name: trimmed });
      } else if (node.kind === 'doc') {
        await docsApi.update(node.id, { title: trimmed });
      } else if (node.kind === 'thread') {
        await threadsApi.rename(node.id, trimmed);
      } else if (node.kind === 'image') {
        // Renames the stored file too; refused if the image was renamed elsewhere.
        await imagesApi.rename(node.id, trimmed, node.name);
      }
      emitLibraryEvent({ type: 'renamed', kind: node.kind, id: node.id, name: trimmed });
    } catch (err) {
      setRoots((prev) => {
        if (!prev) return prev;
        const next = prev.map((n) => applyRenameToNode(n, node.id, previous));
        return next.some((n, i) => n !== prev[i]) ? next : prev;
      });
      reportError(`Rename failed: ${getErrorMessage(err)}`);
    }
  };

  return { renamingId, startRename, cancelRename, commitRename };
}
