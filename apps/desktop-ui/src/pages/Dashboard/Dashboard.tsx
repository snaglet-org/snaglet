import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
} from 'react';

import { ArchivedDrawer } from './components/ArchivedDrawer';
import { ArchiveDropZone } from './components/ArchiveDropZone';
import { CommandPalette } from './components/CommandPalette';
import { paletteFileToTreeNode } from './components/CommandPalette/paletteActions';
import { MoveConfirmationBanner } from './components/MoveConfirmationBanner';
import { useDashboardLayout } from './hooks/useDashboardLayout';
import { useHotkey } from './hooks/useHotkey';
import { useHomeHotkey } from './hooks/useHomeHotkey';
import { NEW_THREAD_TITLE, useQuickCreateHotkeys } from './hooks/useQuickCreateHotkeys';
import { useCreateFlow } from './hooks/useCreateFlow';
import { emitLibraryEvent } from '@desktop/utils/workspaceEvents';
import { showToast } from '@desktop/utils/toast';
import { ThreadAgentPickerModal } from '@desktop/features/workspace-tree/ThreadAgentPickerModal';
import { useReloadHotkey } from './hooks/useReloadHotkey';
import { useZoomHotkeys } from './hooks/useZoomHotkeys';
import { useSidebarReveal } from './hooks/useSidebarReveal';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { useRemovedNodeSync, useWorkspaceEventSync } from './hooks/useWorkspaceEventSync';
import { useMcpSelectionSync } from './hooks/useMcpSelectionSync';
import { useAgentSelectionSync } from './hooks/useAgentSelectionSync';
import { useTableSelectionSync } from './hooks/useTableSelectionSync';
import { DashboardNavigationProvider } from './selection/DashboardNavigationContext';
import type { PaneCallbacks } from './layout/PaneLayout';
import { PaneLayoutRecoveryBoundary } from './layout/PaneLayoutRecoveryBoundary';
import { activePaneSelectionIds, findLeaf, leafIds, openNodeIds } from './layout/paneTree';
import { sidebarRevealTarget, type AgentPageTab, type DetailSelection } from './selection/types';
import { useWorkspaceEventBridge } from '@desktop/ws/useWorkspaceEventBridge';
import { getCachedTableEntry } from '@desktop/features/database/tableNameCache';
import { AutomationsRunningSlot } from '@desktop/features/automations/AutomationsRunningSlot';
import { RemindersHost } from '@desktop/features/reminders/RemindersHost';
import {
  useAutomationsFeed,
  useRunningAutomations,
} from '@desktop/features/automations/automationsStore';
import { useSidebarBridge } from '@desktop/ws/useSidebarBridge';
import { useUiNavigationBridge } from '@desktop/ws/useUiNavigationBridge';
import {
  Button,
  ErrorBoundary,
  ConnectionHealthSlot,
  StatusBar,
  StatusBarProvider,
} from '@desktop/components';
import {
  ActiveAgentsSlot,
  HookRunsSlot,
  EmbeddingSlot,
  NotificationsSlot,
  QuickSearchSlot,
  DisableWorkersSlot,
  ReloadSlot,
  ZoomSlot,
} from '@desktop/components/StatusBar';
import { LeafToggle } from '@desktop/components/Icons';
import { agentsApi, threadsApi, toolsApi } from '@desktop/utils/api';
import { shortcutHint } from '@desktop/utils/platform';
import { paletteTableEntry, type PaletteSearchHit } from '@desktop/utils/api/palette-search';
import type { SnagletAgent, TableCatalogEntry } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { openSearchHit } from './openSearchHit';
import {
  ActivityBar,
  AgentsView,
  AutomationsView,
  ToolsView,
  SkillsView,
  WorkspaceView,
  SettingsView,
  McpConnectionsView,
  NewAgentModal,
  ProviderCatalogView,
  DEFAULT_SIDEBAR_VIEW,
  SIDEBAR_VIEW_STORAGE_KEY,
  sidebarViewFromStorage,
  type SidebarViewId,
} from './sidebar';
import { McpConnectionsProvider } from './views/McpConnections';
import { CalendarSidebar } from './views/CalendarView/CalendarSidebar';
import { onArchivedDrawerRequest } from './views/archivedDrawerRequest';
import { ProviderCatalogProvider } from './views/ProvidersView/ProviderCatalogContext';
import styles from './Dashboard.module.scss';

const SIDEBAR_STORAGE_KEY = 'snaglet.dashboard.sidebarOpen';

/**
 * The main workspace surface. The sidebar is an activity bar that switches
 * views, with the workspace search above every view. The main area is a
 * recursive pane layout: drop a sidebar item on a pane's edge to split it, or
 * on its center to replace its content. Each pane has its own selection; a
 * sidebar click fills the active pane (or the first leaf).
 */
const DashboardContent: FC = () => {
  const {
    layout,
    setLayout,
    resetPaneLayout,
    reopenForNewContent,
    activeLeafId,
    callbacks,
    selectedAgentId,
    openWorkspaceNode,
    navigatePaneByKey,
    openThreadAgent,
    openThreadWithFocusMessage,
    openAgent,
    openProfile,
    openHub,
    openProviders,
    openProvider,
    openCli,
    openTheme,
    openAgentInstructions,
    openStorage,
    openBrowser,
    openGetStarted,
    openMcpClientConnection,
    openMcpServerConnection,
    openDataSearch,
    openTool,
    openToolCreate,
    openHook,
    openSkillFile,
    openHookCreate,
    openAutomation,
    openAutomationCreate,
    openThreadById,
    openTableById,
    openTableEntry,
    openTableDraft,
    fillLeafId,
  } = useDashboardLayout();
  // One live automations list for the sidebar view, pane, activity bar and
  // status bar, kept current while the Automations view is closed too.
  useAutomationsFeed();
  const runningAutomations = useRunningAutomations().length;
  const activity = useMemo(
    () => (runningAutomations > 0 ? { automations: `${runningAutomations} running` } : undefined),
    [runningAutomations]
  );
  useWorkspaceEventSync(setLayout);
  useRemovedNodeSync(layout, setLayout);
  useMcpSelectionSync(setLayout);
  useAgentSelectionSync(layout, setLayout);
  useTableSelectionSync(setLayout);
  // Resizable sidebar — width persisted to localStorage, drag handle on right edge.
  const {
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    isResizing: isResizingSidebar,
    onResizerPointerDown: onSidebarResizerPointerDown,
    resetWidth: resetSidebarWidth,
    minWidth: sidebarMinWidth,
    maxWidth: sidebarMaxWidth,
  } = useSidebarWidth();

  // Per-surface "active row" ids derived from the active pane's selection
  // in one pass: workspace tree (nodeId), chat bridge (threadId), ToolsView
  // (toolId), AutomationsView (hookId), and SettingsView (settingsId). See
  // `activePaneSelectionIds` for the resolution rules.
  const {
    nodeId: activeNodeId,
    threadId: activeThreadId,
    toolId: activeToolSelectionId,
    hookId: activeHookSelectionId,
    skillId: activeSkillId,
    settingsId: activeSettingsSelectionId,
    mcpConnectionId: activeMcpConnectionId,
    providerId: activeProviderId,
    providerModelId: activeProviderModelId,
    tableId: activeTableId,
    automationId: activeAutomationId,
  } = useMemo(() => activePaneSelectionIds(layout, activeLeafId), [layout, activeLeafId]);

  // Set of node ids open in any pane — drives the tree's "open in a
  // pane" indicator. Recomputed from the layout so opening, closing, or
  // navigating a pane updates the tree live (layout is React state).
  const openPaneNodeIds = useMemo<Set<string>>(() => openNodeIds(layout), [layout]);

  // Agent-driven UI navigation: register this client, answer layout
  // queries, and apply `ui.navigate_pane` commands to panes.
  useUiNavigationBridge({ layout, activeThreadId, navigatePaneByKey });

  // Bumped on any workspace event so the library tree refetches; the
  // tree consumes it as `refreshNonce`.
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const bumpWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshNonce((n) => n + 1);
  }, []);
  const [agentRefreshNonce, setAgentRefreshNonce] = useState(0);
  const bumpAgentRefresh = useCallback(() => {
    setAgentRefreshNonce((n) => n + 1);
  }, []);
  // `activeThreadId` / `onOpenThread` serve the per-thread run-ended alert:
  // it stays quiet about the thread this focused window is already showing,
  // and a click on its banner opens the thread like a tray notification does.
  const openThreadFromAlert = useCallback(
    (threadId: string) => {
      openThreadById(threadId);
    },
    [openThreadById]
  );
  useWorkspaceEventBridge({
    onTreeEvent: bumpWorkspaceRefresh,
    onAgentEvent: bumpAgentRefresh,
    activeThreadId,
    onOpenThread: openThreadFromAlert,
  });

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  });
  const [archivedOpen, setArchivedOpen] = useState<boolean>(false);
  // A pane whose item was archived offers to open the drawer from inside it.
  useEffect(() => onArchivedDrawerRequest(() => setArchivedOpen(true)), []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarViewId>(() => {
    if (typeof window === 'undefined') return DEFAULT_SIDEBAR_VIEW;
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    return sidebarViewFromStorage(stored);
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, sidebarView);
  }, [sidebarView]);

  const sidebarPanelRef = useRef<HTMLDivElement>(null);
  useSidebarBridge({
    panelRef: sidebarPanelRef,
    width: sidebarWidth,
    setWidth: setSidebarWidth,
    open: sidebarOpen,
    activeTab: sidebarView,
    setOpen: setSidebarOpen,
    setActiveTab: setSidebarView,
  });

  const openSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarView(view);
    setSidebarOpen(true);
  }, []);

  const openProvidersFromTool = useCallback(() => {
    setSidebarView('providers');
    setSidebarOpen(true);
    openProviders();
  }, [openProviders]);

  // Persist sidebar visibility so the choice survives reload — matches the
  // VS Code "toggle sidebar" pattern.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarOpen));
  }, [sidebarOpen]);

  // Cmd/Ctrl+B toggles the sidebar (skip when typing — B is a letter
  // and likely-bound by editors like the markdown composer for bold).
  useHotkey({ key: 'b', meta: true, ignoreInEditable: true }, () => setSidebarOpen((v) => !v));
  // Cmd/Ctrl+K opens the command palette — global, fires from anywhere.
  useHotkey({ key: 'k', meta: true }, () => setPaletteOpen((v) => !v));
  // Cmd/Ctrl+R reloads the webview — the packaged Tauri shell has no
  // browser chrome, so this is the only refresh path. Global like ⌘K.
  useReloadHotkey();
  // Cmd/Ctrl +/−/0 zoom the UI — desktop shell only (the hook registers
  // nothing in a browser, where native zoom already owns these combos).
  useZoomHotkeys();
  // Cmd/Ctrl+Shift+H opens Home in the active pane (hub_home only; not while
  // typing). Pushed on the pane's history, so Cmd+[ returns.
  useHomeHotkey(openHub);
  // Cmd/Ctrl+Shift+D creates a doc and Cmd/Ctrl+Shift+C a container, at the
  // workspace level, and opens it in the active pane. Global, like ⌘K.
  // Cmd/Ctrl+Shift+T asks which agents to add, then opens the new thread.
  // A pane can start either flow too (Get started); its callback runs only on a create.
  const {
    open: pickingThreadAgents,
    start: openNewThread,
    finish: finishNewThread,
    cancel: cancelNewThread,
  } = useCreateFlow();
  useQuickCreateHotkeys(openWorkspaceNode, openNewThread);
  const createQuickThread = useCallback(
    async (agentIds: string[]) => {
      const { thread, failedAgentIds } = await threadsApi.createInProjectWithAgents(
        NEW_THREAD_TITLE,
        null,
        agentIds
      );
      finishNewThread();
      emitLibraryEvent({ type: 'tree-invalidated', ids: [] });
      openWorkspaceNode({
        kind: 'thread',
        id: thread.id,
        projectId: null,
        title: thread.title ?? NEW_THREAD_TITLE,
        sortOrder: 0,
        lastMessageAt: null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt || null,
      });
      if (failedAgentIds.length > 0) {
        showToast(
          `Thread created without ${failedAgentIds.length} agent${failedAgentIds.length === 1 ? '' : 's'}. Add them from the thread's Agents tab.`
        );
      }
    },
    [finishNewThread, openWorkspaceNode]
  );
  // The New agent form for panes (Get started); the Agents view's `+` opens its own.
  const {
    open: creatingAgent,
    start: openNewAgent,
    finish: finishNewAgent,
    cancel: cancelNewAgent,
  } = useCreateFlow();
  const onAgentCreated = useCallback(
    (agent: SnagletAgent) => {
      finishNewAgent();
      bumpAgentRefresh();
      openAgent(agent);
    },
    [bumpAgentRefresh, finishNewAgent, openAgent]
  );

  // Reveal coordination: pendingRevealId + nonce drive the library tree;
  // requestReveal is the public entry point for surfaces outside the
  // sidebar (icon pane, breadcrumb, deep links). `revealTargetView` tells
  // us which view the pending reveal is meant for so we only pass it to
  // that view (otherwise e.g. ToolsView would try to scroll to an agent id).
  const { pendingRevealId, revealTargetView, revealNonce, requestReveal } = useSidebarReveal({
    sidebarOpen,
    sidebarView,
    setSidebarOpen,
    setSidebarView,
  });

  // "Open in sidebar" (pane chrome button): resolve which sidebar view owns
  // the pane's selection and reveal it there. `useDashboardLayout` can't
  // provide this callback itself — `requestReveal` needs the sidebar
  // open/view state that lives here — so the bundle is completed at this
  // level before being handed to PaneLayout. Selections whose view can't
  // scroll to a row (id: null) still switch the sidebar to the owning view.
  const paneCallbacks = useMemo<PaneCallbacks>(
    () => ({
      ...callbacks,
      onOpenInSidebar: (selection: DetailSelection) => {
        const target = sidebarRevealTarget(selection);
        if (!target) return;
        if (target.id) {
          requestReveal(target.id, target.view);
          return;
        }
        setSidebarView(target.view);
        setSidebarOpen(true);
      },
    }),
    [callbacks, requestReveal]
  );

  /**
   * Library-kind search hit from the WorkspaceTree's inline search: a
   * workspace node the tree reveals and opens on its own, or a
   * memory/thread_summary/message hit, which opens its thread focused on
   * that entry (the per-agent context rail or the message itself). The
   * tree only fires this for hits it did not route to another sidebar
   * view (`onCrossViewReveal`).
   */
  const onLibraryHit = useCallback(
    (hit: PaletteSearchHit) => {
      // Pull the user back to the Workspace tab so the
      // tree body is visible alongside whatever pane just opened.
      setSidebarView('library');
      // Memory / thread_summary / message all need the per-thread chat
      // context to open with a specific focus. Hand off to the shared
      // dispatcher; for workspace nodes the tree's own search handler
      // already calls `onNodeClick` via the loaded nodeIndex.
      if (hit.kind === 'memory' || hit.kind === 'thread_summary' || hit.kind === 'message') {
        void openSearchHit(hit, {
          openWorkspaceNode,
          openThreadAgent,
          openThreadWithFocusMessage,
          openAgent,
          openTool,
        });
      }
    },
    [openWorkspaceNode, openThreadAgent, openThreadWithFocusMessage, openAgent, openTool]
  );

  // Calendar: one pane per window. The tab focuses the existing Calendar
  // pane, else opens one in the active pane.
  const openCalendarPane = useCallback(() => {
    const existing = leafIds(layout).find(
      (id) => findLeaf(layout, id)?.selection?.kind === 'calendar'
    );
    if (existing) {
      callbacks.onSelectLeaf(existing);
      return;
    }
    navigatePaneByKey(fillLeafId, { kind: 'calendar' }, activeThreadId, { mode: 'replace' });
  }, [layout, callbacks, navigatePaneByKey, fillLeafId, activeThreadId]);

  // A second pane to the right of the active one; the active pane keeps focus.
  const openBeside = useCallback(
    (selection: DetailSelection) => {
      navigatePaneByKey(null, selection, activeThreadId, {
        mode: 'split',
        splitZone: 'right',
        newPaneRatio: 0.45,
      });
    },
    [navigatePaneByKey, activeThreadId]
  );

  // Agent links (agent search hits, a chat's Configure model): resolve the
  // agent, then open it like a click on its sidebar row.
  const openAgentById = useCallback(
    (agentId: string, opts?: { tab?: AgentPageTab }) => {
      void agentsApi
        .get(agentId)
        .then((agent) => {
          if (agent) openAgent(agent, opts);
        })
        .catch((err: unknown) => {
          console.error('Dashboard: failed to open agent', getErrorMessage(err));
        });
    },
    [openAgent]
  );
  /**
   * Table chips, palette hits and tree-search hits carry a catalog id. The
   * live catalog entry (when cached) titles the pane chrome right away;
   * otherwise the hit's own entry does, and the pane fetches the rest.
   */
  const openTableByRef = useCallback(
    (tableId: string, hitEntry?: TableCatalogEntry) =>
      openTableById(tableId, getCachedTableEntry(tableId) ?? hitEntry),
    [openTableById]
  );

  /**
   * Search hit owned by another sidebar view (agent, tool,
   * table): reveal its row in that view and open it in the active pane, as
   * a click on the row would. Each kind has its own open API, so we
   * dispatch on `hit.kind`; fetch failures are logged, and the sidebar
   * reveal still lands.
   */
  const onCrossViewReveal = useCallback(
    (view: string, hit: PaletteSearchHit) => {
      requestReveal(hit.node_id, view as SidebarViewId);
      switch (hit.kind) {
        case 'agent':
          openAgentById(hit.node_id);
          return;
        case 'tool': {
          void toolsApi
            .get(hit.node_id)
            .then((tool) => {
              if (tool) openTool(tool);
            })
            .catch((err: unknown) => {
              console.error('Dashboard: failed to open tool from search hit', getErrorMessage(err));
            });
          return;
        }
        case 'table':
          // A catalog id, never a workspace node id.
          openTableByRef(hit.node_id, paletteTableEntry(hit.node_id, hit.payload) ?? undefined);
          return;
        default:
          return;
      }
    },
    [requestReveal, openAgentById, openTool, openTableByRef]
  );

  return (
    <StatusBarProvider>
      <DashboardNavigationProvider
        value={{
          openInPane: openWorkspaceNode,
          openTable: openTableByRef,
          openTableEntry,
          openTableDraft,
          openAgentById,
          openThread: openThreadById,
          openAutomation,
          openCalendar: openCalendarPane,
          openSidebarView,
          openBeside,
          openNewAgent,
          openNewThread,
          reopenForNewContent,
          openThreadAgent,
          requestReveal,
        }}
      >
        <div
          className={`${styles.shell} ${sidebarOpen ? '' : styles.shellSidebarHidden} ${isResizingSidebar ? styles.shellResizing : ''}`}
          data-page="dashboard"
          style={{ ['--db-sidebar-w' as string]: `${sidebarWidth}px` } as CSSProperties}
        >
          <Button
            variant="ghost"
            size="md"
            iconOnly
            className={styles.sidebarToggle}
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={sidebarOpen}
            aria-controls="dashboard-sidebar"
            title={`${sidebarOpen ? 'Hide' : 'Show'} sidebar (${shortcutHint('B')})`}
          >
            <LeafToggle open={sidebarOpen} className={styles.sidebarToggleLeaf} />
          </Button>
          <aside id="dashboard-sidebar" className={styles.sidebar} aria-label="Sidebar">
            {/* The activity strip stays visible even when the view panel is
              collapsed (VS Code pattern): clicking any icon while collapsed
              reopens the panel on that view; clicking the active view's
              icon while open collapses the panel. */}
            {/* The rail column holds the view-switching tabs. */}
            <div className={styles.railColumn}>
              <ActivityBar
                active={sidebarView}
                activity={activity}
                onSelect={(next) => {
                  if (!sidebarOpen) {
                    setSidebarView(next);
                    setSidebarOpen(true);
                  } else if (next === sidebarView) {
                    setSidebarOpen(false);
                  } else {
                    setSidebarView(next);
                  }
                  if (next === 'calendar' && (next !== sidebarView || !sidebarOpen)) {
                    openCalendarPane();
                  }
                }}
              />
            </div>
            {sidebarOpen && (
              <div ref={sidebarPanelRef} className={styles.viewPanel}>
                {/*
                WorkspaceView sits at the top of the view panel so its search
                bar shows on every tab: the full tree on the library tab, the
                search bar only (compact mode) elsewhere. Staying mounted keeps
                the tree loaded, so a library hit picked from another view
                opens at once when `onLibraryHit` switches back to library.
              */}
                <WorkspaceView
                  onNodeClick={openWorkspaceNode}
                  activeNodeId={activeNodeId}
                  activeTableId={activeTableId}
                  openNodeIds={openPaneNodeIds}
                  revealNodeId={revealTargetView === 'library' ? pendingRevealId : null}
                  revealNonce={revealNonce}
                  refreshNonce={workspaceRefreshNonce}
                  onCrossViewReveal={onCrossViewReveal}
                  onLibraryHit={onLibraryHit}
                  hideBody={sidebarView !== 'library'}
                />
                {sidebarView === 'calendar' && (
                  <CalendarSidebar
                    onOpenCalendar={openCalendarPane}
                    onOpenTable={openTableById}
                    onOpenAutomation={(automation) =>
                      openAutomation(automation.id, automation.name)
                    }
                  />
                )}
                {sidebarView === 'agents' && (
                  <AgentsView
                    onAgentClick={openAgent}
                    selectedAgentId={selectedAgentId}
                    revealNodeId={revealTargetView === 'agents' ? pendingRevealId : null}
                    revealNonce={revealNonce}
                    refreshNonce={agentRefreshNonce}
                  />
                )}
                {sidebarView === 'tools' && (
                  <ToolsView
                    onToolCreate={openToolCreate}
                    onToolClick={openTool}
                    onToolEdit={(tool) => openTool(tool, { edit: true })}
                    onOpenProviders={openProvidersFromTool}
                    activeSelectionId={activeToolSelectionId}
                    revealNodeId={revealTargetView === 'tools' ? pendingRevealId : null}
                    revealNonce={revealNonce}
                  />
                )}
                {sidebarView === 'skills' && (
                  <SkillsView onFileOpen={openSkillFile} activeSkillId={activeSkillId} />
                )}
                {sidebarView === 'automations' && (
                  <AutomationsView
                    onOpen={(automation) => openAutomation(automation.id, automation.name)}
                    onCreate={openAutomationCreate}
                    onScriptOpen={openHook}
                    onScriptCreate={openHookCreate}
                    activeAutomationId={activeAutomationId}
                    activeScriptName={activeHookSelectionId}
                    revealNodeId={revealTargetView === 'automations' ? pendingRevealId : null}
                    revealNonce={revealNonce}
                  />
                )}
                {sidebarView === 'mcp' && (
                  <McpConnectionsView
                    onClientOpen={openMcpClientConnection}
                    onServerOpen={openMcpServerConnection}
                    activeSelectionId={activeMcpConnectionId}
                  />
                )}
                {sidebarView === 'providers' && (
                  <ProviderCatalogView
                    onProviderOpen={openProvider}
                    activeProviderId={activeProviderId}
                    activeModelId={activeProviderModelId}
                  />
                )}
                {sidebarView === 'settings' && (
                  <SettingsView
                    onHomeClick={openHub}
                    onProfileClick={openProfile}
                    onCliClick={openCli}
                    onThemeClick={openTheme}
                    onAgentInstructionsClick={openAgentInstructions}
                    onStorageClick={openStorage}
                    onBrowserClick={openBrowser}
                    onGetStartedClick={openGetStarted}
                    onDataSearchClick={openDataSearch}
                    activeSelectionId={activeSettingsSelectionId}
                  />
                )}
                <div className={styles.viewBottomBar}>
                  <ArchiveDropZone
                    onToggleDrawer={() => setArchivedOpen((v) => !v)}
                    drawerOpen={archivedOpen}
                  />
                </div>
              </div>
            )}
            {sidebarOpen && (
              <div
                className={`${styles.sidebarResizer} ${isResizingSidebar ? styles.sidebarResizerActive : ''}`}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                aria-valuemin={sidebarMinWidth}
                aria-valuemax={sidebarMaxWidth}
                aria-valuenow={sidebarWidth}
                onPointerDown={onSidebarResizerPointerDown}
                onDoubleClick={resetSidebarWidth}
                title="Drag to resize sidebar · double-click to reset"
              />
            )}
          </aside>
          <main className={styles.main}>
            <MoveConfirmationBanner />
            <PaneLayoutRecoveryBoundary
              layout={layout}
              activeLeafId={activeLeafId}
              callbacks={paneCallbacks}
              onReset={resetPaneLayout}
            />
          </main>
          {/*
           * The status bar, rendered once at the shell root in the grid's
           * second row so it spans the full width below every pane. Features
           * fill its left / center / right zones through useStatusBarSlot;
           * ConnectionHealthSlot renders null and pushes the WS-connection
           * readout into the left zone.
           */}
          <QuickSearchSlot onOpen={() => setPaletteOpen(true)} />
          <ConnectionHealthSlot />
          <ActiveAgentsSlot />
          <HookRunsSlot />
          <AutomationsRunningSlot />
          <EmbeddingSlot />
          <NotificationsSlot />
          <DisableWorkersSlot />
          <ZoomSlot />
          <ReloadSlot />
          <StatusBar />
          {/* Reminder banners (top right), their sound and the native schedule. */}
          <RemindersHost />
          {archivedOpen && (
            <ArchivedDrawer open={archivedOpen} onClose={() => setArchivedOpen(false)} />
          )}
          {pickingThreadAgents && (
            <ThreadAgentPickerModal
              threadTitle={NEW_THREAD_TITLE}
              onCancel={cancelNewThread}
              onCreate={createQuickThread}
            />
          )}
          {creatingAgent && <NewAgentModal onClose={cancelNewAgent} onCreated={onAgentCreated} />}
          {/*
           * A render error inside the palette must degrade to a *closed* palette
           * (+ a console error) rather than blanking the entire app. The boundary
           * is keyed on `paletteOpen` so each open mounts a fresh boundary — a
           * crash on one open never poisons the next. `fallback={null}` renders
           * nothing; `onError` flips the palette closed.
           */}
          <ErrorBoundary
            key={paletteOpen ? 'palette-open' : 'palette-closed'}
            fallback={null}
            onError={() => setPaletteOpen(false)}
          >
            <CommandPalette
              open={paletteOpen}
              activeNodeId={activeNodeId}
              onClose={() => setPaletteOpen(false)}
              onSelect={openWorkspaceNode}
              onOpenThreadAgent={openThreadAgent}
              onOpenThreadWithFocusMessage={openThreadWithFocusMessage}
              onOpenTool={openTool}
              onOpenAgent={openAgent}
              onOpenTable={openTableByRef}
              onOpenEntry={openTableEntry}
              onOpenFile={(file) => openWorkspaceNode(paletteFileToTreeNode(file))}
            />
          </ErrorBoundary>
        </div>
      </DashboardNavigationProvider>
    </StatusBarProvider>
  );
};

const Dashboard: FC = () => (
  <McpConnectionsProvider>
    <ProviderCatalogProvider>
      <DashboardContent />
    </ProviderCatalogProvider>
  </McpConnectionsProvider>
);

export { Dashboard };
