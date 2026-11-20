import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  FileTreeNode,
  HookWorkspaceInfo,
  LibraryTreeChild,
  McpApiKey,
  McpServer,
  ModelRow,
  Provider,
  ThreadTreeNode,
  ToolRow,
} from '@desktop/utils/api';
import { archiveApi, containersApi, settingsApi } from '@desktop/utils/api';
import { onLibraryEvent } from '@desktop/utils/workspaceEvents';
import { onOpenThread } from '@desktop/utils/openThread';
import type {
  SnagletAgent,
  PaneNavigationMode,
  PaneSplitZone,
  TableCatalogEntry,
} from '@snaglet/shared/types';
import { generateId } from '@snaglet/shared/utils';
import {
  hydrateWorkspaceSelection,
  selectionFromWorkspaceNode,
  unresolvedWorkspaceNodeId,
  type AgentPageTab,
  type DataSearchTab,
  type DetailSelection,
} from '../selection/types';
import { indexWorkspaceNodes } from '../selection/workspaceNodeIndex';
import { nextFocusRequestId } from '../selection/focusRequest';
import { getCachedTableEntry } from '@desktop/features/database/tableNameCache';
import { type PaneCallbacks } from '../layout/PaneLayout';
import {
  closeLeaf,
  createLeaf,
  findLeaf,
  goBackInLeaf,
  goForwardInLeaf,
  jumpToHistoryEntry,
  leafIds,
  mapSelections,
  repairPaneLayout,
  replaceLeafSelection,
  reportPaneLayoutRepairs,
  splitLeafWithResult,
  updateSplitRatios,
  type LayoutNode,
} from '../layout/paneTree';
import {
  itemsMissingFromTree,
  layoutFitsWorkspace,
  loadPersistedDashboard,
  PERSIST_DEBOUNCE_MS,
  savePersistedDashboard,
  type PersistedDashboard,
} from '../persistence';
import { hubLaunchLeafId, openLaunchPanes } from '../layout/hubLaunch';
import { launchPanes, refreshOnboarding } from '@desktop/features/onboarding';
import { HUB_HOME_FLAG } from '@snaglet/shared/types';
import {
  useFeatureFlag,
  useFeatureFlagsSettled,
} from '@desktop/features/featureFlags/FeatureFlagsContext';

/** The pane sidebar clicks fill: the active one, else the first in reading order. */
function resolveFillLeafId(state: { layout: LayoutNode; activeLeafId: string | null }) {
  const { layout, activeLeafId } = state;
  if (activeLeafId && findLeaf(layout, activeLeafId)) return activeLeafId;
  return leafIds(layout)[0] ?? null;
}

/**
 * The narrowest window that opens Home and Get started side by side at
 * launch: about 400 px for each pane beside the activity bar and the default
 * sidebar. The default window (1200 px) qualifies; a narrower one opens Get
 * started alone.
 */
const TWO_LAUNCH_PANES_MIN_WIDTH = 1100;

/** The first-run state as the launch read it; `onboarding` is null when the read failed. */
type FirstRunRead =
  | { read: false }
  | { read: true; onboarding: Parameters<typeof launchPanes>[0]['onboarding'] };

/** The workspace now open (`workspace.id`), or null when it cannot be read. */
async function readWorkspaceId(): Promise<string | null> {
  try {
    const { value } = await settingsApi.get('workspace', 'id');
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** Whether any of `ids` is in the archive (its pane says so instead of "isn't available"). */
async function anyArchived(ids: readonly string[]): Promise<boolean> {
  const { roots, children } = await archiveApi.list();
  const archived = new Set([...roots, ...children].map((node) => node.id));
  return ids.some((id) => archived.has(id));
}

/** First retry after a failed workspace-tree read for ID-only panes; doubles per failure. */
const HYDRATION_RETRY_BASE_MS = 2_000;
const HYDRATION_RETRY_MAX_MS = 30_000;

interface AgentPaneNavigationOptions {
  mode?: PaneNavigationMode;
  splitZone?: PaneSplitZone;
  newPaneRatio?: number;
}

export interface UseDashboardLayoutResult {
  layout: LayoutNode;
  setLayout: React.Dispatch<React.SetStateAction<LayoutNode>>;
  /** Reset only pane layout state after an isolated renderer failure. */
  resetPaneLayout: () => void;
  /**
   * After a reset or snapshot restore replaced the content: read the new
   * workspace id and open the launch panes in place of every pane.
   */
  reopenForNewContent: () => void;
  activeLeafId: string | null;
  /** Callbacks bundled into one object so the recursive PaneLayout only threads one prop. */
  callbacks: PaneCallbacks;
  /** Pane-id that sidebar clicks land in: explicit active else first leaf. */
  fillLeafId: string | null;
  /**
   * agentId of the first leaf currently showing an agent — drives the
   * AgentsList active-state highlight in the sidebar.
   */
  selectedAgentId: string | null;
  /** Open a workspace node in the active pane (or first leaf if none active). */
  openWorkspaceNode: (node: LibraryTreeChild | FileTreeNode) => void;
  /**
   * Agent-driven navigation: apply a resolved selection to a pane by
   * its key. Split mode preserves the current active pane; replace mode falls
   * back to a non-active-thread pane. Returns the opened/replaced leaf id, or
   * null if there is no pane.
   */
  navigatePaneByKey: (
    paneKey: string | null | undefined,
    selection: DetailSelection,
    activeThreadId?: string | null,
    options?: AgentPaneNavigationOptions
  ) => string | null;
  /**
   * Open a thread in the active pane directly into its settings → Agents
   * tab with `agentId` preselected. See DetailSelection's `focusAgentId`
   * for how the receiving ChatView routes the selection.
   *
   * Optional `opts.focus` further targets a specific memory or summary
   * inside the per-agent context rail — the rail's tab strip switches
   * to the matching surface and scrolls the matching row into view.
   */
  openThreadAgent: (
    thread: ThreadTreeNode,
    agentId: string,
    opts?: { focus?: { kind: 'memory' | 'summary'; id: string } }
  ) => void;
  /**
   * Open a thread in the active pane focused on a specific message — the
   * chat loads a window centered on `messageId` instead of the most
   * recent page, and the message list holds that row in view, highlighted.
   * Used by message search hits routed through `openSearchHit`.
   */
  openThreadWithFocusMessage: (thread: ThreadTreeNode, messageId: string) => void;
  /**
   * Open an agent in the active pane (or first leaf if none active).
   * `opts.tab` brings that tab up, even on a page already showing.
   */
  openAgent: (agent: SnagletAgent, opts?: { tab?: AgentPageTab }) => void;
  /** Open the user's profile editor in the active pane. */
  openProfile: () => void;
  /** Open the Home pane (`hub_home` flag) in the active pane. */
  openHub: () => void;
  /** Open the providers / integrations manager in the active pane. */
  openProviders: () => void;
  /** Open one provider, optionally focused on a model, in the active pane. */
  openProvider: (provider: Provider, model?: ModelRow) => void;
  /** Open the packaged command-line installer in the active pane. */
  openCli: () => void;
  /** Open the workspace theme customization pane in the active pane. */
  openTheme: () => void;
  /** Open the instructions-for-all-agents pane in the active pane. */
  openAgentInstructions: () => void;
  /** Open the storage and voice models pane in the active pane. */
  openStorage: () => void;
  openBrowser: () => void;
  /** Open the Get started pane (connect a provider, meet Patty) in the active pane. */
  openGetStarted: () => void;
  /** Open an external MCP client connection in the active pane. */
  openMcpClientConnection: (client: McpApiKey) => void;
  /** Open an upstream MCP server connection in the active pane. */
  openMcpServerConnection: (server: McpServer) => void;
  /** Open a Data or feature-gated Dev view in the active pane. */
  openDataSearch: (tab: DataSearchTab) => void;
  /**
   * Open a single tool. Defaults to the view/run face (ToolView); pass
   * `{ edit: true }` to land straight on the pane-hosted ToolBuilderPanel
   * instead (see ToolPane) — used by ToolsView's per-row
   * Edit pencil.
   */
  openTool: (tool: ToolRow, opts?: { edit?: boolean }) => void;
  /** Open the tool builder in create mode in the active pane. */
  openToolCreate: () => void;
  /**
   * Open a single hook (the pane-hosted HookBuilderPanel — hooks have no
   * separate view/run face, see HookBuilderView's doc comment).
   */
  openHook: (hook: HookWorkspaceInfo) => void;
  /** Open one file of a skill folder read-only. */
  openSkillFile: (skill: { id: string; slug: string }, path: string) => void;
  /** Open the hook builder in create mode in the active pane. */
  openHookCreate: () => void;
  /** Open one automation in the active pane; `name` titles it at once. */
  openAutomation: (automationId: string, name?: string) => void;
  /** Open the New automation form in the active pane. */
  openAutomationCreate: () => void;
  /**
   * Open a thread by id. With a title the pane is named at once; without
   * one the hydration pass names it from the workspace tree.
   */
  openThreadById: (threadId: string, title?: string | null) => void;
  /**
   * Open a Database table by catalog id (table chips, palette and search
   * hits). `table`, when known, titles the pane chrome; the pane fetches the
   * canonical entry itself either way.
   */
  openTableById: (tableId: string, table?: TableCatalogEntry) => void;
  /**
   * Open a table with one entry: sought out and highlighted in its grid
   * (`highlight`, the default), or with its window open over the table
   * (`window`).
   */
  openTableEntry: (tableId: string, entryId: string, how?: 'highlight' | 'window') => void;
  /**
   * Open a new, unnamed table draft in the active pane. The draft's id is
   * minted here and becomes the table's catalog id when it is saved. With a
   * `projectId` the table is created in that project; null or absent makes
   * it workspace-wide.
   */
  openTableDraft: (projectId?: string | null) => void;
}

/**
 * Owns the pane tree, the active-leaf pointer, the callback bundle PaneLayout
 * consumes, and persistence (load on mount, debounced save on change).
 * `restored` is kept in state so the activeLeafId initializer validates the
 * restored id against the same layout the layout state started from.
 */
export function useDashboardLayout(): UseDashboardLayoutResult {
  const [restored] = useState<PersistedDashboard | null>(() => loadPersistedDashboard());
  type PaneState = {
    layout: LayoutNode;
    activeLeafId: string | null;
  };
  const [paneState, setRenderedPaneState] = useState<PaneState>(() => {
    const layout = restored?.layout ?? createLeaf(null);
    const activeLeafId =
      restored?.activeLeafId && findLeaf(layout, restored.activeLeafId)
        ? restored.activeLeafId
        : null;
    return { layout, activeLeafId };
  });
  const paneStateRef = useRef(paneState);
  const updatePaneState = useCallback((updater: (previous: PaneState) => PaneState): PaneState => {
    const previous = paneStateRef.current;
    const next = updater(previous);
    if (next !== previous) {
      paneStateRef.current = next;
      setRenderedPaneState(next);
    }
    return next;
  }, []);
  const { layout, activeLeafId } = paneState;

  // The pane that was empty at launch, which the launch panes fill (see the
  // launch effects below). Null when a saved layout was restored.
  const [launchLeafId, setLaunchLeafId] = useState(() => hubLaunchLeafId(paneStateRef.current));
  const [firstRun, setFirstRun] = useState<FirstRunRead>({ read: false });
  const homeHandledRef = useRef(false);
  const launchHandledRef = useRef(false);
  // True while the panes are the restored layout, which is checked against
  // the workspace now open: its id, and whether its items still exist.
  const restoredShownRef = useRef(restored !== null && launchLeafId === null);

  /**
   * Replace every pane with what a window with nothing to restore opens: Home,
   * with Get started beside it while the first run is unfinished. For a
   * restored layout that belongs to other content, and after a reset.
   */
  const openFreshPanes = useCallback(() => {
    restoredShownRef.current = false;
    const leaf = createLeaf(null);
    updatePaneState(() => ({ layout: leaf, activeLeafId: leaf.id }));
    homeHandledRef.current = false;
    launchHandledRef.current = false;
    setFirstRun({ read: false });
    setLaunchLeafId(leaf.id);
  }, [updatePaneState]);

  // The workspace now open, stamped on every saved layout. A restored layout
  // saved for another workspace (the content was reset, restored from a
  // snapshot, or is another Snaglet home) gives way to the launch panes. The
  // layout shows meanwhile, so a matching one never waits or flashes.
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    void readWorkspaceId().then((id) => {
      if (canceled) return;
      setWorkspaceId(id);
      if (restored && restoredShownRef.current && !layoutFitsWorkspace(restored, id)) {
        openFreshPanes();
      }
    });
    return () => {
      canceled = true;
    };
  }, [restored, openFreshPanes]);

  /** After a reset or restore: the new workspace's id, and the launch panes. */
  const reopenForNewContent = useCallback(() => {
    void readWorkspaceId().then((id) => {
      if (id) setWorkspaceId(id);
    });
    openFreshPanes();
  }, [openFreshPanes]);

  // A restored layout whose panes all point at items the workspace tree no
  // longer lists, none of them archived, would only say "This item isn't
  // available": it gives way to the launch panes too. Checked once, on the
  // first tree read; the archive is read only when every item is missing.
  const missingCheckedRef = useRef(false);
  const checkRestoredItems = useCallback(
    (tree: ReadonlyMap<string, unknown>) => {
      if (missingCheckedRef.current || !restoredShownRef.current) return;
      missingCheckedRef.current = true;
      const missing = itemsMissingFromTree(paneStateRef.current.layout, tree);
      if (!missing) return;
      void anyArchived(missing)
        .then((archived) => {
          if (!archived && restoredShownRef.current) openFreshPanes();
        })
        .catch((err: unknown) => {
          // The layout stays; its panes explain themselves.
          console.error('useDashboardLayout: could not read the archive', err);
        });
    },
    [openFreshPanes]
  );

  const setLayout = useCallback<React.Dispatch<React.SetStateAction<LayoutNode>>>(
    (action) => {
      updatePaneState((previous) => {
        const candidate =
          typeof action === 'function'
            ? (action as (current: LayoutNode) => LayoutNode)(previous.layout)
            : action;
        const repaired = repairPaneLayout(candidate);
        reportPaneLayoutRepairs('state-update', repaired.repairs);
        return repaired.layout === previous.layout
          ? previous
          : { ...previous, layout: repaired.layout };
      });
    },
    [updatePaneState]
  );
  const setActiveLeafId = useCallback<React.Dispatch<React.SetStateAction<string | null>>>(
    (action) => {
      updatePaneState((previous) => {
        const next =
          typeof action === 'function'
            ? (action as (current: string | null) => string | null)(previous.activeLeafId)
            : action;
        return next === previous.activeLeafId ? previous : { ...previous, activeLeafId: next };
      });
    },
    [updatePaneState]
  );

  // Restored layouts and agent navigation may hold only a workspace node id.
  // Hydrate those selections, history entries included, from the workspace
  // tree so every pane surface shares one node shape. A failed read retries
  // on a backoff timer; any unresolved id also retries on the next
  // `tree-invalidated` (socket reconnect, remote change) or `archive-changed`.
  // Meanwhile the pane looks the item up itself (UnresolvedWorkspaceItem).
  const unresolvedNodeKey = useMemo(() => {
    const ids = new Set<string>();
    mapSelections(layout, (selection) => {
      const id = unresolvedWorkspaceNodeId(selection);
      if (id) ids.add(id);
      return selection;
    });
    return [...ids].sort().join('\u0000');
  }, [layout]);

  const [hydrationRetry, setHydrationRetry] = useState(0);
  const hydrationFailuresRef = useRef(0);

  useEffect(() => {
    if (!unresolvedNodeKey) return;
    return onLibraryEvent((event) => {
      if (
        event.type === 'tree-invalidated' ||
        event.type === 'created' ||
        (event.type === 'archive-changed' && event.reload)
      ) {
        setHydrationRetry((value) => value + 1);
      }
    });
  }, [unresolvedNodeKey]);

  useEffect(() => {
    if (!unresolvedNodeKey) return;
    let canceled = false;
    let retryTimer: number | undefined;
    const unresolvedIds = new Set(unresolvedNodeKey.split('\u0000'));
    void containersApi
      .listTree()
      .then((tree) => {
        if (canceled) return;
        hydrationFailuresRef.current = 0;
        const indexed = indexWorkspaceNodes(tree);
        checkRestoredItems(indexed);
        setLayout((current) =>
          mapSelections(current, (selection) => {
            const id = unresolvedWorkspaceNodeId(selection);
            if (!id || !unresolvedIds.has(id)) return selection;
            return hydrateWorkspaceSelection(selection, indexed.get(id));
          })
        );
      })
      .catch((err: unknown) => {
        if (canceled) return;
        // The pane keeps its ID-only state; try again after a growing delay
        // (or sooner, on the next tree refresh).
        console.error('useDashboardLayout: failed to hydrate workspace selections', err);
        hydrationFailuresRef.current += 1;
        const delay = Math.min(
          HYDRATION_RETRY_MAX_MS,
          HYDRATION_RETRY_BASE_MS * 2 ** (hydrationFailuresRef.current - 1)
        );
        retryTimer = window.setTimeout(() => setHydrationRetry((value) => value + 1), delay);
      });
    return () => {
      canceled = true;
      window.clearTimeout(retryTimer);
    };
  }, [unresolvedNodeKey, hydrationRetry, checkRestoredItems]);

  // Persist layout + active leaf so a reload returns you to whatever
  // panes / docs / threads / agents you had open, with each pane's
  // back/forward history intact. Debounced because resize drags fire
  // setLayout once per mouse-move — collapsing those into a single
  // trailing write avoids hammering localStorage during the drag.
  useEffect(() => {
    // The cleanup cancels a superseded snapshot before its callback can run.
    // localStorage writes are synchronous, so no second async sequence layer
    // is needed: a callback writes exactly the normalized layout it captured.
    const id = window.setTimeout(() => {
      // Until the workspace id is read, a restored layout keeps its own stamp.
      savePersistedDashboard({
        layout,
        activeLeafId,
        workspaceId: workspaceId ?? restored?.workspaceId ?? null,
      });
    }, PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [layout, activeLeafId, workspaceId, restored]);

  // A window with nothing to restore opens on Home (`hub_home` flag), on Get
  // started (a new install, or a workspace with no provider yet), or on both
  // side by side (`launchPanes`). Decided once, for the pane that was empty at
  // launch: a saved layout is left as it was, a pane the person filled before
  // the reads came back is not replaced, and a later flag refresh never moves
  // a pane. Home opens as soon as the flags settle; Get started joins it once
  // the first-run state has been read.
  const hubEnabled = useFeatureFlag(HUB_HOME_FLAG);
  const flagsSettled = useFeatureFlagsSettled();
  useEffect(() => {
    if (!launchLeafId) return;
    let canceled = false;
    void refreshOnboarding().then((onboarding) => {
      if (!canceled)
        setFirstRun({ read: true, onboarding: onboarding.status === 'ready' ? onboarding : null });
    });
    return () => {
      canceled = true;
    };
  }, [launchLeafId]);

  useEffect(() => {
    if (!launchLeafId || !flagsSettled) return;
    if (!homeHandledRef.current) {
      homeHandledRef.current = true;
      if (hubEnabled) {
        updatePaneState((previous) => openLaunchPanes(previous, launchLeafId, 'home'));
      }
    }
    if (!firstRun.read || launchHandledRef.current) return;
    launchHandledRef.current = true;
    const panes = launchPanes({
      hubEnabled,
      onboarding: firstRun.onboarding,
      twoPanesFit: window.innerWidth >= TWO_LAUNCH_PANES_MIN_WIDTH,
    });
    if (panes === 'home' || panes === 'empty') return;
    updatePaneState((previous) => openLaunchPanes(previous, launchLeafId, panes));
  }, [launchLeafId, flagsSettled, hubEnabled, firstRun, updatePaneState]);

  const resetPaneLayout = useCallback(() => {
    updatePaneState(() => ({ layout: createLeaf(null), activeLeafId: null }));
  }, [updatePaneState]);

  // Resolve the leaf to fill on sidebar-click. Prefer the explicitly
  // active leaf if it exists; otherwise fall back to the first leaf in
  // document order so a fresh dashboard still responds to clicks.
  const fillLeafId = useMemo(() => resolveFillLeafId(paneState), [paneState]);

  const selectedAgentId = useMemo(() => {
    const ids = leafIds(layout);
    for (const id of ids) {
      const leaf = findLeaf(layout, id);
      if (leaf?.selection?.kind === 'agent') return leaf.selection.agent.id;
    }
    return null;
  }, [layout]);

  // Resolved against the latest pane state, not a render's fillLeafId, so an
  // opener called after an await (an agent or tool fetch) fills the pane that
  // is active now and never re-activates one that has closed meanwhile.
  const setSelectionInActivePane = useCallback(
    (selection: DetailSelection) => {
      updatePaneState((previous) => {
        const target = resolveFillLeafId(previous);
        if (!target) return previous;
        const layout = replaceLeafSelection(previous.layout, target, selection);
        if (layout === previous.layout && previous.activeLeafId === target) return previous;
        return { layout, activeLeafId: target };
      });
    },
    [updatePaneState]
  );

  /**
   * Agent navigation: apply a resolved `DetailSelection` from
   * `navigate_user_pane`. Split mode (the default) splits the current pane and
   * keeps the active leaf, so the chat stays in view. Replace mode fills the
   * named pane, else the first one not showing the active thread.
   */
  const navigatePaneByKey = useCallback(
    (
      paneKey: string | null | undefined,
      selection: DetailSelection,
      activeThreadId?: string | null,
      options: AgentPaneNavigationOptions = {}
    ): string | null => {
      let openedId: string | null = null;
      const mode = options.mode ?? 'split';
      const splitZone = options.splitZone ?? 'right';
      const newPaneRatio = options.newPaneRatio ?? 0.38;

      updatePaneState((previous) => {
        const ids = leafIds(previous.layout);
        if (ids.length === 0) return previous;

        const explicitId = paneKey && ids.includes(paneKey) ? paneKey : null;

        if (mode === 'replace') {
          const fallbackId =
            ids.find((id) => {
              const leaf = findLeaf(previous.layout, id);
              const sel = leaf?.selection;
              const isActiveThread =
                !!activeThreadId && sel?.kind === 'thread' && sel.thread_id === activeThreadId;
              return !isActiveThread;
            }) ?? ids[0];
          openedId = explicitId ?? fallbackId;
          return {
            layout: replaceLeafSelection(previous.layout, openedId, selection),
            activeLeafId: openedId,
          };
        }

        const activeThreadLeafId = ids.find((id) => {
          const leaf = findLeaf(previous.layout, id);
          const sel = leaf?.selection;
          return !!activeThreadId && sel?.kind === 'thread' && sel.thread_id === activeThreadId;
        });
        const sourceId =
          explicitId ??
          (previous.activeLeafId && ids.includes(previous.activeLeafId)
            ? previous.activeLeafId
            : null) ??
          activeThreadLeafId ??
          ids[0];
        if (!sourceId) return previous;

        const split = splitLeafWithResult(previous.layout, sourceId, splitZone, selection, {
          newPaneRatio,
        });
        openedId = split.insertedLeafId ?? sourceId;
        return split.layout === previous.layout ? previous : { ...previous, layout: split.layout };
      });

      return openedId;
    },
    [updatePaneState]
  );

  // Workspace tree clicks already carry the hydrated node, so their panes can
  // render immediately without waiting for the ID-resolution pass above.
  const openWorkspaceNode = useCallback(
    (node: LibraryTreeChild | FileTreeNode) => {
      return node.kind === 'file'
        ? setSelectionInActivePane({ kind: 'file', node })
        : setSelectionInActivePane(selectionFromWorkspaceNode(node));
    },
    [setSelectionInActivePane]
  );
  const openThreadAgent = useCallback(
    (
      thread: ThreadTreeNode,
      agentId: string,
      opts?: { focus?: { kind: 'memory' | 'summary'; id: string } }
    ) =>
      setSelectionInActivePane({
        kind: 'thread',
        thread_id: thread.id,
        node: thread,
        focusAgentId: agentId,
        focusMemoryId: opts?.focus?.kind === 'memory' ? opts.focus.id : undefined,
        focusSummaryId: opts?.focus?.kind === 'summary' ? opts.focus.id : undefined,
      }),
    [setSelectionInActivePane]
  );
  const openThreadWithFocusMessage = useCallback(
    (thread: ThreadTreeNode, messageId: string) =>
      setSelectionInActivePane({
        kind: 'thread',
        thread_id: thread.id,
        node: thread,
        focusMessageId: messageId,
        // Every hit is a distinct seek, even for the thread (and message)
        // already on screen — ChatView keys off this, not the thread id.
        focusRequestId: nextFocusRequestId(),
      }),
    [setSelectionInActivePane]
  );
  const openAgent = useCallback(
    (agent: SnagletAgent, opts?: { tab?: AgentPageTab }) =>
      setSelectionInActivePane(
        opts?.tab
          ? { kind: 'agent', agent, focusTab: opts.tab, focusRequestId: nextFocusRequestId() }
          : { kind: 'agent', agent }
      ),
    [setSelectionInActivePane]
  );
  const openProfile = useCallback(
    () => setSelectionInActivePane({ kind: 'profile' }),
    [setSelectionInActivePane]
  );
  const openHub = useCallback(
    () => setSelectionInActivePane({ kind: 'hub' }),
    [setSelectionInActivePane]
  );
  const openProviders = useCallback(
    () => setSelectionInActivePane({ kind: 'providers' }),
    [setSelectionInActivePane]
  );
  const openProvider = useCallback(
    (provider: Provider, model?: ModelRow) =>
      setSelectionInActivePane({
        kind: 'provider',
        provider_id: provider.id,
        name: provider.name,
        provider_type: provider.type,
        focusModelId: model?.id,
      }),
    [setSelectionInActivePane]
  );
  const openCli = useCallback(
    () => setSelectionInActivePane({ kind: 'cli' }),
    [setSelectionInActivePane]
  );
  const openTheme = useCallback(
    () => setSelectionInActivePane({ kind: 'theme' }),
    [setSelectionInActivePane]
  );
  const openAgentInstructions = useCallback(
    () => setSelectionInActivePane({ kind: 'agent-instructions' }),
    [setSelectionInActivePane]
  );
  const openBrowser = useCallback(
    () => setSelectionInActivePane({ kind: 'browser' }),
    [setSelectionInActivePane]
  );
  const openStorage = useCallback(
    () => setSelectionInActivePane({ kind: 'storage' }),
    [setSelectionInActivePane]
  );
  const openGetStarted = useCallback(
    () => setSelectionInActivePane({ kind: 'get-started' }),
    [setSelectionInActivePane]
  );
  const openMcpClientConnection = useCallback(
    (client: McpApiKey) =>
      setSelectionInActivePane({
        kind: 'mcp-client-connection',
        client_id: client.id,
        name: client.name,
      }),
    [setSelectionInActivePane]
  );
  const openMcpServerConnection = useCallback(
    (server: McpServer) =>
      setSelectionInActivePane({
        kind: 'mcp-server-connection',
        server_id: server.id,
        name: server.name,
      }),
    [setSelectionInActivePane]
  );
  const openDataSearch = useCallback(
    (tab: DataSearchTab) => setSelectionInActivePane({ kind: 'embeddings', tab }),
    [setSelectionInActivePane]
  );
  const openTool = useCallback(
    (tool: ToolRow, opts?: { edit?: boolean }) =>
      setSelectionInActivePane({ kind: 'tool', tool, edit: opts?.edit }),
    [setSelectionInActivePane]
  );
  const openToolCreate = useCallback(
    () => setSelectionInActivePane({ kind: 'tool-create' }),
    [setSelectionInActivePane]
  );
  const openHook = useCallback(
    (hook: HookWorkspaceInfo) => setSelectionInActivePane({ kind: 'hook', hook }),
    [setSelectionInActivePane]
  );
  const openSkillFile = useCallback(
    (skill: { id: string; slug: string }, path: string) =>
      setSelectionInActivePane({ kind: 'skill', skill_id: skill.id, slug: skill.slug, path }),
    [setSelectionInActivePane]
  );

  const openHookCreate = useCallback(
    () => setSelectionInActivePane({ kind: 'hook-create' }),
    [setSelectionInActivePane]
  );
  const openAutomation = useCallback(
    (automationId: string, name?: string) =>
      setSelectionInActivePane(
        name
          ? { kind: 'automation-detail', automation_id: automationId, name }
          : { kind: 'automation-detail', automation_id: automationId }
      ),
    [setSelectionInActivePane]
  );
  const openAutomationCreate = useCallback(
    () => setSelectionInActivePane({ kind: 'automation-create' }),
    [setSelectionInActivePane]
  );
  // A titled stub names the pane at once; an id-only selection is filled in
  // from the workspace tree by the hydration pass above.
  const openThreadById = useCallback(
    (threadId: string, title?: string | null) =>
      setSelectionInActivePane(
        title
          ? {
              kind: 'thread',
              thread_id: threadId,
              node: {
                kind: 'thread',
                id: threadId,
                projectId: null,
                title,
                sortOrder: 0,
                lastMessageAt: null,
                createdAt: '',
                updatedAt: null,
              },
            }
          : { kind: 'thread', thread_id: threadId }
      ),
    [setSelectionInActivePane]
  );
  // Surfaces outside this hook (e.g. the DM Fork confirmation toast) open a
  // workspace thread through the global open-thread bus; route it through the
  // active pane like any other thread open.
  useEffect(
    () => onOpenThread(({ threadId, title }) => openThreadById(threadId, title)),
    [openThreadById]
  );
  const openTableById = useCallback(
    (tableId: string, table?: TableCatalogEntry) =>
      setSelectionInActivePane(
        table ? { kind: 'table', table_id: tableId, table } : { kind: 'table', table_id: tableId }
      ),
    [setSelectionInActivePane]
  );
  const openTableDraft = useCallback(
    (projectId?: string | null) =>
      setSelectionInActivePane(
        projectId
          ? { kind: 'table-draft', draft_id: generateId('table'), project_id: projectId }
          : { kind: 'table-draft', draft_id: generateId('table') }
      ),
    [setSelectionInActivePane]
  );
  const openTableEntry = useCallback(
    (tableId: string, entryId: string, how: 'highlight' | 'window' = 'highlight') =>
      setSelectionInActivePane({
        kind: 'table',
        table_id: tableId,
        // Paint the pane title at once, as a table chip does.
        table: getCachedTableEntry(tableId) ?? undefined,
        ...(how === 'window' ? { openEntryId: entryId } : { focusEntryId: entryId }),
        focusRequestId: nextFocusRequestId(),
      }),
    [setSelectionInActivePane]
  );

  // Pane-tree callbacks bundled into a single object so PaneLayout/PanelHost
  // pass one prop instead of eight all the way down the recursive tree.
  // Per-pane history navigators (back/forward/jumpTo) deliberately don't
  // touch `activeLeafId` — browser back/forward never jumps tabs.
  const callbacks = useMemo<PaneCallbacks>(
    () => ({
      onSelectLeaf: setActiveLeafId,
      // Closing the active pane hands activation to its neighbor in reading
      // order (the pane before it, else the one after), so a pane stays
      // active for sidebar clicks and the ⌘[ / ⌘] history shortcuts.
      onCloseLeaf: (leafId) => {
        updatePaneState((previous) => {
          const layout = closeLeaf(previous.layout, leafId);
          if (layout === previous.layout) return previous;
          if (previous.activeLeafId !== leafId) return { ...previous, layout };
          const ids = leafIds(previous.layout);
          const at = ids.indexOf(leafId);
          const remaining = new Set(leafIds(layout));
          const neighbor = [ids[at - 1], ids[at + 1]].find(
            (id): id is string => id !== undefined && remaining.has(id)
          );
          return { layout, activeLeafId: neighbor ?? null };
        });
      },
      onSplit: (leafId, zone, selection) => {
        updatePaneState((previous) => {
          const split = splitLeafWithResult(previous.layout, leafId, zone, selection);
          if (!split.insertedLeafId) return previous;
          return {
            layout: split.layout,
            activeLeafId: split.insertedLeafId,
          };
        });
      },
      onReplace: (leafId, selection) => {
        setLayout((prev) => replaceLeafSelection(prev, leafId, selection));
      },
      onResize: (splitId, ratios) => {
        setLayout((prev) => updateSplitRatios(prev, splitId, ratios));
      },
      onGoBackInLeaf: (leafId) => setLayout((prev) => goBackInLeaf(prev, leafId)),
      onGoForwardInLeaf: (leafId) => setLayout((prev) => goForwardInLeaf(prev, leafId)),
      onJumpToHistoryEntry: (leafId, index) =>
        setLayout((prev) => jumpToHistoryEntry(prev, leafId, index)),
    }),
    [setActiveLeafId, setLayout, updatePaneState]
  );

  return {
    layout,
    setLayout,
    resetPaneLayout,
    reopenForNewContent,
    activeLeafId,
    callbacks,
    fillLeafId,
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
  };
}
