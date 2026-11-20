import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { ContainerCategory } from '@snaglet/shared/constants';
import type { TableCatalogEntry } from '@snaglet/shared/types';
import type { FileRecord, FileTreeNode, LibraryTreeChild, ThreadTreeNode } from '../../utils/api';
import { readChipDragData, setActiveDragChip } from '@desktop/utils/nodeChip';
import {
  BoxIcon,
  ChatBubbleIcon,
  DocIcon,
  ImageIcon,
  LeafToggle,
  SwirlIcon,
} from '@desktop/components/Icons';
import { ProjectIcon } from '@desktop/components/Icons/ProjectIcon';
import { CopyToClipboardButton } from '@desktop/components';
import { useThreadRunning } from '@desktop/utils/threadRunState';
import { FileTreeGroup } from './FileTreeGroup';
import { TablesGroup } from './TablesGroup';
import { ThreadAgentsGroup } from './ThreadAgentsGroup';
import { ThreadsGroup } from './ThreadsGroup';
import styles from './WorkspaceTree.module.scss';
import { RenameInput } from './RenameInput';
import {
  applyRowDragData,
  areSourcesOwnChildren,
  buildDragPayloads,
  dropZoneForPointer,
  payloadOf,
  showMultiDragGhost,
} from './treeRowDnd';
import {
  guideStyle,
  isProjectNode,
  labelOfNode,
  nodeCopyLink,
  partitionThreads,
  rowIndent,
} from './treeUtils';
import type {
  CreatorEditing,
  CreatorState,
  DragPayload,
  DropZone,
  ThreadAgentEntry,
} from './types';
import { draftsInScopeGroup } from './types';
import { DraftRow } from './DraftRow';
import { ExportTreeNodeAction } from './ExportTreeNodeAction';
import type { WorkspaceTreeSelectionEvent } from './hooks/useWorkspaceTreeSelection';

export interface TreeRowProps {
  node: LibraryTreeChild;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  /**
   * Routes the click through the multi-select logic (plain/cmd/shift).
   * The handler decides whether to open the node in a pane.
   */
  clickRow: (node: LibraryTreeChild, e: WorkspaceTreeSelectionEvent) => void;
  /**
   * The same multi-select logic for a Tables group row. Returns true for a
   * plain click, which the row answers by opening the table.
   */
  clickTable: (table: TableCatalogEntry, e: WorkspaceTreeSelectionEvent) => boolean;
  selectedIds: Set<string>;
  nodeIndex: Map<string, LibraryTreeChild>;
  /** Id → entry for every table drawn in a Tables group (multi-row drags, drop checks). */
  tableIndex: Map<string, TableCatalogEntry>;
  visibleOrderIndex: Map<string, number>;
  dragSourceRef: React.MutableRefObject<DragPayload[] | null>;
  hoverTargetId: string | null;
  hoverZone: DropZone | null;
  setHoverTargetId: (id: string | null) => void;
  setHoverZone: (zone: DropZone | null) => void;
  handleDrop: (target: LibraryTreeChild | null, zone: DropZone) => void;
  /** Dragged threads dropped on a Threads group header → scope them to that project (null = flat). */
  handleThreadScopeDrop: (projectId: string | null) => void;
  /** Dragged table rows dropped on a Tables group header → move them into that scope (null = unlinked). */
  handleTableScopeDrop: (projectId: string | null) => void;
  /** Dragged table rows dropped above or below a table row → place them beside it, in its scope. */
  handleTableRowDrop: (target: TableCatalogEntry, zone: Exclude<DropZone, 'inside'>) => void;
  /** A `table` chip dropped on a project row or a Tables group header → link the table to that scope (null = unlink). */
  handleTableDrop: (tableId: string, projectId: string | null) => void;
  /** OS file drop → image upload at the (target, zone) placement. */
  handleFileDrop: (target: LibraryTreeChild | null, zone: DropZone, files: FileList) => void;
  isDescendant: (sourceId: string, descId: string) => boolean;
  openPicker: (
    parentContainerId: string | null,
    anchor: HTMLElement,
    category?: ContainerCategory | null
  ) => void;
  creator: CreatorState;
  draftInputRef: React.MutableRefObject<HTMLInputElement | null>;
  commitCreator: (name: string) => void;
  cancelCreator: () => void;
  /**
   * Opens the inline name row at the top of a scope's Threads or Tables group
   * (expanding it), for that group's header `+`. Absent: the group has no `+`.
   */
  startScopedDraft?: (kind: 'thread' | 'table', projectId: string | null) => void;
  renamingId: string | null;
  startRename: (id: string) => void;
  commitRename: (node: LibraryTreeChild, value: string) => void;
  cancelRename: () => void;
  /** Per-project indexed-file cache. `null` is the in-flight sentinel; an
   *  empty array means "loaded, none." Looked up by project id (the container
   *  id); filled for each expanded project by `useTreeLazyData`. */
  projectFiles: Map<string, FileRecord[] | null>;
  /**
   * Catalog tables grouped by the project they are linked to, for the
   * generated Tables group under each project row. `null` while the
   * catalog has not loaded.
   */
  tablesByProject: Map<string, TableCatalogEntry[]> | null;
  /** Opens a file row in the active pane. */
  onNodeClick?: (node: LibraryTreeChild | FileTreeNode) => void;
  /**
   * Per-thread participant cache. Lazy-loaded and mirrored into the tree on
   * thread expand.
   */
  threadAgents: Map<string, { entries: ThreadAgentEntry[] } | null>;
  /** Per-thread "Agents" group header expansion (nested under thread row). */
  expandedThreadAgentGroups: Set<string>;
  toggleThreadAgentGroup: (threadId: string) => void;
  /**
   * Node id focused in the dashboard's active pane. The row renders
   * with an `active` highlight when its `node.id` (or attached project
   * id) matches. Distinct from `selectedIds`, which tracks the tree's
   * own multi-select state for drag/drop and keyboard nav.
   */
  activeNodeId: string | null;
  /**
   * Catalog id of the table in the dashboard's active pane: its Tables group
   * row renders the same `active` highlight a node row gets from
   * `activeNodeId`.
   */
  activeTableId?: string | null;
  /**
   * Set of node ids open in any dashboard pane. A row whose `node.id`
   * is in this set renders the "open in a pane" indicator (a side accent
   * bar). Independent of `activeNodeId`: a node can be open in a
   * background pane without being the active one.
   */
  openNodeIds?: Set<string>;
  /** Right-click on a row → open the Copy / Paste / Duplicate context menu. */
  onRowContextMenu?: (node: LibraryTreeChild, e: ReactMouseEvent<HTMLElement>) => void;
  /**
   * Delete (or Cmd/Ctrl+Backspace) on a focused row → archive it, or the
   * whole selection when the row is in it, with an Undo.
   */
  onArchiveRow?: (node: LibraryTreeChild) => void;
}

/**
 * Everything a row needs besides its own node and depth. Built once by
 * WorkspaceTree and spread into every row, child row and generated group,
 * so adding a tree-wide prop is a one-line change here.
 */
export type TreeRowSharedProps = Omit<TreeRowProps, 'node' | 'depth'>;

export function TreeRow(props: TreeRowProps) {
  const { node, depth, ...shared } = props;
  const {
    expanded,
    onToggle,
    clickRow,
    selectedIds,
    activeNodeId,
    openNodeIds,
    nodeIndex,
    tableIndex,
    visibleOrderIndex,
    dragSourceRef,
    hoverTargetId,
    hoverZone,
    setHoverTargetId,
    setHoverZone,
    handleDrop,
    handleTableDrop,
    handleFileDrop,
    isDescendant,
    openPicker,
    creator,
    draftInputRef,
    commitCreator,
    cancelCreator,
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
    onRowContextMenu,
    onArchiveRow,
  } = shared;
  const isContainer = node.kind === 'container';
  const isThread = node.kind === 'thread';
  // Live-run indicator: subscribes this row to the thread run-state store.
  // Non-thread ids are never in the store, so the hook is a stable no-op
  // for other row kinds (hooks must run unconditionally).
  const isThreadRunning = useThreadRunning(node.id) && isThread;
  const isDoc = node.kind === 'doc';
  const isImage = node.kind === 'image';
  // A project is a container with `category === 'project'`; the container id
  // is the project id.
  const isProjectHome = node.kind === 'container' && node.category === 'project';
  // A project's children carry its threads (the tree payload nests them
  // there); they render in a generated Threads group before the folders, not
  // as folder-tree rows. A plain folder never holds threads, so filtering
  // them here also guarantees a thread never renders inside one.
  const containerChildren = isContainer ? (node.children ?? []) : [];
  const { threads, others: children } = useMemo(
    () => partitionThreads(containerChildren),
    [containerChildren]
  );
  const isOpen = expanded.has(node.id);
  // Project-home rows expose their indexed file tree, Threads and Tables
  // groups alongside their container children. The toggle is shown when
  // either children exist or the container is a project home. Project id is
  // the container id.
  const projectIdForFiles = isProjectHome ? node.id : null;
  // Thread rows are also expandable to reveal the nested "Agents" leaf.
  // Whether a thread *actually* has participants is unknown until the
  // first expand triggers a fetch — we always show the chevron and let
  // the expanded section render empty if 0 agents came back. The over-
  // promise is small (most threads have ≥1 agent) and lets us avoid
  // preloading participant counts for every thread on initial tree fetch.
  const hasChildren = (isContainer && (children.length > 0 || isProjectHome)) || isThread;

  // Projects are containers (category='project'); they draw the container box
  // with a star (`ProjectIcon`), plus `.rowProject` (bold label +
  // theme's Project color, `--color-container-project`).
  const iconChar: React.ReactNode = isProjectHome ? (
    <ProjectIcon />
  ) : isContainer ? (
    <BoxIcon />
  ) : isThread ? (
    <ChatBubbleIcon />
  ) : isImage ? (
    <ImageIcon />
  ) : (
    <DocIcon />
  );
  const labelFallback = isContainer
    ? 'Untitled container'
    : isThread
      ? 'Untitled thread'
      : isImage
        ? 'Untitled image'
        : 'Untitled doc';
  // Canonical display label — `labelOfNode` encodes the same name/title
  // fallback rules per node kind, so this row and its drag-chip stay in sync.
  const labelText = labelOfNode(node);
  // Ready-to-paste wiki link for this row — `[Label](id)`.
  const wikiLink = nodeCopyLink(node.id, labelText || labelFallback);
  const isHoverTarget = hoverTargetId === node.id;
  const activeZone = isHoverTarget ? hoverZone : null;
  const isRenaming = renamingId === node.id;
  // Project-home rows are ordinary containers under the hood — renamable and
  // draggable like any other container.
  const draggable = !isRenaming;

  // When the rename field closes (Enter, Escape, F2's round trip) focus would
  // drop to the page with the vanished input; hand it back to this row. A
  // blur commit that moved focus somewhere real keeps it there.
  const treeItemRef = useRef<HTMLDivElement | null>(null);
  const wasRenamingRef = useRef(isRenaming);
  useEffect(() => {
    const ended = wasRenamingRef.current && !isRenaming;
    wasRenamingRef.current = isRenaming;
    if (!ended) return;
    const active = document.activeElement;
    if (!active || active === document.body) treeItemRef.current?.focus({ preventScroll: true });
  }, [isRenaming]);

  const renderDraftHere =
    isContainer &&
    creator?.stage === 'editing' &&
    creator.parentContainerId === node.id &&
    !draftsInScopeGroup(creator.kind);
  // A project draws only the groups that hold something, or the one a new
  // thread or table is being named in, so an empty project is one
  // quiet line instead of a stack of empty headings. Files shows once the
  // project links a folder or has indexed files. The `+` menu on the row
  // creates every kind, and a dragged thread or table still lands on
  // the project row itself.
  const projectNode = isProjectNode(node) ? node : null;
  const projectFileList = projectNode ? projectFiles.get(projectNode.id) : undefined;
  const showFiles =
    projectNode !== null && (Boolean(projectNode.folderPath) || (projectFileList?.length ?? 0) > 0);
  const draftingScoped = (kind: 'thread' | 'table') =>
    creator?.stage === 'editing' && creator.kind === kind && creator.parentContainerId === node.id;
  const projectTables =
    projectNode && tablesByProject !== null ? (tablesByProject.get(node.id) ?? []) : null;
  const showThreads = threads.length > 0 || draftingScoped('thread');
  const showTables = (projectTables?.length ?? 0) > 0 || draftingScoped('table');
  // Wait for the catalog so a project with tables never flashes "Empty".
  const projectIsEmpty =
    projectNode !== null &&
    projectTables !== null &&
    !showFiles &&
    !showThreads &&
    !showTables &&
    children.length === 0 &&
    !renderDraftHere;

  const draftRow = renderDraftHere ? (
    <DraftRow
      depth={depth + 1}
      kind={(creator as CreatorEditing).kind}
      inputRef={draftInputRef}
      onCommit={commitCreator}
      onCancel={cancelCreator}
    />
  ) : null;

  // Opening a project fetches its file list (`useTreeLazyData` watches the
  // expanded set), so the toggle itself is just the expansion.
  const toggleExpansion = () => {
    if (!hasChildren) return;
    onToggle(node.id);
  };

  const handleTreeItemKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Nested copy/create controls, rename inputs, and descendant treeitems own
    // their key events. Only a key aimed at this focused treeitem activates it.
    if (e.target !== e.currentTarget || isRenaming) return;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clickRow(node, e);
      return;
    }

    if (e.key === 'F2') {
      e.preventDefault();
      startRename(node.id);
      return;
    }

    if (e.key === 'ArrowRight' && hasChildren && !isOpen) {
      e.preventDefault();
      toggleExpansion();
      return;
    }

    if (e.key === 'ArrowLeft' && hasChildren && isOpen) {
      e.preventDefault();
      toggleExpansion();
      return;
    }

    if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      if (!onArchiveRow) return;
      e.preventDefault();
      onArchiveRow(node);
    }
  };

  /**
   * True when every dragged row is a table already linked to `projectId`
   * (nothing would move).
   */
  const areScopedRowsIn = (sources: DragPayload[], projectId: string): boolean =>
    sources.every((s) => s.kind === 'table' && tableIndex.get(s.id)?.projectId === projectId);

  /**
   * The dragged `table` chip when this row can take it: a table drag (no tree
   * rows in flight) over a project the table is not already linked to.
   */
  const acceptedTable = (dt: DataTransfer) => {
    if (!isProjectHome || dragSourceRef.current) return null;
    const chip = readChipDragData(dt);
    if (chip?.kind !== 'table') return null;
    return tablesByProject?.get(node.id)?.some((t) => t.id === chip.id) ? null : chip;
  };

  return (
    <div
      ref={treeItemRef}
      className={styles.rowGroup}
      role="treeitem"
      data-inspect-kind={node.kind}
      aria-label={labelText || labelFallback}
      aria-level={depth + 1}
      aria-selected={selectedIds.has(node.id)}
      aria-expanded={hasChildren ? isOpen : undefined}
      tabIndex={isRenaming ? -1 : 0}
      onKeyDown={handleTreeItemKeyDown}
    >
      <div
        className={[
          styles.row,
          isProjectHome ? styles.rowProject : '',
          isDoc ? styles.rowDoc : '',
          isThread ? styles.rowThread : '',
          isImage ? styles.rowImage : '',
          // Plain containers (not project roots) get the container modifier
          // so each kind has its own subtle tint; project containers are
          // already styled by `.rowProject` above.
          isContainer && !isProjectHome ? styles.rowContainer : '',
          // Three drop affordances depending on which zone the cursor sits
          // in: `inside` keeps the whole-row highlight (existing behavior,
          // re-parent into a container), while `above` / `below` show an
          // insertion line via the kind-agnostic modifier classes.
          activeZone === 'inside' ? styles.rowDropTarget : '',
          activeZone === 'above' ? styles.rowDropAbove : '',
          activeZone === 'below' ? styles.rowDropBelow : '',
          // Multi-select highlight. Applies to every row whose id is in
          // `selectedIds`. A single-row plain click still hits this
          // branch (selection is reset to {node}); cmd/shift-clicks add
          // more rows. Distinct from `rowDropTarget` (drag affordance).
          selectedIds.has(node.id) ? styles.rowSelected : '',
          // Active-pane highlight — the dashboard's currently-focused
          // node. Project-home rows match by their own container id (the
          // container is the project). Distinct from `rowSelected`
          // (tree's own multi-select).
          activeNodeId && activeNodeId === node.id ? styles.rowActive : '',
          // Open-in-a-pane indicator — the node is showing in some pane,
          // not necessarily the focused one. Renders a side accent bar
          // (reserved berry affordance). Ranks below `rowActive`, which
          // adds a thicker bar + bold on top for the focused pane.
          openNodeIds?.has(node.id) ? styles.rowOpen : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: rowIndent(depth) }}
        data-row-id={node.id}
        data-project-id={isProjectHome ? node.id : undefined}
        data-container-category={isContainer ? node.category : undefined}
        onClick={(e) => {
          if (isRenaming) return;
          clickRow(node, e);
        }}
        onContextMenu={(e) => {
          if (isRenaming || !onRowContextMenu) return;
          onRowContextMenu(node, e);
        }}
        draggable={draggable}
        onDragStart={(e) => {
          // Buttons/inputs inside a draggable row own their gesture. Without
          // this guard the browser may promote a drag that began on Export or
          // Copy to the nearest draggable ancestor (this row).
          if ((e.target as HTMLElement).closest('button, input, textarea, select')) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (!draggable) {
            e.preventDefault();
            return;
          }
          const payloads: DragPayload[] = buildDragPayloads(
            payloadOf(node),
            selectedIds,
            nodeIndex,
            tableIndex,
            visibleOrderIndex
          );
          dragSourceRef.current = payloads;
          applyRowDragData(e, node, payloads);
          if (payloads.length > 1) showMultiDragGhost(e, payloads.length);
        }}
        onDragEnd={() => {
          dragSourceRef.current = null;
          setHoverTargetId(null);
          setHoverZone(null);
          setActiveDragChip(null); // clear in-memory store
          // Drop the surface-wide grabbing cursor flag. Fires for both
          // completed and canceled drags, so the cursor always reverts.
          document.body.removeAttribute('data-dragging');
        }}
        onDragOver={(e) => {
          // A thread row takes only other threads, above or below it: the
          // dropped threads join its project's list at that slot. Files,
          // folders, docs and tables have no place beside a thread.
          if (isThread) {
            const sources = dragSourceRef.current;
            if (!sources || sources.length === 0) return;
            if (!sources.every((s) => s.kind === 'thread')) return;
            if (sources.some((s) => s.id === node.id)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            const zone = dropZoneForPointer(e, false);
            if (hoverTargetId !== node.id) setHoverTargetId(node.id);
            if (hoverZone !== zone) setHoverZone(zone);
            return;
          }
          // File-drop (image upload / doc import) — accepted on any
          // positioned row with the same zone grammar as node drags.
          // `inside` uploads into the container; above/below insert at the
          // target's slot among its siblings.
          const isFileDrag = e.dataTransfer.types.includes('Files');
          if (isFileDrag) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            const zone = dropZoneForPointer(e, isContainer);
            if (hoverTargetId !== node.id) setHoverTargetId(node.id);
            if (hoverZone !== zone) setHoverZone(zone);
            return;
          }
          const sources = dragSourceRef.current;
          if (!sources || sources.length === 0) {
            // A table chip (from a Tables group or the Database sidebar)
            // links to the project it is dropped on; one already linked here
            // has nowhere to go.
            if (!acceptedTable(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (hoverTargetId !== node.id) setHoverTargetId(node.id);
            if (hoverZone !== 'inside') setHoverZone('inside');
            return;
          }
          // Block hover affordance when any dragged row is this target,
          // or when any dragged container is an ancestor of this target.
          if (sources.some((s) => s.id === node.id)) return;
          if (sources.some((s) => s.kind === 'container' && isDescendant(s.id, node.id))) return;
          // Dragged threads and tables land inside a project only —
          // never on a plain folder or a doc, and not back on their own
          // project. A mixed batch follows the strictest row in it.
          const scopedInDrag = sources.some((s) => s.kind === 'thread' || s.kind === 'table');
          if (scopedInDrag && !isProjectHome) return;
          const ownChildren = isContainer && areSourcesOwnChildren(sources, node.id, nodeIndex);
          if (scopedInDrag && (ownChildren || areScopedRowsIn(sources, node.id))) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          // Project-home rows accept `inside` for any source: projects nest
          // freely, so dropping a project into a project-home just makes
          // it a child. `inside` is stripped when every dragged source is
          // already a direct child of this container (see areSourcesOwnChildren).
          const zone = scopedInDrag ? 'inside' : dropZoneForPointer(e, isContainer && !ownChildren);
          if (hoverTargetId !== node.id) setHoverTargetId(node.id);
          if (hoverZone !== zone) setHoverZone(zone);
        }}
        onDragLeave={(e) => {
          if (hoverTargetId === node.id) {
            const related = e.relatedTarget as HTMLElement | null;
            if (!related || !e.currentTarget.contains(related)) {
              setHoverTargetId(null);
              setHoverZone(null);
            }
          }
        }}
        onDrop={(e) => {
          const hasFiles = e.dataTransfer.files && e.dataTransfer.files.length > 0;
          e.preventDefault();
          e.stopPropagation();
          // File-drop: upload each file (image or doc import) at the
          // hovered placement. The server emits a tree-node-created event
          // per upload, which fans out through `useWorkspaceEventBridge`
          // -> `refreshNonce` so the tree refetches on its own without
          // bespoke client state here.
          if (hasFiles) {
            const files = e.dataTransfer.files;
            const zone = hoverZone ?? (isContainer ? 'inside' : 'below');
            handleFileDrop(node, zone, files);
            return;
          }
          const sources = dragSourceRef.current;
          if (!sources || sources.length === 0) {
            const table = acceptedTable(e.dataTransfer);
            if (table) handleTableDrop(table.id, node.id);
            return;
          }
          // A thread row only takes threads above or below it (dragover
          // refuses the rest). Read the half from the drop itself: the last
          // dragover's zone may not have rendered yet when the drop lands.
          if (isThread) {
            handleDrop(node, dropZoneForPointer(e, false));
            return;
          }
          // Fall back to `inside` for any container (including
          // project-home) — projects nest freely. `below` for leaves, or
          // when the dragged rows are already this container's own
          // children (the only useful gesture there is drag-out).
          // Defensive only — the dragover path sets a zone before drop
          // fires in practice.
          const sourcesAreOwnChildren =
            isContainer && areSourcesOwnChildren(sources, node.id, nodeIndex);
          const canInside = isContainer && !sourcesAreOwnChildren;
          const fallback: DropZone = canInside ? 'inside' : 'below';
          handleDrop(node, hoverZone ?? fallback);
        }}
      >
        <span
          className={[styles.chevron, !hasChildren && styles.chevronEmpty]
            .filter(Boolean)
            .join(' ')}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpansion();
          }}
          aria-hidden
          data-testid="library-tree-chevron"
        >
          {hasChildren && <LeafToggle open={isOpen} className={styles.leafToggle} />}
        </span>
        <span className={styles.icon} aria-hidden>
          {iconChar}
        </span>
        {isRenaming ? (
          <RenameInput
            initialValue={labelText || ''}
            onCommit={(value) => commitRename(node, value)}
            onCancel={cancelRename}
          />
        ) : (
          <span
            className={styles.label}
            title={labelText ?? ''}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startRename(node.id);
            }}
          >
            {labelText || labelFallback}
          </span>
        )}
        {isThreadRunning && (
          <span
            className={styles.runSwirl}
            role="status"
            aria-label="Agent run in progress"
            title="Agent run in progress"
          >
            <SwirlIcon size={12} />
          </span>
        )}
        {/* Right-anchored action group: export + copy-link + container create.
            They share one flex group so every action stays pinned beside `+`
            instead of drifting toward row center — only this wrapper carries
            `margin-left: auto`. */}
        <div className={styles.rowActions}>
          {(isDoc || isContainer) && (
            <ExportTreeNodeAction
              kind={isContainer ? 'container' : 'doc'}
              id={node.id}
              label={labelText || labelFallback}
            />
          )}
          <CopyToClipboardButton
            value={wikiLink}
            className={styles.copyLinkBtn}
            stopPropagation
            idleTitle="Copy link"
            copiedTitle="Link copied!"
            aria-label={`Copy link to ${labelText || labelFallback}`}
          />
          {isContainer && (
            <button
              type="button"
              className={styles.addBtnRow}
              title="Create inside this container"
              aria-label={`Create inside ${labelText || labelFallback}`}
              onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
                e.stopPropagation();
                openPicker(node.id, e.currentTarget, node.category ?? null);
              }}
            >
              +
            </button>
          )}
        </div>
      </div>
      {/* Project-home rows reveal their indexed file tree beneath the row.
          Lazy-loaded on first expand via projectFiles; the group builds the
          folder hierarchy from flat relative paths client-side and opens
          files in the pane through onNodeClick. */}
      {isProjectHome && isOpen && projectIdForFiles && showFiles && (
        <FileTreeGroup
          files={projectFiles.get(projectIdForFiles)}
          projectId={projectIdForFiles}
          containerId={node.kind === 'container' ? node.id : null}
          depth={depth}
          onNodeClick={onNodeClick}
          activeNodeId={activeNodeId}
          openNodeIds={openNodeIds}
        />
      )}
      {/* A project's scoped groups come first — Files above, then the threads
          attached to it and the catalog tables linked to it, each in its
          manual order — so the dropdowns sit together at
          the top; the project's own folders and docs follow below. Only the
          groups with rows (or a draft) are drawn. Every header, and every
          thread and table row, is a drop target for its kind. */}
      {isProjectHome && isOpen && (
        <>
          {showThreads && (
            <ThreadsGroup
              projectId={node.id}
              threads={threads}
              headerDepth={depth + 1}
              rowProps={shared}
            />
          )}
          {showTables && (
            <TablesGroup
              projectId={node.id}
              tables={projectTables}
              headerDepth={depth + 1}
              rowProps={shared}
            />
          )}
          {projectIsEmpty && (
            <div role="group" className={styles.indentGuide} style={guideStyle(depth)}>
              <div className={styles.taskHint} style={{ paddingLeft: rowIndent(depth + 1) }}>
                Empty project · use + to add
              </div>
            </div>
          )}
        </>
      )}
      {/* Thread rows reveal a nested "Agents" group when expanded.
          Lazy-loaded on first expand via the `useEffect` that watches
          `expanded` for thread ids. */}
      {isThread && isOpen && (
        <ThreadAgentsGroup
          thread={node as ThreadTreeNode}
          depth={depth}
          threadAgents={threadAgents}
          expandedThreadAgentGroups={expandedThreadAgentGroups}
          toggleThreadAgentGroup={toggleThreadAgentGroup}
        />
      )}
      {/* Show the draft row and existing children when this container is open
          or when a draft is being authored under it (so the draft is visible
          even if the container hasn't been manually expanded yet). Renders
          for both regular and project-home containers; under a project these
          folders and docs come after the Files / Threads / Tables
          groups. */}
      {isContainer && (isOpen || renderDraftHere) && (children.length > 0 || renderDraftHere) && (
        <div role="group" className={styles.indentGuide} style={guideStyle(depth)}>
          {draftRow}
          {children.map((child) => (
            <TreeRow key={child.id} {...shared} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
