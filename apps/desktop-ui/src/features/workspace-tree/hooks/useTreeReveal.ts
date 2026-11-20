import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '../../../utils/api';
import { findNodeAncestorIds } from '@desktop/pages/Dashboard/chrome/PathHeader/nodeAncestors';
import {
  ROOT_ITEMS_GROUP_ID,
  findNodeInRoots,
  isProjectNode,
  tablesGroupId,
  threadsGroupId,
} from '../treeUtils';
import styles from '../WorkspaceTree.module.scss';

export interface UseTreeRevealArgs {
  /** Scroll container for the tree body — rows are located via `data-row-id`. */
  treeRef: RefObject<HTMLDivElement | null>;
  /** Loaded tree roots — reveal is a no-op until the tree is in. */
  roots: LibraryTreeChild[] | null;
  /** External reveal target (from the dashboard / deep links). */
  revealNodeId: string | null;
  /** Monotonic counter so repeat reveals of the same id re-fire. */
  revealNonce: number;
  /** Internal reveal target from the tree search widget — takes precedence. */
  searchRevealId: string | null;
  searchRevealNonce: number;
  /** Expands every ancestor container on the target's path (and a thread's Threads group). */
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  /**
   * The catalog tables the Tables groups draw (`null` before the catalog
   * loads). A catalog table is not a tree node: it is revealed inside the
   * Tables group of its project (or the workspace Tables group when
   * unlinked). A table missing here stays pending, like a node not in the
   * tree. Optional for owners without tables.
   */
  tables?: TableCatalogEntry[] | null;
}

/**
 * Auto-reveal: when the dashboard (or the tree's own search widget) says an
 * node was opened from outside the tree — icon pane, deep link, breadcrumb,
 * search hit — walk up its ancestor chain, expand every container along the
 * path (for a thread, also the Threads group it is listed under), scroll the
 * row into view if it isn't already fully visible (stealing
 * the viewport for something on-screen is disorienting), and pulse-highlight
 * it so the user gets a "this is where you are" confirmation either way.
 *
 * Each request is identified by its nonce and acted on exactly once. The
 * target ids stay set after a reveal, and `roots` changes on every tree
 * refresh (a doc autosave, a rename, an agent edit); re-running on those
 * would keep re-expanding the tree and dragging the viewport back to an old
 * row. A request whose node is not in the tree yet stays pending until a
 * later `roots` contains it.
 */
export function useTreeReveal({
  treeRef,
  roots,
  revealNodeId,
  revealNonce,
  searchRevealId,
  searchRevealNonce,
  setExpanded,
  tables = null,
}: UseTreeRevealArgs) {
  // Nonces already acted on. Seeded with the mount-time values: a request
  // made before this tree mounted was either handled by a previous mount or
  // is replayed with a fresh nonce by the dashboard once the view is shown.
  const handledRef = useRef({ search: searchRevealNonce, reveal: revealNonce });
  // The scroll/pulse frame belongs to the request, not to one effect run: a
  // tree refresh landing in the same frame must not cancel it.
  const frameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    },
    []
  );

  useEffect(() => {
    const handled = handledRef.current;
    // Both sources can have a pending request; the search widget's is the
    // user's latest gesture inside the tree, so it wins.
    const searchPending = searchRevealId !== null && handled.search !== searchRevealNonce;
    const revealPending = revealNodeId !== null && handled.reveal !== revealNonce;
    const effectiveRevealId = searchPending ? searchRevealId : revealPending ? revealNodeId : null;
    if (!effectiveRevealId || !roots) return;
    const toExpand = pathToExpand(roots, tables, effectiveRevealId);
    if (toExpand === null) return; // not in the tree yet — stay pending
    handledRef.current = { search: searchRevealNonce, reveal: revealNonce };
    if (toExpand.length > 0) {
      setExpanded((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of toExpand) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    // Wait a frame for the newly-expanded rows to render, then locate +
    // pulse the target row. Row may be keyed by node id (containers /
    // docs / threads) or by project id (project-home rows render the
    // container that *holds* the project; we tag both attrs to make
    // either lookup work).
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const root = treeRef.current;
      if (!root) return;
      const row =
        root.querySelector<HTMLElement>(`[data-row-id="${effectiveRevealId}"]`) ??
        root.querySelector<HTMLElement>(`[data-project-id="${effectiveRevealId}"]`) ??
        root.querySelector<HTMLElement>(`[data-table-id="${effectiveRevealId}"]`);
      if (!row) return;
      // Skip scroll if the row is already fully visible inside the
      // scrollable tree viewport — don't steal the user's place.
      const viewport = root;
      const rowRect = row.getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      const fullyVisible = rowRect.top >= vpRect.top && rowRect.bottom <= vpRect.bottom;
      if (!fullyVisible) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      // Pulse: add class, force reflow, remove after animation completes.
      // Animation duration kept in lock-step with the SCSS keyframes.
      row.classList.remove(styles.revealed ?? 'revealed');
      void row.offsetWidth;
      row.classList.add(styles.revealed ?? 'revealed');
      window.setTimeout(() => {
        row.classList.remove(styles.revealed ?? 'revealed');
      }, 1400);
    });
  }, [revealNodeId, revealNonce, searchRevealId, searchRevealNonce, roots, tables]);
}

/**
 * Expansion keys on the way to `id`: every ancestor container, plus the
 * generated group it is listed under — a thread's Threads group, the
 * workspace Docs & context group for anything under a top-level row that is
 * not a project, or, for a catalog table, its project row and Tables group
 * (the workspace Tables group when it is unlinked). `null` when the tree
 * does not hold it yet.
 */
function pathToExpand(
  roots: LibraryTreeChild[],
  tables: TableCatalogEntry[] | null,
  id: string
): string[] | null {
  const ancestorIds = findNodeAncestorIds(roots, id);
  if (ancestorIds !== null) {
    const target = findNodeInRoots(roots, id);
    if (target?.kind === 'thread') return [...ancestorIds, threadsGroupId(target.projectId)];
    const topLevel = roots.find((node) => node.id === (ancestorIds[0] ?? id));
    return topLevel && !isProjectNode(topLevel)
      ? [ROOT_ITEMS_GROUP_ID, ...ancestorIds]
      : ancestorIds;
  }
  const table = tables?.find((entry) => entry.id === id);
  if (!table) return null;
  if (table.projectId === null) return [tablesGroupId(null)];
  const projectAncestors = findNodeAncestorIds(roots, table.projectId);
  if (projectAncestors === null) return null;
  return [...projectAncestors, table.projectId, tablesGroupId(table.projectId)];
}
