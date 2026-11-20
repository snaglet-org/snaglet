import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { PaneFindProvider } from '@desktop/features/pane-find/PaneFindContext';
import { useFluidZoom } from '@desktop/hooks/useFluidZoom';
import { PANE_ZOOM } from '@desktop/styles/typeScale';
import { DetailRouter } from '../../views/DetailRouter';
import {
  selectionFromWorkspaceNode,
  sidebarRevealTarget,
  workspaceNodeId,
  type DetailSelection,
} from '../../selection/types';
import {
  canGoBackInLeaf,
  canGoForwardInLeaf,
  type LayoutLeaf,
  type DropZone,
} from '../../layout/paneTree';
import { Button } from '@desktop/components';
import { OpenInSidebarContext, type OpenInSidebarContextValue } from './openInSidebar';
import { CheckIcon, CopyIcon } from '@desktop/components/Icons';
import { threadsApi, docsApi, containersApi, filesApi, imagesApi } from '@desktop/utils/api';
import type { FileTreeNode } from '@desktop/utils/api';
import { getErrorMessage, isRenamableProjectFile } from '@snaglet/shared/utils';
import { useLinkedProjectFolders } from '@desktop/features/database/projectList';
import { showToast } from '@desktop/utils/toast';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import {
  consumeVerticalWheelAsHorizontal,
  WHEEL_SCROLL_X_PROPS,
} from '@desktop/utils/horizontalWheelScroll';
import { PathHeader } from '../PathHeader/PathHeader';
import type { AncestorContainer } from '../PathHeader/nodeAncestors';
import { useNodeAncestors } from '../PathHeader/useNodeAncestors';
import { PaneHistoryNav, type PaneHistoryNavHandle } from '../PaneHistoryNav/PaneHistoryNav';
import {
  useSelectionDescriptor,
  isPathKind,
  isEntityKind,
  type SelectionKind,
} from '../../selection/selectionDescriptor';
import { forgetPaneFocus, rememberPaneFocus } from '../../layout/paneFocus';
import { usePaneDropZone } from './usePaneDropZone';
import { usePaneHistoryShortcuts } from './usePaneHistoryShortcuts';
import { useTableTitleRename } from './useTableTitleRename';
import { lastInputWasKeyboard, trackInputModality } from './inputModality';
import { selectionIdentity } from './selectionIdentity';
import { ErrorBoundary } from '@desktop/components';
import styles from './PaneChrome.module.scss';

/**
 * Kind → icon-tint class map. Only the breadcrumb (path) kinds need an
 * entry: plain panes (agents, settings, single tools) render as a bare
 * name with no icon slot, so their tint is never read. The descriptor
 * itself is stylesheet-agnostic; each consumer owns the kind→class
 * mapping for its own surface (PaneHistoryNav has the parallel one).
 */
const KIND_TO_ICON_CLASS: Partial<Record<SelectionKind, string>> = {
  container: styles.crumbIconContainer,
  doc: styles.crumbIconDoc,
  file: styles.crumbIconFile,
  thread: styles.crumbIconThread,
  dm: styles.crumbIconThread,
  project: styles.crumbIconProject,
  image: styles.crumbIconImage,
};

interface PaneProps {
  leaf: LayoutLeaf;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
  onDropSelection: (zone: DropZone, selection: DetailSelection) => void;
  /**
   * Called when something *inside* the pane (e.g. ContainerBrowser clicking
   * a project-root tile) wants to swap this pane's whole selection — the
   * equivalent of a center-drop, but triggered by a click rather than a drag.
   */
  onReplaceSelection: (selection: DetailSelection) => void;
  /** Step backward in this pane's per-pane visit history. */
  onGoBack: () => void;
  /** Step forward in this pane's per-pane visit history. */
  onGoForward: () => void;
  /** Jump directly to an absolute index in this pane's history (dropdown). */
  onJumpToHistoryEntry: (index: number) => void;
  onOpenInSidebar?: () => void;
}

export type PaneChromeActionZone = 'center' | 'right';

interface PaneChromeContextValue {
  setActions: (zone: PaneChromeActionZone, owner: symbol, actions: ReactNode | null) => void;
  clearActions: (zone: PaneChromeActionZone, owner: symbol) => void;
}

const PaneChromeContext = createContext<PaneChromeContextValue | null>(null);

/** True inside a pane (its topbar can host actions); false in modals/tests. */
export function useHasPaneChrome(): boolean {
  return useContext(PaneChromeContext) !== null;
}

/**
 * Cuts a subtree off from the pane chrome around it. Context flows through
 * portals, so without this a view in a modal opened from a pane (the link
 * preview hosts a full DocView) would replace that pane's topbar controls
 * while open and clear them on close. Inside the boundary useHasPaneChrome()
 * is false, actions go nowhere and there is no "Open in sidebar".
 */
export const PaneChromeBoundary: FC<{ children: ReactNode }> = ({ children }) => (
  <PaneChromeContext.Provider value={null}>
    <OpenInSidebarContext.Provider value={null}>{children}</OpenInSidebarContext.Provider>
  </PaneChromeContext.Provider>
);

/**
 * Fills one of the pane chrome's action slots: the scrollable center by
 * default, or the fixed right edge with `{ zone: 'right' }`. Registration is
 * owner-tokened, so an old view unmounting after a newer one registered cannot
 * erase the newer controls. Memoize the JSX node; unmount clears the slot.
 */
export function usePaneChromeActions(
  actions: ReactNode | null,
  options: { zone?: PaneChromeActionZone } = {}
): void {
  const ctx = useContext(PaneChromeContext);
  const ownerRef = useRef(Symbol('pane-chrome-actions'));
  const zone = options.zone ?? 'center';
  useEffect(() => {
    if (!ctx) return;
    const owner = ownerRef.current;
    ctx.setActions(zone, owner, actions);
    return () => ctx.clearActions(zone, owner);
  }, [actions, ctx, zone]);
}

/**
 * One leaf of the layout tree: the topbar (PathHeader, the surface's action
 * slots, close button), the detail body, and an overlay that shows the five
 * drop zones while a sidebar drag is over the pane. DetailRouter renders the
 * empty state.
 */
const PaneChrome: FC<PaneProps> = ({
  leaf,
  isActive,
  onActivate,
  onClose,
  onDropSelection,
  onReplaceSelection,
  onGoBack,
  onGoForward,
  onJumpToHistoryEntry,
  onOpenInSidebar,
}) => {
  const [centerActions, setCenterActions] = useState<ReactNode | null>(null);
  const [rightActions, setRightActions] = useState<ReactNode | null>(null);
  const actionOwnersRef = useRef<Record<PaneChromeActionZone, symbol | null>>({
    center: null,
    right: null,
  });
  const setActions = useCallback(
    (zone: PaneChromeActionZone, owner: symbol, nextActions: ReactNode | null) => {
      actionOwnersRef.current[zone] = owner;
      (zone === 'center' ? setCenterActions : setRightActions)(nextActions);
    },
    []
  );
  const clearActions = useCallback((zone: PaneChromeActionZone, owner: symbol) => {
    if (actionOwnersRef.current[zone] !== owner) return;
    actionOwnersRef.current[zone] = null;
    (zone === 'center' ? setCenterActions : setRightActions)(null);
  }, []);
  const chromeCtx = useMemo<PaneChromeContextValue>(
    () => ({ setActions, clearActions }),
    [clearActions, setActions]
  );
  const detachCenterWheelRef = useRef<(() => void) | null>(null);
  // The rail IS the scrollable element, so it uses the shared helper
  // directly rather than the delegated form the markdown surfaces use.
  const setCenterRail = useCallback((rail: HTMLDivElement | null) => {
    detachCenterWheelRef.current?.();
    detachCenterWheelRef.current = null;
    if (!rail) return;

    const onWheel = (event: WheelEvent) => consumeVerticalWheelAsHorizontal(rail, event);
    rail.addEventListener('wheel', onWheel, { passive: false });
    detachCenterWheelRef.current = () => {
      rail.removeEventListener('wheel', onWheel);
    };
  }, []);
  useEffect(() => () => detachCenterWheelRef.current?.(), []);

  const canGoBack = canGoBackInLeaf(leaf);
  const canGoForward = canGoForwardInLeaf(leaf);
  const historyNavRef = useRef<PaneHistoryNavHandle>(null);
  // The folders and project above a workspace node: the breadcrumb, and the
  // parent ⌘↑ opens. `workspaceNodeId` is null for kinds with no tree path
  // (agents, settings, tools, files), which skips the tree read.
  const ancestors = useNodeAncestors(workspaceNodeId(leaf.selection));
  const parent = ancestors[ancestors.length - 1];
  usePaneHistoryShortcuts(isActive, {
    canGoBack,
    canGoForward,
    onGoBack,
    onGoForward,
    onOpenHistory: () => historyNavRef.current?.openMenu(),
    onGoUp: parent ? () => onReplaceSelection(selectionFromWorkspaceNode(parent)) : null,
  });

  const { hoverZone, handlers } = usePaneDropZone(onDropSelection);
  useEffect(() => trackInputModality(), []);
  useEffect(() => () => forgetPaneFocus(leaf.id), [leaf.id]);

  // Fluid pane zoom fallback: the body's `> *` carries a pure-CSS
  // `zoom: clamp(…)` by the pane's width; on an engine that can't evaluate
  // it, this measures the body and writes `--pane-zoom` inline instead.
  const bodyRef = useRef<HTMLDivElement>(null);
  useFluidZoom(bodyRef, '--pane-zoom', PANE_ZOOM);

  // A crashed view must not outlive its selection: once the pane moves to a
  // different item, remount the boundary so the new view gets a clean render.
  // Healthy views are never remounted by this — only a boundary that caught.
  const identity = selectionIdentity(leaf.selection);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [boundaryGeneration, setBoundaryGeneration] = useState(0);
  const [crashedIdentity, setCrashedIdentity] = useState<string | null>(null);
  const onViewError = useCallback(() => setCrashedIdentity(identityRef.current), []);
  useLayoutEffect(() => {
    if (crashedIdentity === null || crashedIdentity === identity) return;
    setCrashedIdentity(null);
    setBoundaryGeneration((generation) => generation + 1);
  }, [crashedIdentity, identity]);

  // "Open in sidebar": views with a side panel claim it and show it there
  // (openInSidebar.tsx); the topbar shows it only while nothing claims it.
  const canOpenInSidebar = !!onOpenInSidebar && sidebarRevealTarget(leaf.selection) !== null;
  const onOpenInSidebarRef = useRef(onOpenInSidebar);
  onOpenInSidebarRef.current = onOpenInSidebar;
  const [sidebarClaims, setSidebarClaims] = useState(0);
  const openInSidebarCtx = useMemo<OpenInSidebarContextValue>(
    () => ({
      available: canOpenInSidebar,
      open: () => onOpenInSidebarRef.current?.(),
      claim: () => {
        setSidebarClaims((n) => n + 1);
        return () => setSidebarClaims((n) => n - 1);
      },
    }),
    [canOpenInSidebar]
  );
  const showOpenInSidebar = canOpenInSidebar && sidebarClaims === 0;

  // Container category tints the active-pane accent and breadcrumb icon.
  const containerCategory =
    leaf.selection?.kind === 'container' && leaf.selection.node?.category
      ? leaf.selection.node.category
      : undefined;

  return (
    <PaneChromeContext.Provider value={chromeCtx}>
      <OpenInSidebarContext.Provider value={openInSidebarCtx}>
        <div
          className={`${styles.pane} ${isActive ? styles.paneActive : ''}`}
          data-leaf-id={leaf.id}
          // The pane the history and pane keys act on.
          data-pane-focused={isActive ? 'true' : undefined}
          data-container-category={containerCategory}
          // Activate only when this pane is not already active: a layout update
          // on every mousedown re-renders the pane tree mid-gesture and drops a
          // text selection being started in the focused pane. An inactive pane
          // activates on first press. Its Close button is the exception:
          // closing a background pane leaves the active pane as it is.
          onMouseDown={
            isActive
              ? undefined
              : (e) => {
                  if (e.target instanceof Element && e.target.closest('[data-pane-close]')) return;
                  onActivate();
                }
          }
          // Keyboard users switch panes by tabbing into them. Pointer focus is
          // already handled by mousedown, and focus a view moves on its own
          // (an editor autofocusing on mount) must not steal the active pane.
          onFocus={
            isActive
              ? undefined
              : () => {
                  if (lastInputWasKeyboard()) onActivate();
                }
          }
          // Where focus last was in this pane, for ⌘⌥ + arrow / ⌃Tab to return
          // to. Focus in a portaled layer (the history menu) is not the pane's.
          onFocusCapture={(e) => {
            if (e.target instanceof HTMLElement && e.currentTarget.contains(e.target)) {
              rememberPaneFocus(leaf.id, e.target);
            }
          }}
          onDragOverCapture={handlers.onDragOverCapture}
          onDragOver={handlers.onDragOver}
          onDragLeave={handlers.onDragLeave}
          onDrop={handlers.onDrop}
        >
          <div className={styles.chrome}>
            <div className={styles.leftZone} data-pane-chrome-zone="left">
              <PaneHistoryNav
                ref={historyNavRef}
                history={leaf.history}
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                onGoBack={onGoBack}
                onGoForward={onGoForward}
                onJumpTo={onJumpToHistoryEntry}
                onOpenInSplit={(entry) => onDropSelection('right', entry)}
              />
            </div>
            <div
              ref={setCenterRail}
              className={styles.centerRail}
              data-pane-chrome-zone="center"
              {...WHEEL_SCROLL_X_PROPS}
            >
              <div className={styles.centerContent}>
                <div className={styles.crumbs}>
                  <PaneChromePath selection={leaf.selection} ancestors={ancestors} />
                </div>
                {centerActions && <div className={styles.centerActions}>{centerActions}</div>}
                {showOpenInSidebar && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.openSidebarBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenInSidebar?.();
                    }}
                    title="Open in sidebar"
                  >
                    Open in sidebar
                  </Button>
                )}
              </div>
            </div>
            <div className={styles.rightZone} data-pane-chrome-zone="right">
              {rightActions && <div className={styles.rightActions}>{rightActions}</div>}
              <PaneCopyIdButton selection={leaf.selection} />
              <Button
                variant="neutral"
                size="sm"
                iconOnly
                className={styles.chromeIconBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onDropSelection('right', null);
                }}
                title="New tab (split screen)"
                aria-label="New tab"
              >
                +
              </Button>
              <Button
                variant="neutral"
                size="sm"
                iconOnly
                className={styles.chromeIconBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                title="Close pane"
                aria-label="Close pane"
                data-pane-close
              >
                ×
              </Button>
            </div>
          </div>
          {/* `pane-body` is a stable (non-hashed) hook: it establishes the
            `pane` container that the view root's fluid zoom (PaneChrome
            .module.scss `.body > *`) and the Layer-1 chat-geometry steps in
            _tokens.scss (@container pane → .pane-body > *) both measure. */}
          <div ref={bodyRef} className={`${styles.body} pane-body`}>
            <PaneFindProvider isActive={isActive}>
              <ErrorBoundary key={boundaryGeneration} onError={onViewError}>
                <DetailRouter
                  selection={leaf.selection}
                  onReplaceSelection={onReplaceSelection}
                  onClosePane={onClose}
                />
              </ErrorBoundary>
            </PaneFindProvider>
          </div>
          {hoverZone && <DropOverlay zone={hoverZone} />}
        </div>
      </OpenInSidebarContext.Provider>
    </PaneChromeContext.Provider>
  );
};

/**
 * Inline thread rename — broadcasts a library event so the sidebar's
 * cached LibraryTreeChild copy and any other pane displaying this
 * thread update their title without a refetch. The rename feels
 * instant everywhere because it lands locally before the API roundtrip
 * resolves (via the library event listeners in Dashboard).
 */
async function renameThread(id: string, nextTitle: string): Promise<void> {
  await threadsApi.rename(id, nextTitle);
  emitLibraryEvent({ type: 'renamed', kind: 'thread', id, name: nextTitle });
}

/**
 * Inline doc rename — broadcasts a library event so the sidebar's
 * cached LibraryTreeChild copy and any other pane displaying this
 * doc update their title without a refetch.
 */
async function renameDoc(id: string, nextTitle: string): Promise<void> {
  await docsApi.update(id, { title: nextTitle });
  emitLibraryEvent({ type: 'renamed', kind: 'doc', id, name: nextTitle });
}

/**
 * Inline container rename — broadcasts a library event so the sidebar's
 * cached LibraryTreeChild copy and any other pane displaying this
 * container update their title without a refetch.
 */
async function renameContainer(id: string, nextName: string): Promise<void> {
  await containersApi.update(id, { name: nextName });
  emitLibraryEvent({ type: 'renamed', kind: 'container', id, name: nextName });
}

/**
 * Run a rename and announce a refusal: the title header only keeps the error
 * in its tooltip, which nobody sees. The error is rethrown so the header
 * still restores the old title.
 */
async function withRenameToast(rename: () => Promise<void>): Promise<void> {
  try {
    await rename();
  } catch (err) {
    showToast(`Rename failed: ${getErrorMessage(err)}`);
    throw err;
  }
}

/**
 * Inline image rename — the server renames the stored file too. `previous`
 * is the name the pane showed, so a rename made elsewhere meanwhile is
 * refused rather than overwritten.
 */
function renameImage(id: string, nextName: string, previous: string): Promise<void> {
  return withRenameToast(async () => {
    const image = await imagesApi.rename(id, nextName, previous);
    emitLibraryEvent({ type: 'renamed', kind: 'image', id, name: image.name });
  });
}

/** True when `filePath` lies inside `folder` (both absolute). */
function isInsideFolder(filePath: string, folder: string): boolean {
  const root = folder.replace(/[\\/]+$/, '');
  return filePath.startsWith(`${root}/`) || filePath.startsWith(`${root}\\`);
}

/**
 * The absolute path a file pane can rename by: only a renamable file the pane
 * knows the path of, inside a folder linked to a project (the server refuses
 * any other).
 */
function renamableFilePath(node: FileTreeNode, linkedFolders: string[] | null): string | null {
  const absolute = node.absolutePath ?? (node.projectId === '' ? node.id : null);
  if (!absolute || !isRenamableProjectFile(node.name)) return null;
  return linkedFolders?.some((folder) => isInsideFolder(absolute, folder)) ? absolute : null;
}

/** Inline rename of a file in a linked project folder, in place on disk. */
function renameProjectFile(fromPath: string, nextName: string): Promise<void> {
  return withRenameToast(async () => {
    const renamed = await filesApi.rename(fromPath, nextName);
    emitLibraryEvent({ type: 'file-renamed', fromPath, toPath: renamed.path, name: renamed.name });
  });
}

/**
 * Copy-ID control in the right zone, styled exactly like the New-tab (+) and
 * Close (×) buttons beside it. Shows a check briefly after a successful copy.
 * Renders nothing for selections without a copyable entity id.
 */
const PaneCopyIdButton: FC<{ selection: DetailSelection }> = ({ selection }) => {
  const desc = useSelectionDescriptor(selection);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );
  if (!selection || !desc || !isEntityKind(desc.kind)) return null;
  const id = desc.id;
  return (
    <Button
      variant="neutral"
      size="sm"
      iconOnly
      className={styles.chromeIconBtn}
      onClick={(e) => {
        e.stopPropagation();
        if (!navigator.clipboard?.writeText) return;
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={copied ? 'ID copied!' : 'Copy ID'}
      aria-label={copied ? 'ID copied' : 'Copy ID'}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
};

/**
 * The `PathHeader` for whatever the pane shows. Agents have no library path,
 * so they render with empty ancestors. A project-root container renders as a
 * project (container icon in the project accent, project id on the copy chip)
 * to match the project surface in the body.
 */
const PaneChromePath: FC<{ selection: DetailSelection; ancestors: AncestorContainer[] }> = ({
  selection,
  ancestors,
}) => {
  const desc = useSelectionDescriptor(selection);
  const tableRename = useTableTitleRename(selection);
  const linkedFolders = useLinkedProjectFolders(
    selection?.kind === 'file' && isRenamableProjectFile(selection.node.name)
  );

  if (!selection || !desc) {
    return <span className={styles.crumbsEmpty}>Empty pane</span>;
  }

  // Support inline rename for docs, containers, threads, images and image
  // files in a linked folder in the breadcrumb. Custom Database tables rename
  // through their own session (`tableRename`), which keeps the field open for
  // a refused or conflicting name.
  const filePath =
    selection.kind === 'file' ? renamableFilePath(selection.node, linkedFolders) : null;
  const onRename =
    selection.kind === 'doc'
      ? (nextTitle: string) => renameDoc(selection.doc_id, nextTitle)
      : selection.kind === 'container'
        ? (nextTitle: string) => renameContainer(selection.container_id, nextTitle)
        : selection.kind === 'thread'
          ? (nextTitle: string) => renameThread(selection.thread_id, nextTitle)
          : selection.kind === 'image' && selection.node
            ? (nextName: string) =>
                renameImage(selection.image_id, nextName, selection.node?.name ?? '')
            : filePath
              ? (nextName: string) => renameProjectFile(filePath, nextName)
              : undefined;

  return (
    <PathHeader
      id={desc.id}
      title={desc.title}
      ancestors={desc.kind === 'agent' ? [] : ancestors.map((a) => a.name || 'Untitled')}
      icon={desc.icon}
      iconClassName={KIND_TO_ICON_CLASS[desc.kind]}
      onRename={onRename}
      rename={tableRename}
      // Tree content nodes (doc/thread/container/project/image) keep the
      // `/path/to/Title` breadcrumb; everything else (agents, settings,
      // single tools) renders a plain name. Copy ID lives in the right zone
      // (PaneCopyIdButton, beside + and ×), so the breadcrumb chip is off.
      variant={isPathKind(desc.kind) ? 'path' : 'plain'}
      showCopyId={false}
    />
  );
};

interface DropOverlayProps {
  zone: DropZone;
}

/**
 * Visual overlay shown during a drag-over. Highlights the half / quadrant
 * the drop would target so the user can confirm before releasing.
 */
const DropOverlay: FC<DropOverlayProps> = ({ zone }) => (
  <div className={styles.overlay} aria-hidden>
    <div className={`${styles.zone} ${styles[`zone-${zone}`]}`} />
  </div>
);

export { PaneChrome };
