/**
 * Read-only views over the pane tree: leaf lookup, selection-derived
 * "active/open" indicator ids, selection patching for workspace events,
 * and the wire serialization the agent navigation surface reads.
 */

import type {
  SerializedPane,
  SerializedPaneSelection,
  PaneLayoutSnapshot,
} from '@snaglet/shared/types';
import { settingsSelectionId, type DetailSelection } from '../selection/types';
import type { LayoutLeaf, LayoutNode, NonNullableSelection, PaneHistory } from './paneTreeTypes';

/**
 * Find a leaf by id. Returns null if missing. Used to determine the
 * "active" leaf for sidebar-click → fill-pane behavior.
 */
export function findLeaf(tree: LayoutNode, leafId: string): LayoutLeaf | null {
  if (tree.kind === 'leaf') return tree.id === leafId ? tree : null;
  for (const c of tree.children) {
    const found = findLeaf(c, leafId);
    if (found) return found;
  }
  return null;
}

/**
 * Map a transform over every leaf's selection — used when an external
 * workspace event needs to propagate into the cached node stored in each
 * pane's selection. Returns the same reference when nothing changed so
 * React can skip rerenders for untouched subtrees.
 */
export function mapSelections(
  tree: LayoutNode,
  fn: (selection: DetailSelection) => DetailSelection
): LayoutNode {
  if (tree.kind === 'leaf') {
    const nextSelection = fn(tree.selection);
    // History entries are non-null snapshots taken at visit time. Patch
    // them through `fn` too so back-navigation lands on the freshly-
    // renamed (or freshly-saved) version, not the stale one. We lazy-
    // allocate the patched array — most events return every entry by
    // reference, in which case we keep `tree.history` as-is.
    let nextEntries: NonNullableSelection[] | null = null;
    for (let i = 0; i < tree.history.entries.length; i += 1) {
      const entry = tree.history.entries[i];
      const patched = fn(entry) as NonNullableSelection;
      if (patched !== entry && nextEntries === null) {
        nextEntries = tree.history.entries.slice(0, i);
      }
      if (nextEntries !== null) nextEntries.push(patched);
    }
    const nextHistory: PaneHistory = nextEntries
      ? { ...tree.history, entries: nextEntries }
      : tree.history;
    if (nextSelection === tree.selection && nextHistory === tree.history) return tree;
    return { ...tree, selection: nextSelection, history: nextHistory };
  }
  let changed = false;
  const nextChildren = tree.children.map((c) => {
    const out = mapSelections(c, fn);
    if (out !== c) changed = true;
    return out;
  });
  return changed ? { ...tree, children: nextChildren } : tree;
}

/** Collect every leaf id in document order. */
export function leafIds(tree: LayoutNode, out: string[] = []): string[] {
  if (tree.kind === 'leaf') {
    out.push(tree.id);
    return out;
  }
  for (const c of tree.children) leafIds(c, out);
  return out;
}

/**
 * Map a `DetailSelection` to the workspace node id it addresses, or
 * `null` for selections that don't correspond to a tree node (empty
 * panes, singletons like providers/profile, or non-tree entities like
 * agents/tools/files).
 *
 * This is the single source of truth for "which tree row does this pane
 * point at" — used to light up the open/active indicators.
 */
function selectionNodeId(sel: DetailSelection): string | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'doc':
      return sel.doc_id;
    case 'thread':
      return sel.thread_id;
    case 'container':
      return sel.container_id;
    case 'image':
      return sel.image_id;
    case 'file':
      return sel.node.id;
    default:
      // agent / tool / providers / mcp / profile / embeddings / settings:
      // not workspace-tree rows.
      return null;
  }
}

/**
 * Per-surface ids derived from the active pane's selection. Each field
 * drives one sidebar's "active row" highlight: `nodeId` the workspace
 * tree, `threadId` the chat bridge, `toolId` ToolsView, `hookId`
 * AutomationsView, `providerId`/`providerModelId` ProvidersView, and `settingsId`
 * SettingsView. Fields not addressed by the active selection are `null`.
 */
export interface ActivePaneSelectionIds {
  nodeId: string | null;
  threadId: string | null;
  toolId: string | null;
  hookId: string | null;
  /** Registry id of the skill whose file is open (SkillsView). */
  skillId: string | null;
  settingsId: string | null;
  mcpConnectionId: string | null;
  providerId: string | null;
  providerModelId: string | null;
  /** Catalog id of the table open in the active pane (the workspace tree's Tables groups). */
  tableId: string | null;
  /** Automation open in the active pane (Automations sidebar). */
  automationId: string | null;
}

const NO_ACTIVE_SELECTION: ActivePaneSelectionIds = {
  nodeId: null,
  threadId: null,
  toolId: null,
  hookId: null,
  skillId: null,
  settingsId: null,
  mcpConnectionId: null,
  providerId: null,
  providerModelId: null,
  tableId: null,
  automationId: null,
};

/**
 * Resolve every selection-derived "active row" id for the active pane in
 * one pass — the single derivation behind Dashboard's active-row memos.
 * Returns all-null when there is no active leaf or the leaf is missing from
 * the tree.
 */
export function activePaneSelectionIds(
  tree: LayoutNode,
  activeLeafId: string | null
): ActivePaneSelectionIds {
  if (!activeLeafId) return NO_ACTIVE_SELECTION;
  const leaf = findLeaf(tree, activeLeafId);
  if (!leaf) return NO_ACTIVE_SELECTION;
  const sel = leaf.selection;
  return {
    nodeId: selectionNodeId(sel),
    threadId: sel?.kind === 'thread' ? sel.thread_id : null,
    toolId: sel?.kind === 'tool' ? sel.tool.id : null,
    hookId: sel?.kind === 'hook' ? sel.hook.hookName : null,
    skillId: sel?.kind === 'skill' ? sel.skill_id : null,
    settingsId: settingsSelectionId(sel),
    mcpConnectionId:
      sel?.kind === 'mcp-client-connection'
        ? `client:${sel.client_id}`
        : sel?.kind === 'mcp-server-connection'
          ? `server:${sel.server_id}`
          : null,
    providerId: sel?.kind === 'provider' ? sel.provider_id : null,
    providerModelId: sel?.kind === 'provider' ? (sel.focusModelId ?? null) : null,
    tableId: sel?.kind === 'table' ? sel.table_id : null,
    automationId: sel?.kind === 'automation-detail' ? sel.automation_id : null,
  };
}

/**
 * Collect the set of workspace node ids currently open in any pane of
 * the layout. Drives the workspace tree's "open in a pane" indicator —
 * every row whose node is showing somewhere gets the affordance,
 * independent of which pane holds focus.
 */
export function openNodeIds(tree: LayoutNode, out: Set<string> = new Set()): Set<string> {
  if (tree.kind === 'leaf') {
    const id = selectionNodeId(tree.selection);
    if (id) out.add(id);
    return out;
  }
  for (const c of tree.children) openNodeIds(c, out);
  return out;
}

/*
 * Serialization for the agent-driven UI navigation surface.
 *
 * The server's `get_user_pane_layout` tool requests the live layout via the
 * `ui.request_pane_layout` event; the client answers with a
 * `PaneLayoutSnapshot`. This converts our in-memory `LayoutNode` tree into the
 * flat wire shape (`SerializedPane[]`) the agent reads.
 *
 * Each pane's `paneKey` is its leaf `id` — the same key the agent passes back
 * to `navigate_user_pane` to target a specific pane.
 */

/** A leaf paired with the ratio of its slot inside its parent split. */
interface LeafWithRatio {
  leaf: LayoutLeaf;
  /** Fraction of the parent split this pane occupies (1 when it is the root). */
  ratio: number;
}

function collectLeavesWithRatio(tree: LayoutNode, ratio: number, out: LeafWithRatio[]): void {
  if (tree.kind === 'leaf') {
    out.push({ leaf: tree, ratio });
    return;
  }
  tree.children.forEach((child, i) => {
    const childRatio = tree.ratios[i] ?? 1 / tree.children.length;
    collectLeavesWithRatio(child, childRatio, out);
  });
}

/**
 * Map a live `DetailSelection` to the flat, ID-only wire shape the agent sees.
 *
 * Titles are best-effort from the resolved `node`/entity when present; ID-only
 * selections fall back to a generated label (e.g. `Doc abc123`) so the agent
 * always has a human-readable handle. Kinds without a first-class wire branch
 * (profile, embeddings, settings, agent, tool, file) collapse to
 * `{ kind: 'empty' }` — they are not navigation targets the agent re-opens.
 */
function selectionToSerialized(sel: DetailSelection): SerializedPaneSelection {
  if (!sel) return { kind: 'empty' };

  const titleFor = (label: string, id: string, t?: string | null): string =>
    t && t.trim() ? t : `${label} ${id}`;

  switch (sel.kind) {
    case 'doc':
      return {
        kind: 'doc',
        docId: sel.doc_id,
        title: titleFor('Doc', sel.doc_id, sel.node?.title),
      };
    case 'thread':
      return {
        kind: 'thread',
        threadId: sel.thread_id,
        agentId: sel.focusAgentId,
        title: titleFor('Thread', sel.thread_id, sel.node?.title),
      };
    case 'container':
      return {
        kind: 'container',
        containerId: sel.container_id,
        title: titleFor('Container', sel.container_id, sel.node?.name),
      };
    case 'image':
      return {
        kind: 'image',
        imageId: sel.image_id,
        title: titleFor('Image', sel.image_id, sel.node?.name),
      };
    case 'providers':
      return { kind: 'providers', title: 'Providers' };
    case 'provider':
      return { kind: 'providers', title: `Provider · ${sel.name}` };
    case 'mcp-client-connection':
      return { kind: 'mcp', title: `MCP client · ${sel.name}` };
    case 'mcp-server-connection':
      return { kind: 'mcp', title: `MCP server · ${sel.name}` };
    default:
      // agent / tool / file / profile / embeddings:
      // not navigation targets the agent re-opens.
      return { kind: 'empty' };
  }
}

/**
 * Serialize the live layout tree into the wire snapshot the agent reads.
 *
 * @param tree            the current Dashboard layout
 * @param activeThreadId  the thread the user is actively chatting in; its pane
 *                        is flagged `isActiveThread` so the agent avoids it.
 */
export function serializePaneLayout(
  tree: LayoutNode,
  activeThreadId: string | null
): PaneLayoutSnapshot {
  const leaves: LeafWithRatio[] = [];
  collectLeavesWithRatio(tree, 1, leaves);

  const panes: SerializedPane[] = leaves.map(({ leaf, ratio }) => {
    const selection = selectionToSerialized(leaf.selection);
    const isActiveThread =
      activeThreadId != null &&
      selection.kind === 'thread' &&
      selection.threadId === activeThreadId;
    return { key: leaf.id, ratio, isActiveThread, selection };
  });

  return { panes };
}
