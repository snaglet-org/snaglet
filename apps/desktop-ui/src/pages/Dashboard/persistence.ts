import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import {
  findLeaf,
  leafIds,
  mapSelections,
  repairPaneLayout,
  reportPaneLayoutRepairs,
  type LayoutNode,
} from './layout/paneTree';
import type { LibraryTreeChild } from '@desktop/utils/api';
import { selectionFromWorkspaceNode, type DetailSelection } from './selection/types';

// Local mirror of paneTree.ts's NonNullableSelection — kept private to
// avoid widening paneTree's public surface for a single migration helper.
type NonNullableSelection = Exclude<DetailSelection, null>;

/**
 * Selection kinds that have no view. A stored snapshot can still point a pane
 * or a history entry at one; load scrubs them so the pane opens empty instead
 * of crashing selectionDescriptor / DetailRouter. Projects render as
 * containers (`category === 'project'`), so `{ kind: 'project' }` is one of
 * them. Checked as strings because these kinds are not in the
 * `DetailSelection` union.
 */
const REMOVED_SELECTION_KINDS = new Set<string>([
  'automation',
  'project',
  'logs',
  'workspace-settings',
  'mcp',
  'mcp-server',
  'board',
  'prototypes',
]);

function isRemovedSelection(selection: DetailSelection): boolean {
  if (!selection) return false;
  if (REMOVED_SELECTION_KINDS.has(selection.kind)) return true;
  // Workspace wrapper (`kind: 'library'`): scrub when the wrapped kind has no view.
  const stored = selection as { kind?: string; node?: { kind?: string } };
  if (stored.kind === 'library') {
    return !!stored.node?.kind && REMOVED_SELECTION_KINDS.has(stored.node.kind);
  }
  return false;
}

/**
 * The node id of a stored task selection, or `null` when the selection is not
 * a task. Task ids resolve to docs, so both task shapes (flat
 * `{ kind: 'task', task_id }` and the `{ kind: 'library', node: { kind: 'task', id } }`
 * wrapper) map to a doc. Checked as strings because `'task'` is not in the
 * `DetailSelection` union.
 */
function taskIdOf(selection: NonNullableSelection): string | null {
  const s = selection as {
    kind?: string;
    task_id?: string;
    node?: { kind?: string; id?: string };
  };
  if (s.kind === 'task') {
    return typeof s.task_id === 'string' ? s.task_id : (s.node?.id ?? null);
  }
  if (s.kind === 'library' && s.node?.kind === 'task') {
    return s.node.id ?? null;
  }
  return null;
}

/**
 * Upgrade one stored selection to the current `DetailSelection` shape:
 * - a task selection becomes an id-only doc selection with the same node id;
 * - a workspace wrapper becomes its kind-specific selection;
 * - an Embeddings subtab selection becomes the Embeddings overview.
 * Anything else is returned untouched; the caller scrubs kinds with no view.
 *
 * The overloads keep nullability: `null` in gives `null` out, and a non-null
 * selection (a history entry) always gives a non-null one.
 */
function migrateSelection(selection: null): null;
function migrateSelection(selection: NonNullableSelection): NonNullableSelection;
function migrateSelection(selection: DetailSelection): DetailSelection;
function migrateSelection(selection: DetailSelection): DetailSelection {
  if (!selection) return selection;
  const taskId = taskIdOf(selection);
  if (taskId) return { kind: 'doc', doc_id: taskId };
  const stored = selection as { kind?: string; node?: { kind?: string } };
  if (stored.kind === 'library' && stored.node) {
    if (['container', 'doc', 'thread', 'image'].includes(stored.node.kind ?? '')) {
      return selectionFromWorkspaceNode(stored.node as LibraryTreeChild);
    }
    return selection;
  }
  const maybeEmbeddings = selection as { kind?: string; tab?: string };
  if (maybeEmbeddings.kind === 'embeddings' && maybeEmbeddings.tab !== 'embeddings') {
    return { kind: 'embeddings', tab: 'embeddings' };
  }
  return selection;
}

/**
 * Walk a deserialized LayoutNode tree and upgrade every leaf selection and
 * history entry to the current shape. Selections whose kind has no view are
 * scrubbed before they reach the pane router.
 */
function migrateLayoutSelections(layout: LayoutNode): LayoutNode {
  if (layout.kind === 'leaf') {
    // 1. Upgrade stored selection shapes.
    const migratedSelection = migrateSelection(layout.selection);
    const migratedEntries = layout.history.entries.map((entry) => migrateSelection(entry));

    const removedPresent =
      isRemovedSelection(migratedSelection) || migratedEntries.some(isRemovedSelection);
    const migrated =
      migratedSelection !== layout.selection ||
      migratedEntries.some((entry, i) => entry !== layout.history.entries[i]);

    if (!removedPresent && !migrated) return layout;

    if (!removedPresent) {
      // Pure shape migration — nothing to scrub.
      return {
        ...layout,
        selection: migratedSelection,
        history: { ...layout.history, entries: migratedEntries as NonNullableSelection[] },
      };
    }

    // 2. Scrub selections whose kind has no view. Re-point the history
    //    cursor at the surviving current entry, else the newest survivor, else
    //    an empty pane.
    const currentEntry =
      layout.history.index >= 0 && layout.history.index < migratedEntries.length
        ? migratedEntries[layout.history.index]
        : null;
    const survivingEntries = migratedEntries.filter(
      (entry): entry is NonNullableSelection => !isRemovedSelection(entry)
    );
    let nextIndex =
      currentEntry && !isRemovedSelection(currentEntry)
        ? survivingEntries.indexOf(currentEntry)
        : -1;
    if (nextIndex < 0) nextIndex = survivingEntries.length - 1;
    const nextSelection: DetailSelection = nextIndex >= 0 ? survivingEntries[nextIndex] : null;

    return {
      ...layout,
      selection: nextSelection,
      history: { entries: survivingEntries, index: nextIndex },
    };
  }
  // split: recurse into children
  const nextChildren = layout.children.map((child) => migrateLayoutSelections(child));
  const childrenChanged = nextChildren.some((child, i) => child !== layout.children[i]);
  if (!childrenChanged) return layout;
  return { ...layout, children: nextChildren };
}

export const LAYOUT_STORAGE_KEY = 'snaglet.dashboard.layoutSnapshot';
/**
 * Bump when the persisted shape changes incompatibly. A snapshot at a version
 * in MIGRATABLE_STORAGE_VERSIONS is upgraded on load; any other version is
 * discarded and the dashboard boots to an empty leaf. Upgrading a v2 or v3
 * snapshot turns task selections into doc selections with the same id and
 * workspace wrappers into kind-specific selections (every workspace kind,
 * images included, has its own), sends Embeddings subtabs to the overview,
 * and scrubs kinds with no view. Wrappers never enter live pane state.
 */
export const LAYOUT_STORAGE_VERSION = 4;
/** Snapshot versions that `loadPersistedDashboard` upgrades instead of
 *  discarding. */
const MIGRATABLE_STORAGE_VERSIONS = new Set<number>([2, 3]);
/** Trailing-edge save delay. Resize drags fire many setLayouts per second;
 * we coalesce them into one localStorage write after the user pauses.
 */
export const PERSIST_DEBOUNCE_MS = 250;
/**
 * Size budget for one serialized snapshot. Workspace selections persist by id
 * only, so a typical layout is a few KB; the budget guards the per-origin
 * localStorage quota against large non-workspace payloads (an agent selection
 * carries its expanded system prompt) repeated across 50-entry histories.
 * Snapshots over budget are saved with shorter pane histories.
 */
export const MAX_LAYOUT_SNAPSHOT_CHARS = 256 * 1024;
/** Per-pane history depth kept when a snapshot is over budget or over quota. */
const TRIMMED_HISTORY_DEPTH = 10;

export interface PersistedDashboard {
  version: number;
  layout: LayoutNode;
  activeLeafId: string | null;
  /**
   * The workspace the layout was saved for (the server's `workspace.id`).
   * Missing from snapshots saved before layouts carried it.
   */
  workspaceId?: string;
}

/**
 * Whether a saved layout belongs to the workspace now open. Only a different
 * id is refused: a snapshot saved before layouts carried one is kept (it is
 * stamped on the next save), and so is any snapshot while the current id is
 * unknown (`null`: not read yet, or the read failed).
 */
export function layoutFitsWorkspace(
  snapshot: Pick<PersistedDashboard, 'workspaceId'>,
  currentWorkspaceId: string | null
): boolean {
  return (
    snapshot.workspaceId === undefined ||
    currentWorkspaceId === null ||
    snapshot.workspaceId === currentWorkspaceId
  );
}

/** The workspace item a pane shows, for the kinds the workspace tree lists. */
function workspaceItemId(selection: DetailSelection): string | null {
  switch (selection?.kind) {
    case 'doc':
      return selection.doc_id;
    case 'thread':
      return selection.thread_id;
    case 'container':
      return selection.container_id;
    case 'image':
      return selection.image_id;
    default:
      return null;
  }
}

/**
 * The items a restored layout points at when every pane that shows anything
 * shows a workspace item the tree no longer lists (each would say "This item
 * isn't available", or that it was archived); otherwise null: a pane shows
 * something else, shows an item the tree has, or no pane shows anything.
 */
export function itemsMissingFromTree(
  layout: LayoutNode,
  tree: ReadonlyMap<string, unknown>
): string[] | null {
  const missing: string[] = [];
  for (const id of leafIds(layout)) {
    const selection = findLeaf(layout, id)?.selection ?? null;
    if (!selection) continue;
    const itemId = workspaceItemId(selection);
    if (!itemId || tree.has(itemId)) return null;
    missing.push(itemId);
  }
  return missing.length > 0 ? missing : null;
}

/**
 * Read the last layout snapshot from localStorage, or null when it is missing,
 * malformed or at an unknown version (the dashboard then boots empty).
 *
 * Workspace selections (docs, threads, containers, images) are stored by id;
 * `useDashboardLayout` hydrates them from the workspace tree after load, so a
 * pane never paints a stale node body. Other selections are stored as the
 * JSON they render from. A snapshot over the size budget has its hydrated
 * nodes dropped and is written back once, freeing the quota.
 */
export function loadPersistedDashboard(): PersistedDashboard | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = safeJsonParse<PersistedDashboard | null>(raw, null);
    if (!parsed || typeof parsed !== 'object') return null;
    // Accept the current version and any migratable older version; anything
    // else is discarded (boot fresh instead of crashing on a stale tree).
    if (
      parsed.version !== LAYOUT_STORAGE_VERSION &&
      !MIGRATABLE_STORAGE_VERSIONS.has(parsed.version)
    ) {
      return null;
    }
    if (!parsed.layout || (parsed.layout.kind !== 'leaf' && parsed.layout.kind !== 'split')) {
      return null;
    }
    // Upgrade every selection (task→doc, workspace wrappers → kind-specific
    // shapes) and scrub kinds with no view. Stamping the current version means
    // the next save writes the cleaned shape back to localStorage.
    const migratedLayout = migrateLayoutSelections(parsed.layout);
    const oversized = raw.length > MAX_LAYOUT_SNAPSHOT_CHARS;
    const repaired = repairPaneLayout(
      oversized ? withoutWorkspaceNodes(migratedLayout) : migratedLayout
    );
    const { workspaceId, ...rest } = parsed;
    const restored: PersistedDashboard = {
      ...rest,
      version: LAYOUT_STORAGE_VERSION,
      layout: repaired.layout,
      ...(typeof workspaceId === 'string' && workspaceId ? { workspaceId } : {}),
    };
    reportPaneLayoutRepairs('persisted-load', repaired.repairs);
    if (oversized) {
      console.warn('[pane-layout] compacting oversized layout snapshot', {
        chars: raw.length,
        budget: MAX_LAYOUT_SNAPSHOT_CHARS,
      });
    }
    if (repaired.repairs.length > 0 || oversized) {
      // localStorage is synchronous. Write the corrected shape back exactly
      // once during load so a crash/reload before the normal debounce cannot
      // resurrect the malformed ratios or the oversized payload.
      savePersistedDashboard(restored);
    }
    return restored;
  } catch (err) {
    console.error('[pane-layout] could not restore layout snapshot', getErrorMessage(err));
    return null;
  }
}

/**
 * Whether a selection carries one-shot scroll hints, which are stripped before
 * persisting. A stored `focusMessageId` would refetch `?around=` on every
 * reload, which 404s once the message falls outside the default window and
 * leaves the thread blank; a restored `focusRequestId` would look like a
 * fresh seek to the chat view. An agent page's `focusTab` is a one-shot hint
 * the same way.
 */
function hasTransientFocus(selection: DetailSelection): boolean {
  return (
    !!selection &&
    (('focusMessageId' in selection && selection.focusMessageId !== undefined) ||
      ('focusEntryId' in selection && selection.focusEntryId !== undefined) ||
      ('openEntryId' in selection && selection.openEntryId !== undefined) ||
      ('focusTab' in selection && selection.focusTab !== undefined) ||
      ('focusRequestId' in selection && selection.focusRequestId !== undefined))
  );
}

function withoutTransientFocus<T extends NonNullableSelection>(selection: T): T {
  if (!hasTransientFocus(selection)) return selection;
  const {
    focusMessageId: _focusMessageId,
    focusEntryId: _focusEntryId,
    openEntryId: _openEntryId,
    focusTab: _focusTab,
    focusRequestId: _focusRequestId,
    ...persistedSelection
  } = selection as T & {
    focusMessageId?: string;
    focusEntryId?: string;
    openEntryId?: string;
    focusTab?: string;
    focusRequestId?: number;
  };
  return persistedSelection as T;
}

function stripTransientSelection(layout: LayoutNode): LayoutNode {
  if (layout.kind === 'leaf') {
    // The back/forward stack holds the same selections, so a hint that was
    // stripped from `selection` must not survive in `history.entries`.
    const historyDirty = layout.history.entries.some(hasTransientFocus);
    const selectionDirty = hasTransientFocus(layout.selection);
    if (!historyDirty && !selectionDirty) return layout;
    return {
      ...layout,
      selection: layout.selection ? withoutTransientFocus(layout.selection) : layout.selection,
      history: historyDirty
        ? { ...layout.history, entries: layout.history.entries.map(withoutTransientFocus) }
        : layout.history,
    };
  }
  if (layout.kind === 'split') {
    return {
      ...layout,
      children: layout.children.map(stripTransientSelection),
    };
  }
  return layout;
}

/**
 * Drop a workspace selection's hydrated node. The node is a render cache
 * (a container's carries its whole subtree, a doc's its full body), and
 * `useDashboardLayout` re-hydrates id-only selections from the tree.
 */
function withoutNode<T extends { node?: unknown }>(selection: T): T {
  if (selection.node === undefined) return selection;
  const { node: _node, ...rest } = selection;
  return rest as T;
}

function withoutWorkspaceNode(selection: DetailSelection): DetailSelection {
  if (!selection) return selection;
  switch (selection.kind) {
    case 'doc':
      return withoutNode(selection);
    case 'thread':
      return withoutNode(selection);
    case 'container':
      return withoutNode(selection);
    case 'image':
      return withoutNode(selection);
    default:
      return selection;
  }
}

function withoutWorkspaceNodes(layout: LayoutNode): LayoutNode {
  return mapSelections(layout, withoutWorkspaceNode);
}

/**
 * Keep at most `depth` history entries per pane, centered on the back stack
 * of the current entry so back navigation survives before forward does.
 */
function trimPaneHistory(layout: LayoutNode, depth: number): LayoutNode {
  if (layout.kind === 'split') {
    const children = layout.children.map((child) => trimPaneHistory(child, depth));
    return children.some((child, i) => child !== layout.children[i])
      ? { ...layout, children }
      : layout;
  }
  const { entries, index } = layout.history;
  if (entries.length <= depth) return layout;
  if (index < 0) {
    return { ...layout, history: { entries: entries.slice(-depth), index: -1 } };
  }
  const start = Math.min(Math.max(0, index - (depth - 1)), entries.length - depth);
  return {
    ...layout,
    history: { entries: entries.slice(start, start + depth), index: index - start },
  };
}

// Storage failures repeat on every debounced save; report each episode once.
let persistFailureReported = false;

/** Name the storage failure (`QuotaExceededError`, `SecurityError`, …) in logs. */
function storageErrorMessage(err: unknown): string {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return `${err.name}: ${err.message}`;
  }
  return getErrorMessage(err, 'localStorage write failed');
}

function serializeSnapshot(
  layout: LayoutNode,
  activeLeafId: string | null,
  workspaceId: string | null
): string {
  const payload: PersistedDashboard = {
    version: LAYOUT_STORAGE_VERSION,
    layout,
    activeLeafId,
    ...(workspaceId ? { workspaceId } : {}),
  };
  return JSON.stringify(payload);
}

/**
 * Write the snapshot, falling back to shorter pane histories when it is over
 * the size budget or the browser rejects it (quota exceeded). The current
 * selection of every pane always survives; only back/forward depth is lost.
 */
function writeSnapshot(
  layout: LayoutNode,
  activeLeafId: string | null,
  workspaceId: string | null
): void {
  const candidates = [
    layout,
    trimPaneHistory(layout, TRIMMED_HISTORY_DEPTH),
    trimPaneHistory(layout, 1),
  ];
  let lastError: unknown = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = serializeSnapshot(candidates[i], activeLeafId, workspaceId);
    const isLast = i === candidates.length - 1;
    if (!isLast && raw.length > MAX_LAYOUT_SNAPSHOT_CHARS) continue;
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, raw);
      if (candidates[i] !== layout) {
        console.warn('[pane-layout] saved layout with trimmed pane history', {
          chars: raw.length,
          historyDepth: isLast ? 1 : TRIMMED_HISTORY_DEPTH,
          reason: lastError === null ? 'size-budget' : storageErrorMessage(lastError),
        });
      }
      persistFailureReported = false;
      return;
    } catch (err) {
      lastError = err;
    }
  }
  if (!persistFailureReported) {
    persistFailureReported = true;
    console.error(
      '[pane-layout] could not persist layout snapshot; open panes will not survive a reload',
      storageErrorMessage(lastError)
    );
  }
}

/** Save the layout, stamped with the workspace it belongs to when that is known. */
export function savePersistedDashboard(state: {
  layout: LayoutNode;
  activeLeafId: string | null;
  workspaceId?: string | null;
}): void {
  if (typeof window === 'undefined') return;
  const repaired = repairPaneLayout(state.layout);
  reportPaneLayoutRepairs('persisted-save', repaired.repairs);
  const layout = withoutWorkspaceNodes(stripTransientSelection(repaired.layout));
  writeSnapshot(layout, state.activeLeafId, state.workspaceId ?? null);
}
