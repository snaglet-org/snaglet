import { createContext, useContext, type ReactNode } from 'react';
import type { LibraryTreeChild, ThreadTreeNode } from '@desktop/utils/api';
import type { SidebarViewId } from '@desktop/pages/Dashboard/sidebar';
import type { AgentPageTab, DetailSelection } from './types';

export interface DashboardNavigationValue {
  /**
   * Open a workspace node in the active pane. Called by the sidebar
   * tree, breadcrumbs, deep links, etc. Sidebar-originated calls do not
   * trigger reveal — the row is already where the user clicked.
   */
  openInPane: (node: LibraryTreeChild) => void;

  /** Open a Database table pane by catalog id (never a workspace node id). */
  openTable?: (tableId: string) => void;
  /** Open a custom table at the page containing this entry. */
  openTableEntry?: (tableId: string, entryId: string, how?: 'highlight' | 'window') => void;
  /**
   * Open a new table draft in the active pane, created in `projectId` (a
   * project container id) or workspace-wide with null. The workspace tree's
   * Tables group `+` and its create menu's Table entry start one.
   */
  openTableDraft?: (projectId: string | null) => void;
  /**
   * Open an agent's page in the active pane by agent id. `opts.tab` brings
   * that tab up, even when the page is already open on another one.
   */
  openAgentById?: (agentId: string, opts?: { tab?: AgentPageTab }) => void;
  /**
   * Open a thread in the active pane by id. With its title the pane header
   * names it at once; without one the pane opens by id and the workspace tree
   * fills the name in (a stub node with no title would show the raw id).
   */
  openThread?: (threadId: string, title?: string | null) => void;
  /** Open one automation in the Automations pane (`name` titles it at once). */
  openAutomation?: (automationId: string, name?: string) => void;
  /** Focus the Calendar pane, or open one in the active pane. */
  openCalendar?: () => void;
  /** Show a sidebar view (opening the sidebar if it is hidden), e.g. MCP from Home. */
  openSidebarView?: (view: SidebarViewId) => void;
  /**
   * Open a selection in a new pane to the right of the active one, which
   * keeps focus (Get started opens the Welcome doc beside Patty's thread).
   */
  openBeside?: (selection: DetailSelection) => void;
  /**
   * Open the New agent form; the agent it creates opens in the active pane.
   * `onCreated` runs once the agent is created, never when the form is canceled.
   */
  openNewAgent?: (onCreated?: () => void) => void;
  /**
   * Ask which agents to add, then open the new thread in the active pane (as
   * ⌘⇧T does). `onCreated` runs once the thread is created, never on cancel.
   */
  openNewThread?: (onCreated?: () => void) => void;
  /**
   * After a reset or snapshot restore replaced the workspace content: open
   * Home (with Get started beside it while the first run is unfinished) in
   * place of every pane, which may point at content that is gone.
   */
  reopenForNewContent?: () => void;

  /**
   * Open a thread straight into its settings → Agents tab with `agentId`
   * preselected (the WorkspaceTree's per-thread Agents leaf). `opts.focus`
   * also selects the Memories or Summaries tab of the agent's context rail
   * and scrolls that row into view.
   */
  openThreadAgent: (
    thread: ThreadTreeNode,
    agentId: string,
    opts?: { focus?: { kind: 'memory' | 'summary'; id: string } }
  ) => void;

  /**
   * Expand the ancestors of `id` in the sidebar, scroll its row into view and
   * pulse it. Called from outside the tree (breadcrumbs, deep links, search);
   * a no-op when the row is already on screen. Repeat calls for the same id
   * still fire. `targetView` picks the sidebar view that owns the item
   * (default: the library tree).
   */
  requestReveal: (id: string, targetView?: SidebarViewId) => void;
}

const Ctx = createContext<DashboardNavigationValue | null>(null);

export function useDashboardNavigation(): DashboardNavigationValue | null {
  return useContext(Ctx);
}

export function DashboardNavigationProvider({
  value,
  children,
}: {
  value: DashboardNavigationValue;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
