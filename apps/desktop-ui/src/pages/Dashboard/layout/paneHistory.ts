/**
 * Per-pane back/forward navigation: the history-stack semantics behind
 * selection changes (push/dedupe/truncate) and the operations that move
 * a leaf through its recorded entries.
 */

import type { DetailSelection } from '../selection/types';
import type { LayoutLeaf, LayoutNode, NonNullableSelection, PaneHistory } from './paneTreeTypes';
import { mapLeaves } from './paneTreeMutation';
import { findLeaf } from './paneTreeQueries';

/** Max history size per pane. Older entries fall off the bottom. */
const PANE_HISTORY_MAX = 50;

/**
 * Stable identity check used to dedupe consecutive history pushes —
 * clicking the same node twice shouldn't create two history entries.
 * Compares by kind + the node's database id rather than reference, so
 * a freshly-fetched copy of the same node is still "same". Exhaustive over
 * the selection kinds, so a new kind must say what makes it the same item
 * instead of silently comparing equal to every other one of its kind.
 */
function selectionsEqual(a: DetailSelection, b: DetailSelection): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'agent':
      return b.kind === 'agent' && a.agent.id === b.agent.id;
    case 'doc':
      return b.kind === 'doc' && a.doc_id === b.doc_id;
    case 'thread':
      return b.kind === 'thread' && a.thread_id === b.thread_id;
    case 'container':
      return b.kind === 'container' && a.container_id === b.container_id;
    case 'image':
      return b.kind === 'image' && a.image_id === b.image_id;
    case 'sketch':
      return b.kind === 'sketch' && a.sketch_id === b.sketch_id;
    case 'file':
      return b.kind === 'file' && a.node.id === b.node.id;
    case 'tool':
      return b.kind === 'tool' && a.tool.id === b.tool.id;
    case 'hook':
      return b.kind === 'hook' && a.hook.hookName === b.hook.hookName;
    case 'skill':
      return b.kind === 'skill' && a.skill_id === b.skill_id && a.path === b.path;
    case 'automation-detail':
      return b.kind === 'automation-detail' && a.automation_id === b.automation_id;
    case 'mcp-client-connection':
      return b.kind === 'mcp-client-connection' && a.client_id === b.client_id;
    case 'mcp-server-connection':
      return b.kind === 'mcp-server-connection' && a.server_id === b.server_id;
    case 'provider':
      return b.kind === 'provider' && a.provider_id === b.provider_id;
    case 'embeddings':
      return b.kind === 'embeddings' && a.tab === b.tab;
    case 'table':
      return b.kind === 'table' && a.table_id === b.table_id;
    case 'dm':
      return b.kind === 'dm' && a.thread_id === b.thread_id;
    case 'table-draft':
      return b.kind === 'table-draft' && a.draft_id === b.draft_id;
    // The Calendar is one pane, but each view of it (Month, Week, Day, Year) is
    // its own stop. A selection that has not reported its view yet (a fresh
    // open) is the same stop, so the first report fills it in place.
    case 'calendar':
      return (
        b.kind === 'calendar' &&
        (a.view === undefined || b.view === undefined || a.view.zoom === b.view.zoom)
      );
    // Singleton settings and create surfaces: one of each.
    case 'profile':
    case 'hub':
    case 'get-started':
    case 'providers':
    case 'cli':
    case 'theme':
    case 'agent-instructions':
    case 'storage':
    case 'browser':
    case 'updates':
    case 'tool-create':
    case 'hook-create':
    case 'automation-create':
      return true;
    default: {
      const unhandled: never = a;
      return unhandled;
    }
  }
}

/**
 * Append `selection` to the leaf's history. No-op when selection is
 * null (empty panes don't contribute history) or when it matches the
 * current entry (consecutive dupes — usually a click on the already-
 * displayed node). Otherwise truncates any forward stack and appends,
 * mirroring browser back/forward semantics.
 */
function pushSelectionIntoHistory(history: PaneHistory, selection: DetailSelection): PaneHistory {
  if (!selection) return history;
  const current = history.index >= 0 ? history.entries[history.index] : null;
  if (selectionsEqual(current, selection)) {
    // The same Calendar view on another day: the stop stays, with its day brought up to date.
    if (current?.kind === 'calendar' && selection.kind === 'calendar') {
      const same =
        current.view?.zoom === selection.view?.zoom &&
        current.view?.anchor === selection.view?.anchor;
      if (same) return history;
      const entries = history.entries.slice();
      entries[history.index] = selection;
      return { entries, index: history.index };
    }
    return history;
  }
  const truncated = history.entries.slice(0, history.index + 1);
  truncated.push(selection);
  // Cap retained entries so a long-running session can't grow unbounded.
  // We drop from the start (oldest). The new entry is always the last
  // element, so its index after capping is just `length - 1`.
  while (truncated.length > PANE_HISTORY_MAX) {
    truncated.shift();
  }
  return { entries: truncated, index: truncated.length - 1 };
}

/**
 * Replace a leaf's selection and push the new selection onto its
 * history stack. Used for: "an empty pane is focused and the user
 * clicked a sidebar item — fill it" and "a non-empty pane is the
 * active target — swap its content (center drop)."
 *
 * Pass `pushHistory: false` to do an "in-place" swap that doesn't
 * record a new visit — this is what back/forward navigation uses
 * (`goBackInLeaf` / `goForwardInLeaf` go through different paths, but
 * external callers that want history-less updates can opt out here).
 */
export function replaceLeafSelection(
  tree: LayoutNode,
  leafId: string,
  selection: DetailSelection,
  options: { pushHistory?: boolean } = {}
): LayoutNode {
  const push = options.pushHistory ?? true;
  const next = mapLeaves(tree, (leaf) => {
    if (leaf.id !== leafId) return leaf;
    const nextHistory = push ? pushSelectionIntoHistory(leaf.history, selection) : leaf.history;
    // Idempotent: clicking the same node twice (or center-dropping the
    // currently-displayed node) shouldn't allocate a new tree.
    if (selection === leaf.selection && nextHistory === leaf.history) return leaf;
    return { ...leaf, selection, history: nextHistory };
  });
  return next ?? tree;
}

/** One place in a pane's Recently visited menu. */
export interface HistoryMenuRow {
  entry: NonNullableSelection;
  /** The history index a pick jumps to. */
  index: number;
  /** The place the pane shows now. */
  isCurrent: boolean;
}

/**
 * The Recently visited menu: each place once, newest stack position first.
 * The stack itself keeps every revisit so back and forward step through
 * them; the menu only groups them. A place the pane is showing jumps to its
 * current index (a no-op), wherever else it sits in the stack.
 */
export function historyMenuRows(history: PaneHistory): HistoryMenuRow[] {
  const rows: HistoryMenuRow[] = [];
  for (let index = history.entries.length - 1; index >= 0; index -= 1) {
    const entry = history.entries[index];
    const isCurrent = index === history.index;
    const seen = rows.find((row) => selectionsEqual(row.entry, entry));
    if (!seen) {
      rows.push({ entry, index, isCurrent });
    } else if (isCurrent) {
      seen.entry = entry;
      seen.index = index;
      seen.isCurrent = true;
    }
  }
  return rows;
}

/** True when the leaf can step backward in its history. */
export function canGoBackInLeaf(leaf: LayoutLeaf): boolean {
  return leaf.history.index > 0;
}

/** True when the leaf can step forward in its history. */
export function canGoForwardInLeaf(leaf: LayoutLeaf): boolean {
  return leaf.history.index >= 0 && leaf.history.index < leaf.history.entries.length - 1;
}

/**
 * Jump to an arbitrary index in the leaf's history — out-of-range or
 * unchanged-index calls are no-ops (return the same leaf reference) so
 * React skips a re-render. Used directly by the history dropdown and
 * indirectly by `goBackInLeaf` / `goForwardInLeaf`.
 */
export function jumpToHistoryEntry(tree: LayoutNode, leafId: string, index: number): LayoutNode {
  const next = mapLeaves(tree, (leaf) => {
    if (leaf.id !== leafId) return leaf;
    if (index < 0 || index >= leaf.history.entries.length) return leaf;
    if (index === leaf.history.index) return leaf;
    return {
      ...leaf,
      selection: leaf.history.entries[index],
      history: { ...leaf.history, index },
    };
  });
  return next ?? tree;
}

/** Step one entry backward — thin wrapper over `jumpToHistoryEntry`. */
export function goBackInLeaf(tree: LayoutNode, leafId: string): LayoutNode {
  const leaf = findLeaf(tree, leafId);
  return leaf ? jumpToHistoryEntry(tree, leafId, leaf.history.index - 1) : tree;
}

/** Step one entry forward — thin wrapper over `jumpToHistoryEntry`. */
export function goForwardInLeaf(tree: LayoutNode, leafId: string): LayoutNode {
  const leaf = findLeaf(tree, leafId);
  return leaf ? jumpToHistoryEntry(tree, leafId, leaf.history.index + 1) : tree;
}
