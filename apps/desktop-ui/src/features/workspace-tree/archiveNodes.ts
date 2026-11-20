/**
 * Archiving workspace nodes from the tree — the row menu's Archive and the
 * Delete key — as one undoable step, with no confirmation.
 *
 * Each node archives through the generic archive route, one after another.
 * The archived rows leave every tree at once (`archive-changed`; a container
 * asks for a reload, since its archive cascades to children the local prune
 * cannot see). One toast names what went ("Archived “Plans”", "Archived 3
 * items") and its Undo restores every node of the step: an archived row keeps
 * its parent and slot, so each one comes back where it was.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { archiveApi, type LibraryTreeChild } from '@desktop/utils/api';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { showToast } from '@desktop/utils/toast';
import { labelOfNode, placementParentOf } from './treeUtils';

/** How long a refused archive or restore stays on screen. */
const ERROR_TOAST_MS = 6000;

function nameOf(node: LibraryTreeChild): string {
  return labelOfNode(node).trim() || 'Untitled';
}

function subjectOf(nodes: readonly LibraryTreeChild[]): string {
  return nodes.length === 1 ? `“${nameOf(nodes[0])}”` : `${nodes.length} items`;
}

/**
 * The nodes an archive of `nodes` has to send: a node under another node of
 * the same step (a doc in a selected folder, a thread in a selected project)
 * goes with that ancestor's cascade, and restores with it on undo.
 */
export function topmostNodes(
  nodes: readonly LibraryTreeChild[],
  nodeIndex: ReadonlyMap<string, LibraryTreeChild>
): LibraryTreeChild[] {
  const ids = new Set(nodes.map((node) => node.id));
  return nodes.filter((node) => {
    let parentId = placementParentOf(node);
    const seen = new Set<string>();
    while (parentId !== null && !seen.has(parentId)) {
      if (ids.has(parentId)) return false;
      seen.add(parentId);
      const parent = nodeIndex.get(parentId);
      parentId = parent ? placementParentOf(parent) : null;
    }
    return true;
  });
}

async function restoreNodes(nodes: readonly LibraryTreeChild[]): Promise<void> {
  const restored: string[] = [];
  for (const node of nodes) {
    try {
      await archiveApi.restore(node.id);
      restored.push(node.id);
    } catch (err) {
      showToast(`Couldn't restore “${nameOf(node)}”: ${getErrorMessage(err, 'restore failed')}`, {
        durationMs: ERROR_TOAST_MS,
      });
    }
  }
  // A restored node is in no local tree; only a reload brings it back.
  if (restored.length > 0) {
    emitLibraryEvent({ type: 'archive-changed', ids: restored, reload: true });
  }
}

/**
 * Archive `nodes` (already reduced to the topmost ones) and announce it with
 * an Undo. Resolves to the ids that left the tree; a refused node stays and
 * its refusal is a toast.
 */
export async function archiveNodesWithUndo(nodes: readonly LibraryTreeChild[]): Promise<string[]> {
  const archived: LibraryTreeChild[] = [];
  const gone: string[] = [];
  const refused: LibraryTreeChild[] = [];
  let firstError: string | null = null;
  for (const node of nodes) {
    try {
      const result = await archiveApi.archive(node.id);
      gone.push(node.id);
      // Archived elsewhere already: it leaves the tree, but an undo of this
      // step must not restore what someone else archived.
      if (!result.alreadyArchived) archived.push(node);
    } catch (err) {
      refused.push(node);
      firstError ??= getErrorMessage(err, 'archive failed');
    }
  }

  if (gone.length > 0) {
    emitLibraryEvent({
      type: 'archive-changed',
      ids: gone,
      reload: nodes.some((node) => gone.includes(node.id) && node.kind === 'container'),
    });
  }
  if (archived.length > 0) {
    showToast(`Archived ${subjectOf(archived)}`, {
      action: { label: 'Undo', run: () => void restoreNodes(archived) },
    });
  }
  if (refused.length > 0) {
    showToast(`Couldn't archive ${subjectOf(refused)}: ${firstError}`, {
      durationMs: ERROR_TOAST_MS,
    });
  }
  return gone;
}
