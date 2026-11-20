import { type FC } from 'react';
import { WorkspaceTree } from '@desktop/features/workspace-tree';
import type { FileTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import type { PaletteSearchHit } from '@desktop/utils/api/palette-search';
import styles from './SidebarView.module.scss';

interface WorkspaceViewProps {
  onNodeClick: (node: LibraryTreeChild | FileTreeNode) => void;
  /**
   * Node id currently focused in the dashboard's active pane.
   * Forwarded to the tree as `activeNodeId` so the matching row
   * renders with the active-pane highlight.
   */
  activeNodeId?: string | null;
  /** Catalog id of the table in the active pane; its Tables group row gets the active highlight. */
  activeTableId?: string | null;
  /**
   * Set of node ids currently open in any pane. Forwarded to the tree
   * as `openNodeIds` so every matching row renders the "open in a pane"
   * indicator, independent of which pane holds focus.
   */
  openNodeIds?: Set<string>;
  /**
   * When this id changes to a non-null value the tree expands every
   * ancestor container along its path and scrolls the row into view.
   * Used when the user opens a node from the icon pane / deep link.
   */
  revealNodeId?: string | null;
  /**
   * Bumped by the dashboard on every reveal request so the tree re-runs
   * its reveal effect even when the requested id is unchanged.
   */
  revealNonce?: number;
  /** Bumped when realtime workspace events should force the tree to refetch. */
  refreshNonce?: number;
  /**
   * Search-result handoff for a hit owned by another sidebar view (a tool or
   * agent): the dashboard switches the sidebar tab, relays the reveal, and
   * opens the item in the active pane, dispatching on the full hit's `kind`.
   */
  onCrossViewReveal?: (view: string, hit: PaletteSearchHit) => void;
  /**
   * Fires when the user picks a library-kind search hit. Lets the
   * dashboard switch the sidebar tab back to library so the tree body
   * is visible when the pane opens.
   */
  onLibraryHit?: (hit: PaletteSearchHit) => void;
  /**
   * Compact mode: WorkspaceTree renders just its search widget — no
   * header, no tree body, no picker. Used when this view is hoisted
   * above the sidebar's per-view panel so the search bar persists
   * across other views.
   */
  hideBody?: boolean;
}

/**
 * Sidebar view for the workspace tree. WorkspaceTree owns its header (with a
 * `+` for new at root); this wrapper gives it the flex-fill chrome every
 * sidebar view uses.
 */
export const WorkspaceView: FC<WorkspaceViewProps> = ({
  onNodeClick,
  activeNodeId = null,
  activeTableId = null,
  openNodeIds,
  revealNodeId = null,
  revealNonce = 0,
  refreshNonce = 0,
  onCrossViewReveal,
  onLibraryHit,
  hideBody = false,
}) => (
  <section
    className={`${styles.root} ${hideBody ? styles.rootCompact : ''}`}
    aria-label="Workspace"
  >
    <WorkspaceTree
      onNodeClick={onNodeClick}
      activeNodeId={activeNodeId}
      activeTableId={activeTableId}
      openNodeIds={openNodeIds}
      revealNodeId={revealNodeId}
      revealNonce={revealNonce}
      refreshNonce={refreshNonce}
      onCrossViewReveal={onCrossViewReveal}
      onLibraryHit={onLibraryHit}
      hideBody={hideBody}
    />
  </section>
);
