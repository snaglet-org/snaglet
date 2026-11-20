import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { LibraryTreeChild } from '../../utils/api';
import { groupTablesByProject, sortTablesByOrder } from '@desktop/features/database/tableGroups';
import { useTableCatalog } from '@desktop/features/database/useTableCatalog';
import { useTableProjectLink } from '@desktop/features/database/useTableProjectLink';
import { useFluidZoom } from '@desktop/hooks/useFluidZoom';
import { useDashboardNavigation } from '@desktop/pages/Dashboard/selection/DashboardNavigationContext';
import { SIDEBAR_ZOOM } from '@desktop/styles/typeScale';
import { showToast } from '@desktop/utils/toast';
import { archiveNodesWithUndo, topmostNodes } from './archiveNodes';
import { partitionRootNodes, partitionThreads } from './treeUtils';
import { tableEntryState } from '@desktop/features/database/tableLifecycle';
import { CreateKindPicker } from './CreateKindPicker';
import { DraftRow } from './DraftRow';
import { RootItemsGroup } from './RootItemsGroup';
import { ThreadAgentPickerModal } from './ThreadAgentPickerModal';
import { TablesGroup } from './TablesGroup';
import { ThreadsGroup } from './ThreadsGroup';
import { TreeContextMenu, type TreeContextMenuState } from './TreeContextMenu';
import { TreeHeader } from './TreeHeader';
import { TreeRow, type TreeRowSharedProps } from './TreeRow';
import { TreeSearchWidget } from './TreeSearchWidget';
import { focusTreeStopAt, handleTreeNavigationKey, treeStopIndex } from './treeKeyboard';
import styles from './WorkspaceTree.module.scss';
import { type WorkspaceTreeProps } from './types';
import { useAutoScrollWhileDragging } from './useAutoScrollWhileDragging';
import { useWorkspaceTreeSearch } from './useWorkspaceTreeSearch';
import { useTreeClipboard } from './hooks/useTreeClipboard';
import { useTreeCreator } from './hooks/useTreeCreator';
import { useTreeDrag } from './hooks/useTreeDrag';
import { useSidebarDisclosure } from './hooks/useSidebarDisclosure';
import { useTreeExpansion } from './hooks/useTreeExpansion';
import { useTreeFileImport } from './hooks/useTreeFileImport';
import { useTreeLazyData } from './hooks/useTreeLazyData';
import { useTreeLibraryEvents } from './hooks/useTreeLibraryEvents';
import { useTreeRename } from './hooks/useTreeRename';
import { useTreeReveal } from './hooks/useTreeReveal';
import { useWorkspaceTreeSelection } from './hooks/useWorkspaceTreeSelection';
import { useWorkspaceTreeRoots } from './hooks/useWorkspaceTreeRoots';
import { useWorkspaceUndoShortcuts } from './undo/useWorkspaceUndoShortcuts';

/** How long a failed tree action (rename, create, move, paste) stays on screen. */
const ACTION_ERROR_TOAST_MS = 6000;

/**
 * Focus the tree item of node `id`, but only when nothing holds focus (it
 * went down with an unmounted input): focus the user moved elsewhere stays.
 */
function focusRowIfFocusLost(tree: HTMLElement | null, id: string): void {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  tree?.querySelector(`[data-row-id="${id}"]`)?.closest<HTMLElement>('[role="treeitem"]')?.focus();
}

/**
 * The workspace sidebar tree: navigation, search, drag-and-drop, clipboard
 * and inline create. Renders containers (projects are containers with
 * `category === 'project'`), docs, images and a project's on-disk files.
 * Threads and tables are not tree rows: each project, and the workspace
 * root, shows generated Threads and Tables groups.
 *
 * Create opens an inline draft row (Enter saves, Escape or blur cancels);
 * a thread then needs an agent picked, and a table opens the table draft
 * pane. Archive never confirms: the toast offers Undo. Failed actions show a
 * toast and leave the tree in place; only a failed initial load replaces it.
 */
export function WorkspaceTree({
  onNodeClick,
  activeNodeId = null,
  activeTableId = null,
  openNodeIds,
  revealNodeId = null,
  revealNonce = 0,
  onCrossViewReveal,
  onLibraryHit,
  hideBody = false,
  refreshNonce = 0,
}: WorkspaceTreeProps) {
  const nav = useDashboardNavigation();
  const { roots, setRoots, error, setReloadKey, loadedReloadKey } =
    useWorkspaceTreeRoots(refreshNonce);
  const reportActionError = useCallback((message: string | null) => {
    if (message) showToast(message, { durationMs: ACTION_ERROR_TOAST_MS });
  }, []);
  // Scroll container for the tree body — used by the reveal effect to
  // scroll a freshly-opened node into view via `data-row-id` lookup. The
  // element is also kept in state, so the drag auto-scroller re-attaches
  // each time the body mounts again.
  const treeRef = useRef<HTMLDivElement | null>(null);
  const [treeEl, setTreeEl] = useState<HTMLDivElement | null>(null);
  const attachTree = useCallback((el: HTMLDivElement | null) => {
    treeRef.current = el;
    setTreeEl(el);
  }, []);
  // The body unmounts while hidden (another sidebar view or the Database
  // mode is showing); remember its scroll offset so it comes back in place.
  const savedScrollTopRef = useRef(0);

  const { expanded, setExpanded, toggle, expandedThreadAgentGroups, toggleThreadAgentGroup } =
    useTreeExpansion({ roots });

  // Ref mirror of `nodeIndex` (declared later) so search-result handlers defined
  // above the memo can resolve a node to open without a temporal-dead-zone ref.
  const nodeIndexRef = useRef<Map<string, LibraryTreeChild>>(new Map());
  // When a search result is selected, or the draft row creates a node, before
  // the node is in the tree index (ancestors not loaded, refetch in flight),
  // we stash its id here. The nodeIndex sync effect below flushes the open
  // once the node becomes resolvable.
  const pendingOpenIdRef = useRef<string | null>(null);
  // The pending open is a node the draft row created: its row takes the focus
  // the draft input lost, as a clicked row holds it.
  const focusCreatedIdRef = useRef<string | null>(null);
  const search = useWorkspaceTreeSearch({
    onNodeClick,
    onOpenEntry: nav?.openTableEntry,
    onOpenTable: nav?.openTable,
    onCrossViewReveal,
    onLibraryHit,
    nodeIndexRef,
    pendingOpenIdRef,
  });
  const { searchRevealId, searchRevealNonce } = search;
  useAutoScrollWhileDragging(treeEl);

  const bodyMounted = !hideBody && roots !== null;
  useLayoutEffect(() => {
    if (bodyMounted && treeRef.current) treeRef.current.scrollTop = savedScrollTopRef.current;
  }, [bodyMounted]);

  // Fluid sidebar zoom fallback: `.shell > *` carries a pure-CSS
  // `zoom: clamp(…)` by the shell's width (WorkspaceTree.module.scss); on
  // an engine that can't evaluate it, this writes `--sidebar-zoom` inline.
  const shellRef = useRef<HTMLDivElement>(null);
  useFluidZoom(shellRef, '--sidebar-zoom', SIDEBAR_ZOOM);

  // Keyed on the reload the shown tree came from, so the lazy caches drop
  // once per tree refetch that lands, not once per invalidation event.
  const { projectFiles, threadAgents } = useTreeLazyData({
    roots,
    expanded,
    reloadKey: loadedReloadKey,
  });

  useTreeLibraryEvents({ setRoots, setReloadKey });

  // Index for descendant checks during DnD.
  const nodeIndex = useMemo(() => {
    const idx = new Map<string, LibraryTreeChild>();
    const walk = (nodes: LibraryTreeChild[] | undefined) => {
      if (!nodes) return;
      for (const n of nodes) {
        idx.set(n.id, n);
        if (n.kind === 'container') walk(n.children);
      }
    };
    walk(roots ?? []);
    return idx;
  }, [roots]);

  useSidebarDisclosure({ shellRef, hideBody, nodeIndex, expanded, setExpanded });

  // Catalog tables for the Tables groups: per project (linked tables) and,
  // at the root, the workspace group of the user's own unlinked tables. The
  // catalog is fetched while the tree body shows; it then stays cached and
  // follows table events (link, rename, archive) like the Database sidebar,
  // so every group repaints at once.
  const { tables } = useTableCatalog(!hideBody);
  const { tablesByProject, workspaceTables, tableIndex, drawnTables } = useMemo(() => {
    const index = new Map<string, TableCatalogEntry>();
    if (!tables) {
      return { tablesByProject: null, workspaceTables: null, tableIndex: index, drawnTables: null };
    }
    const groups = groupTablesByProject(tables);
    // Built-ins are workspace-wide by definition, not "unlinked".
    const unlinked = sortTablesByOrder(
      groups.workspace.filter(
        (table) => table.origin === 'custom' && tableEntryState(table) === 'active'
      )
    );
    const byProject = new Map<string, TableCatalogEntry[]>();
    for (const [project, rows] of groups.byProject) byProject.set(project, sortTablesByOrder(rows));
    for (const table of unlinked) index.set(table.id, table);
    for (const rows of byProject.values()) for (const table of rows) index.set(table.id, table);
    return {
      tablesByProject: byProject,
      workspaceTables: unlinked,
      tableIndex: index,
      drawnTables: [...index.values()],
    };
  }, [tables]);

  // Reveal only the tables the Tables groups draw: a built-in table has no
  // row, so its reveal must not open a group to show nothing.
  useTreeReveal({
    treeRef,
    roots,
    revealNodeId,
    revealNonce,
    searchRevealId,
    searchRevealNonce,
    setExpanded,
    tables: drawnTables,
  });
  // A table chip dropped on a project row links through the shared link
  // mutation (the table pane's picker uses it too); its refusal surfaces as
  // an action toast here.
  const { setProject: linkTable } = useTableProjectLink({ onError: reportActionError });

  // Keep the ref in sync so early-defined search handlers can resolve nodes.
  // Also flush any pending open (a search pick, a created node): its node may
  // not yet be in the index (ancestors still loading, the refetch after a
  // create in flight). Once the index updates and the node resolves, open it
  // in the pane.
  useEffect(() => {
    nodeIndexRef.current = nodeIndex;
    const pendingId = pendingOpenIdRef.current;
    if (pendingId) {
      const node = nodeIndex.get(pendingId);
      if (node) {
        pendingOpenIdRef.current = null;
        if (focusCreatedIdRef.current === pendingId) {
          focusCreatedIdRef.current = null;
          focusRowIfFocusLost(treeRef.current, pendingId);
        }
        onNodeClick?.(node);
      }
    }
  }, [nodeIndex, onNodeClick]);

  const {
    selectedIds,
    setSelectedIds,
    selectionAnchorId,
    setSelectionAnchorId,
    visibleOrderIndex,
    clickRow,
    clickTable,
  } = useWorkspaceTreeSelection({
    roots,
    expanded,
    tablesByProject,
    workspaceTables,
    onNodeClick,
  });

  /**
   * A node the draft row created opens as a plain click on its new row
   * would: the row is selected and the node opens in the active pane through
   * `onNodeClick`. The open waits for the refetch the create bumps, which
   * brings the node into the index.
   */
  const openCreatedNode = (id: string) => {
    setSelectedIds(new Set([id]));
    setSelectionAnchorId(id);
    focusCreatedIdRef.current = id;
    pendingOpenIdRef.current = id;
  };

  // Cmd/Ctrl+C copy + Cmd/Ctrl+V paste of the selected node (recursive clone
  // via the server). Disabled in search-only mode (no tree body to act on).
  // The node-targeted helpers back the right-click context menu below, so the
  // menu and the keyboard gesture share one stash/clone code path.
  const { copyNode, pasteRelativeTo, duplicateNode, canPaste } = useTreeClipboard({
    selectedIds,
    selectionAnchorId,
    nodeIndex,
    setReloadKey,
    setError: reportActionError,
    enabled: !hideBody,
  });

  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z structural undo — shares one history and
  // one window listener with any open ContainerView panes (see the hook).
  // Disabled in search-only mode, mirroring the clipboard gesture above.
  useWorkspaceUndoShortcuts(!hideBody);

  // Right-click context menu (Rename / Duplicate / Copy / Paste / Archive) for
  // tree rows — the shared menu also used by the ContainerView folder grid.
  const [rowMenu, setRowMenu] = useState<TreeContextMenuState | null>(null);
  // The menu keeps itself on screen from its measured size (ContextMenu).
  const openRowContextMenu = useCallback((node: LibraryTreeChild, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRowMenu({ node, x: e.clientX, y: e.clientY });
  }, []);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);

  // Keyboard stop the first archived row held, so focus can land on the row
  // that takes its place once the prune re-renders the tree.
  const refocusIndexRef = useRef<number | null>(null);
  // Layout effect: focus lands in the same commit that removed the rows.
  useLayoutEffect(() => {
    const index = refocusIndexRef.current;
    const tree = treeRef.current;
    if (index === null || !tree) return;
    refocusIndexRef.current = null;
    // Only when focus went down with the row — never pull it back from
    // wherever the user has moved on to.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusTreeStopAt(tree, index);
  }, [roots]);

  /**
   * Archive `node` — or, when `withSelection` and the row is part of a
   * multi-selection, every selected node — with an Undo instead of a
   * confirmation. Rows nested under another archived row go with its cascade.
   */
  const archiveRows = (node: LibraryTreeChild, withSelection: boolean) => {
    const ids =
      withSelection && selectedIds.has(node.id) && selectedIds.size > 1
        ? [...selectedIds]
        : [node.id];
    const nodes = topmostNodes(
      ids.flatMap((id) => nodeIndex.get(id) ?? []),
      nodeIndex
    );
    if (nodes.length === 0) return;
    const tree = treeRef.current;
    const rowItem = tree?.querySelector(`[data-row-id="${node.id}"]`)?.closest('[role="treeitem"]');
    refocusIndexRef.current = tree && rowItem ? treeStopIndex(tree, rowItem) : null;
    void archiveNodesWithUndo(nodes).then((gone) => {
      if (gone.length === 0) {
        refocusIndexRef.current = null;
        return;
      }
      const goneIds = new Set(gone);
      setSelectedIds((prev) => {
        const next = new Set([...prev].filter((id) => !goneIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setSelectionAnchorId((prev) => (prev !== null && goneIds.has(prev) ? null : prev));
    });
  };

  const {
    dragSourceRef,
    hoverTargetId,
    hoverZone,
    setHoverTargetId,
    setHoverZone,
    isDescendant,
    handleDrop,
    handleThreadScopeDrop,
    handleTableScopeDrop,
    handleTableRowDrop,
    handleTableDrop,
  } = useTreeDrag({
    nodeIndex,
    visibleOrderIndex,
    expanded,
    reportError: reportActionError,
    setReloadKey,
    tables,
    tableIndex,
    linkTable,
  });

  const { rootFileDragOver, setRootFileDragOver, handleFileDrop } = useTreeFileImport({
    setHoverTargetId,
    setHoverZone,
  });

  const { renamingId, startRename, cancelRename, commitRename } = useTreeRename({
    setRoots,
    reportError: reportActionError,
  });

  const {
    creator,
    draftInputRef,
    pendingThread,
    creatableKinds,
    openPicker,
    selectKind,
    startScopedDraft,
    cancelCreator,
    commitCreator,
    cancelPendingThread,
    commitPendingThread,
  } = useTreeCreator({
    setExpanded,
    setReloadKey,
    reportError: reportActionError,
    openTable: nav?.openTable,
    onCreated: openCreatedNode,
  });

  // One bundle of tree-wide row props, spread into every row and group.
  const rowProps: TreeRowSharedProps = {
    expanded,
    onToggle: toggle,
    clickRow,
    clickTable,
    selectedIds,
    nodeIndex,
    tableIndex,
    visibleOrderIndex,
    dragSourceRef,
    hoverTargetId,
    hoverZone,
    setHoverTargetId,
    setHoverZone,
    handleDrop,
    handleThreadScopeDrop,
    handleTableScopeDrop,
    handleTableRowDrop,
    handleTableDrop,
    handleFileDrop,
    isDescendant,
    openPicker,
    creator,
    draftInputRef,
    commitCreator,
    cancelCreator,
    // Tables offer an inline + only where a new table can be opened afterward.
    startScopedDraft: nav?.openTable ? startScopedDraft : undefined,
    renamingId,
    startRename,
    commitRename,
    cancelRename,
    projectFiles,
    tablesByProject,
    onNodeClick,
    threadAgents,
    expandedThreadAgentGroups,
    toggleThreadAgentGroup,
    activeNodeId,
    activeTableId,
    openNodeIds,
    onRowContextMenu: openRowContextMenu,
    onArchiveRow: (node) => archiveRows(node, true),
  };

  // Flat threads leave the root row list for the workspace Threads group;
  // projects stay flat at the top and every other top-level row moves into
  // the workspace "Docs & context" group; unlinked tables (never tree nodes)
  // follow in the workspace Tables group.
  const { threads: flatThreads, others: rootNodes } = partitionThreads(roots ?? []);
  const { projects: rootProjects, items: rootItems } = partitionRootNodes(rootNodes);

  const headerBar = (
    <TreeHeader
      label="Workspace"
      addTitle="New at root"
      addLabel="Create at root"
      onAdd={(anchor) => openPicker(null, anchor)}
    />
  );

  // With no nodes the workspace can still hold unlinked tables or a row being
  // named at the root; their groups must stay drawn.
  const draftingAtRoot = creator?.stage === 'editing' && creator.parentContainerId === null;
  const workspaceIsEmpty =
    roots !== null && roots.length === 0 && !draftingAtRoot && (workspaceTables?.length ?? 0) === 0;

  let body: React.ReactNode;
  if (roots === null) {
    body = error ? (
      <div className={styles.error} role="alert">
        {error}
      </div>
    ) : (
      <div className={styles.loading}>Loading…</div>
    );
  } else if (workspaceIsEmpty) {
    body = <div className={styles.empty}>Workspace is empty</div>;
  } else {
    body = (
      <div
        ref={attachTree}
        className={[
          styles.tree,
          // Whole-box glow while a file drag targets root whitespace.
          rootFileDragOver && hoverTargetId === null ? styles.treeRootDropTarget : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="tree"
        onKeyDown={handleTreeNavigationKey}
        onScroll={(e) => {
          savedScrollTopRef.current = e.currentTarget.scrollTop;
        }}
        onMouseDown={(e) => {
          // A click on the tree's empty background clears the
          // multi-selection; clicks on rows and controls never reach here
          // with currentTarget === target.
          if (e.currentTarget !== e.target) return;
          if (selectedIds.size === 0) return;
          setSelectedIds(new Set());
          setSelectionAnchorId(null);
        }}
        onDragOver={(e) => {
          // Empty area is a drop target (re-parent to root). Only OS file
          // drags light up the whole box; row hover already shows node
          // drops. A thread or table has no root placement, so whitespace
          // rejects it.
          const isFileDrag = e.dataTransfer.types.includes('Files');
          const sources = dragSourceRef.current;
          if (
            (sources && !sources.some((s) => s.kind === 'thread' || s.kind === 'table')) ||
            isFileDrag
          ) {
            e.preventDefault();
          }
          if (isFileDrag && !rootFileDragOver) setRootFileDragOver(true);
        }}
        onDragLeave={(e) => {
          // Clear only when the drag truly exits the tree box (not when
          // crossing into a child row — relatedTarget is still inside).
          const related = e.relatedTarget as Node | null;
          if (!related || !e.currentTarget.contains(related)) {
            setRootFileDragOver(false);
          }
        }}
        onDrop={(e) => {
          // Row drops stop propagation, so a drop that reaches the wrapper
          // landed on whitespace: move to root (or, for OS files, upload at
          // root). `inside` is a placeholder zone for a null target.
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            e.preventDefault();
            handleFileDrop(null, 'inside', e.dataTransfer.files);
            return;
          }
          if (!dragSourceRef.current) return;
          e.preventDefault();
          handleDrop(null, 'inside');
        }}
      >
        {/* Top-level projects rendered flat at depth 0 — VS Code style, no
            umbrella wrapper — with a new project's draft row after them;
            then, past a gap, the workspace Docs & context, Threads and Tables
            groups. Other root-level drafts are drawn in the Docs & context
            group. */}
        {rootProjects.map((node) => (
          <TreeRow key={node.id} {...rowProps} node={node} depth={0} />
        ))}
        {creator?.stage === 'editing' &&
          creator.parentContainerId === null &&
          creator.kind === 'project' && (
            <DraftRow
              depth={0}
              kind={creator.kind}
              inputRef={draftInputRef}
              onCommit={commitCreator}
              onCancel={cancelCreator}
            />
          )}
        <RootItemsGroup items={rootItems} spaced={rootProjects.length > 0} rowProps={rowProps} />
        <ThreadsGroup projectId={null} threads={flatThreads} headerDepth={0} rowProps={rowProps} />
        <TablesGroup
          projectId={null}
          tables={workspaceTables}
          headerDepth={0}
          rowProps={rowProps}
        />
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={styles.shell}
      data-sidebar-search="true"
      data-sidebar-workspace={
        hideBody ? undefined : roots === null ? (error ? 'error' : 'loading') : 'ready'
      }
      data-inspect-query={search.searchQuery}
      data-inspect-filters={JSON.stringify([
        ...search.searchFilterKinds,
        ...(search.fsFilter ? ['filesystem'] : []),
        ...(search.entryFilter ? ['entries'] : []),
      ])}
    >
      {!hideBody && headerBar}
      <TreeSearchWidget search={search} />
      {!hideBody && error && roots !== null && (
        <div className={styles.error} role="alert">
          {`Couldn't refresh the workspace: ${error}`}
        </div>
      )}
      {!hideBody && body}

      {!hideBody && rowMenu && (
        <TreeContextMenu
          state={rowMenu}
          canPaste={canPaste}
          onClose={closeRowMenu}
          onRename={() => startRename(rowMenu.node.id)}
          onDuplicate={() => void duplicateNode(rowMenu.node)}
          onCopy={() => copyNode(rowMenu.node)}
          onPaste={() => void pasteRelativeTo(rowMenu.node)}
          onArchive={() => archiveRows(rowMenu.node, false)}
        />
      )}

      {!hideBody && pendingThread && (
        <ThreadAgentPickerModal
          threadTitle={pendingThread.title}
          onCancel={cancelPendingThread}
          onCreate={commitPendingThread}
        />
      )}

      {!hideBody && creator?.stage === 'picker' && typeof document !== 'undefined' && (
        <CreateKindPicker
          anchorLeft={creator.anchorLeft}
          anchorTop={creator.anchorTop}
          kinds={creatableKinds}
          onSelectKind={selectKind}
        />
      )}
    </div>
  );
}
