import type {
  FileTreeNode,
  HookWorkspaceInfo,
  LibraryTreeChild,
  ToolRow,
} from '@desktop/utils/api';
import type { SnagletAgent, TableCatalogEntry } from '@snaglet/shared/types';
import type { SidebarViewId } from '../sidebar/views';

/** Settings tabs rendered by the Data pane or the feature-gated Dev view. */
export type DataSearchTab = 'embeddings' | 'backups';

/** The tabs of an agent's page. */
export type AgentPageTab = 'overview' | 'behavior' | 'capabilities' | 'memories' | 'dms';

/** The Calendar pane's place in its history: the view and the day it is on. */
export interface CalendarPaneView {
  zoom: 'month' | 'week' | 'day' | 'year';
  /** `YYYY-MM-DD`. */
  anchor: string;
}

/**
 * Union of things a Dashboard pane can display. Workspace nodes use a
 * first-class branch keyed by their current kind and canonical id; other
 * surfaces carry the entity or settings state they need to render.
 *
 * `profile` is a singleton selection (there's only one user). It's
 * dispatched from the activity-bar's Profile tab, not from a list.
 */
export type DetailSelection =
  /**
   * Workspace-node branches carry the canonical id and, when available, the
   * hydrated tree node. The node is a render cache: `useDashboardLayout`
   * hydrates id-only selections (agent navigation, restored layouts) from the
   * tree, and `useWorkspaceEventSync` patches open panes and history entries
   * whenever workspace data changes.
   */
  | {
      kind: 'doc';
      doc_id: string;
      /** Hydrated workspace node used by the editor. */
      node?: Extract<LibraryTreeChild, { kind: 'doc' }>;
      /**
       * When set, the doc surface loads a window centered on this message id
       * (doc-attached thread) and holds it in view, highlighted.
       */
      focusMessageId?: string;
    }
  | {
      kind: 'thread';
      thread_id: string;
      /** Hydrated workspace node used for titles and breadcrumbs. */
      node?: Extract<LibraryTreeChild, { kind: 'thread' }>;
      /** Open the thread's settings → Agents tab with this agent preselected. */
      focusAgentId?: string;
      /** Sub-focus inside the per-agent context rail (Memories tab + scroll). */
      focusMemoryId?: string;
      /** Sub-focus inside the per-agent context rail (Summaries tab + scroll). */
      focusSummaryId?: string;
      /** Open the chat on this message id: in view and highlighted until the user scrolls. */
      focusMessageId?: string;
      /**
       * Monotonic id of the navigation request that set `focusMessageId`.
       * Lets a message-search hit re-seek an already-open conversation (same
       * thread, same or different message) — the thread id alone cannot
       * distinguish "new request" from "rerender". Transient like
       * `focusMessageId`: never persisted (see persistence.ts).
       */
      focusRequestId?: number;
      /**
       * Set when the thread is a subagent helper's hidden thread: the thread
       * that started it. Persisted, because a removed helper's thread is
       * deleted (404) and nothing else then says what the pane showed.
       */
      helperParentThreadId?: string;
    }
  /**
   * A direct-message conversation (a `kind = 'dm'` thread). DM threads are
   * not workspace-tree nodes — the shared thread filter hides them from the
   * tree and the thread lists — so they never hydrate from the tree; the
   * agent's Direct messages tab and the pane read them by id. `title` names
   * the pane at once.
   */
  | { kind: 'dm'; thread_id: string; title?: string }
  | {
      kind: 'container';
      container_id: string;
      /** Hydrated workspace node used by the container surface. */
      node?: Extract<LibraryTreeChild, { kind: 'container' }>;
    }
  | {
      kind: 'image';
      image_id: string;
      /** Hydrated workspace node used by the image surface. */
      node?: Extract<LibraryTreeChild, { kind: 'image' }>;
    }
  /**
   * A `sketch-…` id from a restored layout or a stale chip. There is no Sketch
   * view: it carries only the id and renders through the generic
   * unresolved-item pane.
   */
  | { kind: 'sketch'; sketch_id: string }
  /**
   * The Calendar pane, one per window, opened from the activity bar. `view` is
   * the zoom and day shown: changing the zoom pushes a history entry, moving
   * between days only updates the current one. Absent until the pane reports
   * its view.
   */
  | { kind: 'calendar'; view?: CalendarPaneView }
  | {
      kind: 'agent';
      agent: SnagletAgent;
      /**
       * Transient: bring this tab up, even on a page already open on another
       * one (a chat's Configure model link asks for Overview). Each request
       * carries a fresh `focusRequestId`; neither is persisted.
       */
      focusTab?: AgentPageTab;
      focusRequestId?: number;
    }
  /**
   * A project file opened from the WorkspaceTree's file group. Read-only —
   * FileView fetches the body on demand (file bodies live on disk, not the DB).
   */
  | { kind: 'file'; node: FileTreeNode }
  /**
   * The profile editor. While the `hub_home` flag is on it opens the Home pane
   * instead, unless `account` is set (Home's "Account and users" link, the way
   * to the email and user picker Home does not show).
   */
  | { kind: 'profile'; account?: boolean }
  /**
   * The Home pane (`hub_home` flag): pinned items, recent threads and docs, the
   * user's name and the instructions for all agents. A singleton.
   */
  | { kind: 'hub' }
  /**
   * The Get started pane: connect a provider, then meet Patty. A fresh
   * install opens on it; Settings → Get started reaches it any time.
   */
  | { kind: 'get-started' }
  /** One provider detail surface, optionally focused on a model card. */
  | {
      kind: 'provider';
      provider_id: string;
      name: string;
      provider_type: 'llm' | 'integration' | 'runtime';
      focusModelId?: string;
    }
  /** Catalog entry point for links that do not target one provider. */
  | { kind: 'providers' }
  /** An external MCP client entering Snaglet through this workspace's `/mcp` endpoint. */
  | { kind: 'mcp-client-connection'; client_id: string; name: string }
  /** An upstream MCP server that Snaglet connects to for tools. */
  | { kind: 'mcp-server-connection'; server_id: string; name: string }
  | { kind: 'cli' }
  /** Workspace theme customization — colors, fonts, and visual preferences. */
  | { kind: 'theme' }
  /** Instructions for all agents, added to every agent's system prompt. */
  | { kind: 'agent-instructions' }
  /** Storage and voice models — disk usage reporting, cache cleanup, voice asset installation. */
  | { kind: 'storage' }
  /** Browser profiles agents use (sign in once by hand). */
  | { kind: 'browser' }
  /** The installed version and in-app updates. */
  | { kind: 'updates' }
  | { kind: 'embeddings'; tab?: DataSearchTab }
  /**
   * A single tool, shown in ToolView (description, params, run, output).
   * `edit` is an initial-mode hint only: when true (ToolsView's Edit pencil)
   * the pane opens in ToolBuilderPanel instead. `tool-create` hosts the same
   * builder before a ToolRow exists.
   */
  | { kind: 'tool'; tool: ToolRow; edit?: boolean }
  | { kind: 'tool-create' }
  /**
   * A workspace-sourced hook, shown in HookBuilderPanel (create/edit form). A
   * hook has no view/run surface, so a row click and the Edit pencil both
   * land here. `hook-create` hosts the same builder before a workspace exists.
   */
  | { kind: 'hook'; hook: HookWorkspaceInfo }
  /**
   * A file inside a skill folder (`~/.snaglet/skills/<slug>/`), shown read-only by
   * SkillFileView. `path` is relative to the skill folder.
   */
  | { kind: 'skill'; skill_id: string; slug: string; path: string }
  | { kind: 'hook-create' }
  /**
   * One automation (a scheduled agent wake) in the Automations pane: its
   * details, actions and Edit form. `name` is a render cache for the pane
   * title; the pane reads the live record from the shared automations store.
   * (The bare `automation` kind is scrubbed from restored layouts.)
   */
  | { kind: 'automation-detail'; automation_id: string; name?: string }
  /** The Automations pane's New automation form. */
  | { kind: 'automation-create' }
  /**
   * A Database catalog table. `table_id` is a table_catalog id, not a
   * workspace node id — so it never routes through node lookups (table chips
   * carry it behind their own `table:` scheme). `table` is a render cache for
   * chrome titles; the pane fetches the canonical detail itself.
   */
  | {
      kind: 'table';
      table_id: string;
      table?: TableCatalogEntry;
      /** Transient entry seek; no hint is persisted in restored layouts. */
      focusEntryId?: string;
      /** Transient: open this entry's window (the entry modal) over the table. */
      openEntryId?: string;
      focusRequestId?: number;
    }
  /**
   * An unsaved table the user is naming. `draft_id` is the client-minted
   * catalog id the create request reuses (retries are idempotent); on success
   * the draft becomes a `table` selection with the same id. `project_id` null
   * or absent creates the table workspace-wide.
   */
  | { kind: 'table-draft'; draft_id: string; project_id?: string | null }
  | null;

/**
 * Map a workspace-tree node to the canonical pane selection shape. The node
 * is carried along so tree clicks and drag/drop render immediately without a
 * second fetch. A project is a container with `category === 'project'`, so it
 * uses the `container` branch.
 */
export function selectionFromWorkspaceNode(node: LibraryTreeChild): NonNullable<DetailSelection> {
  switch (node.kind) {
    case 'doc':
      return { kind: 'doc', doc_id: node.id, node };
    case 'thread':
      return { kind: 'thread', thread_id: node.id, node };
    case 'container':
      return { kind: 'container', container_id: node.id, node };
    case 'image':
      return { kind: 'image', image_id: node.id, node };
  }
}

/**
 * Resolve the workspace node id a selection points at — used by
 * surfaces that need the node's ancestor path (the pane-chrome breadcrumb).
 *
 * Docs, threads, containers, and images all live in the container tree, so
 * their id resolves an ancestor chain via `findNodeAncestors`. Everything else
 * — agents, settings panes, tools, and on-disk files — has no workspace-tree
 * path and resolves to `null`.
 */
export function workspaceNodeId(selection: DetailSelection): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case 'doc':
      return selection.doc_id;
    case 'thread':
      return selection.thread_id;
    case 'container':
      return selection.container_id;
    case 'sketch':
      return selection.sketch_id;
    case 'image':
      return selection.image_id;
    default:
      return null;
  }
}

/** Return the id of a workspace selection whose render node is not hydrated. */
export function unresolvedWorkspaceNodeId(selection: DetailSelection): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case 'doc':
      return selection.node ? null : selection.doc_id;
    case 'thread':
      return selection.node ? null : selection.thread_id;
    case 'container':
      return selection.node ? null : selection.container_id;
    case 'sketch':
      return selection.sketch_id;
    case 'image':
      return selection.node ? null : selection.image_id;
    default:
      return null;
  }
}

/**
 * Attach a freshly-loaded workspace node to its matching selection. Kind and
 * id must both match; otherwise the original selection is returned unchanged.
 */
export function hydrateWorkspaceSelection(
  selection: DetailSelection,
  node: LibraryTreeChild | undefined
): DetailSelection {
  if (!selection || !node) return selection;
  switch (selection.kind) {
    case 'doc':
      return node.kind === 'doc' && node.id === selection.doc_id
        ? { ...selection, node }
        : selection;
    case 'thread':
      return node.kind === 'thread' && node.id === selection.thread_id
        ? { ...selection, node }
        : selection;
    case 'container':
      return node.kind === 'container' && node.id === selection.container_id
        ? { ...selection, node }
        : selection;
    case 'image':
      return node.kind === 'image' && node.id === selection.image_id
        ? { ...selection, node }
        : selection;
    default:
      return selection;
  }
}

/**
 * The SettingsView row id that opens a settings selection, so the sidebar can
 * mark it active. Any non-settings selection resolves to `null` (no active
 * row).
 */
export function settingsSelectionId(selection: DetailSelection): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case 'profile':
      return 'profile';
    case 'hub':
      return 'hub';
    case 'get-started':
      return 'get-started';
    case 'cli':
      return 'cli';
    case 'theme':
      return 'theme';
    case 'agent-instructions':
      return 'agent-instructions';
    case 'storage':
      return 'storage';
    case 'browser':
      return 'browser';
    case 'updates':
      return 'updates';
    case 'embeddings':
      // Data's Embeddings/Backups rows share one routed surface,
      // distinguished by `tab`.
      return selection.tab === 'backups' ? 'backups' : 'embeddings';
    default:
      return null;
  }
}

/**
 * Where a pane selection lives in the sidebar: the activity-bar view that owns
 * it and the row id to reveal. Drives the pane chrome's "Open in sidebar"
 * button. `id: null` switches to the view with no row to scroll to; a `null`
 * return means no sidebar home, so the button is hidden.
 */
export function sidebarRevealTarget(
  selection: DetailSelection
): { view: SidebarViewId; id: string | null } | null {
  if (!selection) return null;
  switch (selection.kind) {
    // Workspace-tree citizens — docs, threads, containers, images.
    case 'doc':
      return { view: 'library', id: selection.doc_id };
    case 'thread':
      return { view: 'library', id: selection.thread_id };
    case 'container':
      return { view: 'library', id: selection.container_id };
    case 'sketch':
      return { view: 'library', id: selection.sketch_id };
    case 'image':
      return { view: 'library', id: selection.image_id };
    case 'calendar':
      return { view: 'calendar', id: null };
    // DM conversations have no sidebar home: they are listed in each agent's
    // settings (the Direct messages tab), not in an activity-bar view.
    case 'dm':
      return null;
    // Project files render inside the workspace tree's file group but are
    // keyed by path, not workspace id — switch to the library view only.
    case 'file':
      return { view: 'library', id: null };
    case 'agent':
      return { view: 'agents', id: selection.agent.id };
    case 'tool':
      return { view: 'tools', id: selection.tool.id };
    case 'tool-create':
      return { view: 'tools', id: null };
    case 'hook':
      // Scripts list in Automations, their rows keyed by hookName.
      return { view: 'automations', id: selection.hook.hookName };
    case 'hook-create':
      return { view: 'automations', id: null };
    case 'skill':
      return { view: 'skills', id: selection.skill_id };
    case 'automation-detail':
      return { view: 'automations', id: selection.automation_id };
    case 'automation-create':
      return { view: 'automations', id: null };
    // Tables live in the workspace tree's Tables groups. The tree reveals a
    // catalog id in the group that holds it (its project's, or the workspace
    // group when unlinked). A draft has no row until it is saved.
    case 'table':
      return { view: 'library', id: selection.table_id };
    case 'table-draft':
      return { view: 'library', id: null };
    case 'provider':
      return { view: 'providers', id: selection.provider_id };
    case 'providers':
      return { view: 'providers', id: null };
    case 'mcp-client-connection':
      return { view: 'mcp', id: selection.client_id };
    case 'mcp-server-connection':
      return { view: 'mcp', id: selection.server_id };
    // Settings surfaces — reuse the row-id mapping SettingsView renders.
    case 'profile':
    case 'hub':
    case 'get-started':
    case 'cli':
    case 'theme':
    case 'agent-instructions':
    case 'storage':
    case 'browser':
    case 'updates':
    case 'embeddings':
      return { view: 'settings', id: settingsSelectionId(selection) };
    default:
      return null;
  }
}
