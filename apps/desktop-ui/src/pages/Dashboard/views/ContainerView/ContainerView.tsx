import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { type ContainerTreeNode, type LibraryTreeChild } from '@desktop/utils/api';
import type { ContainerCategory } from '@snaglet/shared/constants';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import { useDashboardNavigation } from '../../selection/DashboardNavigationContext';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { TREE_NODE_MIME, canDropInto, moveNodeInto, type TreeDragPayload } from './dnd';
import { recordMove, type UndoMoveItem } from '@desktop/features/workspace-tree/undo/workspaceUndo';
import { useWorkspaceUndoShortcuts } from '@desktop/features/workspace-tree/undo/useWorkspaceUndoShortcuts';
import type { MovableNodeKind } from '@desktop/features/workspace-tree/moveNode';
import { partitionThreads } from '@desktop/features/workspace-tree/treeUtils';
import { usePaneChromeActions } from '../../chrome/PaneChrome/PaneChrome';
import { IconsGlyph, ListGlyph } from '@desktop/components/Icons';
import { Segmented } from '@desktop/components';
import { IconsMode } from './IconsMode';
import {
  TreeContextMenu,
  type TreeContextMenuState,
} from '@desktop/features/workspace-tree/TreeContextMenu';
import { useTreeClipboard } from '@desktop/features/workspace-tree/hooks/useTreeClipboard';
import CreateMenu from './CreateMenu';
import { kindOrder, labelFor, RENAME_HANDLERS } from './helpers';
import type { ViewMode } from './IconsMode';
import styles from './ContainerView.module.scss';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { ContainerProperties } from './ContainerProperties';
import { useContainerContents } from './useContainerContents';
import { DetailsPanel } from './DetailsPanel/DetailsPanel';
import { PropertiesPanel } from '../shared/PropertiesPanel';
import { ArchiveNodeModal } from '@desktop/components/Modal';
import { ProjectPaneSection } from './ProjectPaneSection';
import { ProjectThreadsSection } from './ProjectThreadsSection';
import { ProjectTablesSection } from './ProjectTablesSection';

const VIEW_MODE_KEY = 'snaglet.dashboard.containerView';

// The ContainerView drives the shared clipboard helpers with the right-clicked
// node directly (never the tree's selection), so it feeds `useTreeClipboard`
// stable empty selection/index inputs. `enabled: false` skips the hook's global
// Cmd/Ctrl+C/V keydown listener — the sidebar tree already owns that gesture.
const EMPTY_SELECTED_IDS: Set<string> = new Set();
const EMPTY_NODE_INDEX: Map<string, LibraryTreeChild> = new Map();

// The container details (node Properties and, for project containers, the
// folder/git/description facets) live in a collapsible dropdown atop the
// contents grid. A project pane also puts a Threads section (its threads,
// scoped by `project_id`) and a Tables section (catalog entries linked to
// it) above the grid; a plain container has neither.

interface ContainerViewProps {
  container: ContainerTreeNode;
  /**
   * Fires when the user clicks any non-folder node (doc, thread,
   * project-root container, orphan project). The parent swaps the pane's
   * whole selection to that node's dedicated surface so the browser
   * doesn't try to inline-render content that isn't a folder. Drilling
   * into a regular sub-container also routes through this — the pane
   * chrome's path + history nav is the single source of navigation.
   */
  onOpenNode?: (node: LibraryTreeChild) => void;
  /**
   * When true, the Overview (project settings) tab is dropped — only the
   * Contents grid renders. Used by the synthetic Workspace-root view, which
   * has no project description or folder path to show.
   */
  hideOverview?: boolean;
  /**
   * Project panes only: opens a table listed in the Tables section. Defaults
   * to the dashboard navigation's `openTable`; hosts without a pane of their
   * own (the wiki-link preview) pass their own handler.
   */
  onOpenTable?: (table: TableCatalogEntry) => void;
}

/**
 * ContainerView — Finder-style folder view.
 *
 * Renders the current container's children as a grid (icons mode) or row
 * list (list mode). Right-click any item for the shared workspace context
 * menu (Rename, Duplicate, Copy, Paste, Archive) — the same `TreeContextMenu`
 * the sidebar tree uses. Inline rename commits via API and broadcasts a
 * library event so the sidebar and other panes update without a refetch;
 * Duplicate / Copy / Paste run through the shared clone helpers. Drag tiles
 * out to drop into another pane (same MIME the LibraryTree emits).
 */
const ContainerView: FC<ContainerViewProps> = ({
  container,
  onOpenNode,
  hideOverview = false,
  onOpenTable,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'icons';
    return window.localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'icons';
  });
  const [contextMenu, setContextMenu] = useState<TreeContextMenuState | null>(null);
  const [archiveNode, setArchiveNode] = useState<{
    id: string;
    type: string;
    label: string;
  } | null>(null);
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const { children, category } = useContainerContents(container);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  // Sidebar switched to a different container — drop any in-flight UI.
  useEffect(() => {
    setRenamingId(null);
    setContextMenu(null);
  }, [container.id]);

  // Auto-dismiss error toast.
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(t);
  }, [error]);

  // The details dropdown (node Properties + project facets) shows atop the
  // grid for every real container — suppressed only for the synthetic
  // workspace root, which has no details.
  const showDetails = !hideOverview;
  const isProject = category === 'project';

  // A project's threads arrive nested under it in the tree; they get their own
  // section instead of a slot in the folder/doc grid. `useContainerContents`
  // already strips threads from a plain container's children.
  const { threads, others: gridChildren } = useMemo(() => partitionThreads(children), [children]);
  // The Contents section folds after its first rows, so fold in the order the
  // grid draws them (folders before docs), not the payload's order.
  const contentsInOrder = useMemo(
    () => [...gridChildren].sort((a, b) => kindOrder(a) - kindOrder(b)),
    [gridChildren]
  );

  const nav = useDashboardNavigation();
  const navOpenTable = nav?.openTable;
  const openTable = useMemo<((table: TableCatalogEntry) => void) | undefined>(() => {
    if (onOpenTable) return onOpenTable;
    if (navOpenTable) return (table) => navOpenTable(table.id);
    return undefined;
  }, [navOpenTable, onOpenTable]);

  const viewToggle = useMemo(
    () => (
      <Segmented
        className={styles.viewToggle}
        size="sm"
        value={viewMode}
        onChange={(next) => setViewMode(next as ViewMode)}
        aria-label="View mode"
      >
        <Segmented.Option value="icons" aria-label="Icon view" title="Icon view">
          <IconsGlyph />
        </Segmented.Option>
        <Segmented.Option value="list" aria-label="List view" title="List view">
          <ListGlyph />
        </Segmented.Option>
      </Segmented>
    ),
    [viewMode]
  );

  // The icon/list view toggle lives at the top of the Properties panel. A
  // container view with no Properties panel (hideOverview, e.g. a project's
  // own tabs) keeps it in the pane topbar instead (see RightZoneActions), so
  // the mode can always be switched.

  const openContextMenu = (node: LibraryTreeChild, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Clamp to viewport so the menu doesn't overflow near edges.
    const MENU_W = 200;
    const MENU_H = 80;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setContextMenu({ node, x, y });
  };

  // Right-click on empty space inside the container view opens the
  // same Create menu (container / doc / thread / project) that the
  // sidebar tree's `+` button uses. Per-cell context menus already
  // call e.preventDefault(), so we only act when the event bubbles up
  // un-handled.
  const onShellContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const MENU_W = 220;
    const MENU_H = 200;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    setContextMenu(null);
    setCreateMenu({ x, y });
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TREE_NODE_MIME)) return;
    if (!e.shiftKey) {
      setIsDragOver(false);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // Shared move-into-target plumbing. Reads the chip payloads off a
  // DataTransfer, filters to movable kinds, fires the API moves, and
  // broadcasts a single archive-changed event so the sidebar tree + every
  // open ContainerView pane (including this one) refetches.
  const performMoveInto = useCallback(
    async (
      dataTransfer: DataTransfer,
      targetContainerId: string,
      targetCategory: ContainerCategory | null
    ) => {
      const raw = dataTransfer.getData(TREE_NODE_MIME);
      if (!raw) return;
      const parsed = safeJsonParse<TreeDragPayload | TreeDragPayload[] | undefined>(raw, undefined);
      if (parsed === undefined) return;
      const payloads = Array.isArray(parsed) ? parsed : [parsed];
      const candidates = payloads.filter((p) => p.id !== targetContainerId);
      const movable = candidates.filter((p) => canDropInto(p.kind, targetCategory));
      if (movable.length === 0) {
        // Nothing moved, but the user did drop something: say why rather
        // than swallowing the gesture.
        if (candidates.length > 0) {
          setError(
            candidates.every((p) => p.kind === 'thread')
              ? 'Threads can only be moved into a project'
              : 'These items cannot be moved here'
          );
        }
        return;
      }
      try {
        for (const p of movable) {
          await moveNodeInto(p, targetContainerId);
        }
        // Arm undo when every payload carries its dragstart placement (the
        // exact inverse). A partial capture would undo some rows and strand
        // the rest, so it's all-or-nothing.
        const captured = movable.map((p): UndoMoveItem | null =>
          p.parentId !== undefined && typeof p.sortOrder === 'number'
            ? {
                id: p.id,
                kind: p.kind as MovableNodeKind,
                label: p.label ?? p.id,
                from: { parentId: p.parentId, sortOrder: p.sortOrder },
                to: { parentId: targetContainerId },
              }
            : null
        );
        if (captured.every((c): c is UndoMoveItem => c !== null)) {
          recordMove(captured);
        }
        emitLibraryEvent({ type: 'archive-changed', ids: movable.map((p) => p.id) });
      } catch (err) {
        setError(getErrorMessage(err, 'Move failed'));
      }
    },
    []
  );

  const onDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      setIsDragOver(false);
      if (!e.shiftKey) return;
      if (!e.dataTransfer.types.includes(TREE_NODE_MIME)) return;
      e.preventDefault();
      await performMoveInto(e.dataTransfer, container.id, category);
    },
    [container.id, category, performMoveInto]
  );

  // Per-cell drop — fires when a chip is shift-dropped on a container icon
  // inside this view. Target is the cell's container id, not the surrounding
  // pane's container id, so the moved node lands one level deeper.
  const onDropIntoChild = useCallback(
    async (dataTransfer: DataTransfer, targetContainerId: string) => {
      const target = children.find((node) => node.id === targetContainerId);
      const targetCategory = target?.kind === 'container' ? (target.category ?? null) : null;
      await performMoveInto(dataTransfer, targetContainerId, targetCategory);
    },
    [children, performMoveInto]
  );

  // Copy / Paste / Duplicate reuse the same server clone helpers the sidebar
  // tree uses, driven with the right-clicked node directly. A paste or
  // duplicate emits `tree-invalidated` (via the setReloadKey adapter) so this
  // pane's refetch effect and the sidebar tree refetch and show the clone.
  const { copyNode, pasteRelativeTo, duplicateNode, canPaste } = useTreeClipboard({
    selectedIds: EMPTY_SELECTED_IDS,
    selectionAnchorId: null,
    nodeIndex: EMPTY_NODE_INDEX,
    setReloadKey: () => emitLibraryEvent({ type: 'tree-invalidated', ids: [] }),
    setError,
    enabled: false,
  });

  // Cmd/Ctrl+Z structural undo — shares the sidebar tree's single history
  // and window listener (refcounted inside the hook), so this pane keeps
  // the shortcut alive even when the sidebar is on a non-library view.
  useWorkspaceUndoShortcuts();

  const commitRename = async (node: LibraryTreeChild, rawValue: string) => {
    setRenamingId(null);
    const trimmed = rawValue.trim();
    if (!trimmed || trimmed === labelFor(node)) return;

    const handler = RENAME_HANDLERS[node.kind];
    if (!handler) return;

    try {
      await handler(node.id, trimmed);
      // Dashboard's mapSelections rebroadcasts into every pane's selection
      // + history, which patches the rendered container snapshot. The
      // pane-level handler is the single source of truth — no local update.
      emitLibraryEvent({ type: 'renamed', kind: node.kind, id: node.id, name: trimmed });
    } catch (err) {
      setError(getErrorMessage(err, 'Rename failed'));
    }
  };

  const renderGrid = (nodes: readonly LibraryTreeChild[]) => (
    <IconsMode
      container={container}
      children={nodes}
      viewMode={viewMode}
      renamingId={renamingId}
      onNavigateInto={(node) => onOpenNode?.(node)}
      onContextMenu={openContextMenu}
      onCommitRename={commitRename}
      onCancelRename={() => setRenamingId(null)}
      onDropIntoChild={onDropIntoChild}
    />
  );
  // Collapsible details dropdown atop the grid. Project containers get the
  // DetailsPanel — one unified dropdown with folder/git/description; every
  // other container gets the compact Properties dropdown. Both scroll with the
  // grid inside the body.
  const propertiesPanel = !showDetails ? null : (
    <>
      <div className={styles.viewRow}>
        <span className={styles.viewRowLabel}>View</span>
        {viewToggle}
      </div>
      {isProject ? (
        <DetailsPanel projectId={container.id} alwaysExpanded flat />
      ) : (
        <ContainerProperties containerId={container.id} />
      )}
    </>
  );

  const shell = (
    <div
      className={`${styles.shell}${isDragOver ? ` ${styles.dragOver}` : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={onShellContextMenu}
    >
      <div className={styles.body}>
        {isProject ? (
          <>
            {/* Scoped content first — the project's threads, then its linked
                tables — matching the sidebar; the folder/doc grid follows. */}
            {/* Side by side once the pane is wide, so the two lists share the
                height instead of stacking. */}
            <div className={styles.sectionPairHost}>
              <div className={styles.sectionPair}>
                <ProjectThreadsSection
                  threads={threads}
                  renamingId={renamingId}
                  onOpen={(thread) => onOpenNode?.(thread)}
                  onContextMenu={openContextMenu}
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenamingId(null)}
                />
                <ProjectTablesSection projectId={container.id} onOpenTable={openTable} />
              </div>
            </div>
            <ProjectPaneSection
              title="Contents"
              items={contentsInOrder}
              empty="No containers or docs in this project."
              keepVisible={(node) => node.id === renamingId}
            >
              {renderGrid}
            </ProjectPaneSection>
          </>
        ) : (
          renderGrid(gridChildren)
        )}
      </div>

      {contextMenu && (
        <TreeContextMenu
          state={contextMenu}
          canPaste={canPaste}
          onClose={() => setContextMenu(null)}
          onRename={() => setRenamingId(contextMenu.node.id)}
          onDuplicate={() => void duplicateNode(contextMenu.node)}
          onCopy={() => copyNode(contextMenu.node)}
          onPaste={() => void pasteRelativeTo(contextMenu.node)}
          onArchive={() =>
            setArchiveNode({
              id: contextMenu.node.id,
              type: contextMenu.node.kind,
              label: labelFor(contextMenu.node),
            })
          }
        />
      )}

      {archiveNode && (
        <ArchiveNodeModal
          node={archiveNode}
          onArchived={({ node: archived, affected: _ }) => {
            setArchiveNode(null);
            if (archived) {
              emitLibraryEvent({
                type: 'archive-changed',
                ids: [archived.id],
                reload: archived.type === 'container',
              });
            }
          }}
          onCancel={() => setArchiveNode(null)}
        />
      )}

      {createMenu && (
        <CreateMenu
          x={createMenu.x}
          y={createMenu.y}
          parentContainerId={container.id}
          parentCategory={category}
          onClose={() => setCreateMenu(null)}
          onError={(message) => setError(message)}
        />
      )}

      {error && (
        <div className={styles.errorToast} role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
  // Properties pull out from the side (top in a skinny pane); hideOverview
  // callers (e.g. the project's own tabs) get the bare grid.
  return propertiesPanel ? (
    <PropertiesPanel
      ariaLabel={isProject ? 'Project properties' : 'Container properties'}
      panel={propertiesPanel}
    >
      {shell}
    </PropertiesPanel>
  ) : (
    <>
      <RightZoneActions actions={viewToggle} />
      {shell}
    </>
  );
};

export { ContainerView };

/** Registers right-edge topbar controls; mounted only when no PropertiesPanel owns the zone. */
const RightZoneActions: FC<{ actions: ReactNode }> = ({ actions }) => {
  usePaneChromeActions(actions, { zone: 'right' });
  return null;
};
