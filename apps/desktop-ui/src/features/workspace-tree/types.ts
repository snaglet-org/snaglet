import type { SnagletAgent } from '@snaglet/shared/types';
import type {
  FileTreeNode,
  LibraryTreeChild,
  PaletteSearchHit,
  ThreadParticipant,
} from '../../utils/api';

export interface WorkspaceTreeProps {
  /** Fires when a node (or project file) row is clicked. */
  onNodeClick?: (node: LibraryTreeChild | FileTreeNode) => void;
  /** Node id shown in the dashboard's active pane; that row gets the `active` style. */
  activeNodeId?: string | null;
  /**
   * Catalog id of the table shown in the dashboard's active pane; its Tables
   * group row gets the `active` style. Tables are not nodes, so they never
   * match `activeNodeId`.
   */
  activeTableId?: string | null;
  /**
   * Node ids open in any dashboard pane. Each matching row shows an "open in a
   * pane" accent bar, independent of `activeNodeId`.
   */
  openNodeIds?: Set<string>;
  /**
   * When set, the tree expands the node's ancestors and scrolls its row into
   * view. A catalog table id reveals that table's row in its Tables group.
   */
  revealNodeId?: string | null;
  /**
   * Bumped by the caller on every reveal request, so a reveal re-runs even
   * when `revealNodeId` is unchanged.
   */
  revealNonce?: number;
  /**
   * Called for a search hit that belongs to another sidebar view (a tool or
   * agent), so the dashboard can switch to that view, reveal the item and open it.
   */
  onCrossViewReveal?: (view: string, hit: PaletteSearchHit) => void;
  /**
   * Fires before the tree handles a library search hit, so the dashboard can
   * switch the sidebar to the library view. The tree then reveals and opens it.
   */
  onLibraryHit?: (hit: PaletteSearchHit) => void;
  /**
   * Render only the search widget (used above non-library sidebar views). The
   * tree still mounts and prefetches, so search hits resolve at once.
   */
  hideBody?: boolean;
  /** External refresh trigger, typically bumped by realtime workspace events. */
  refreshNonce?: number;
}

/**
 * What a tree drag can carry: a workspace node or a catalog table from a
 * Tables group. Tables are not nodes, but they select, drag and archive
 * alongside them.
 */
type TreeDragKind = LibraryTreeChild['kind'] | 'table';

/**
 * Every kind the create flows (tree `+` picker, ContainerView right-click
 * menu) can make, in menu order. `project` is a container with category 'project'.
 */
export const CREATABLE_KINDS = ['container', 'project', 'doc', 'thread'] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

/**
 * What the tree's `+` picker offers, in menu order: every creatable kind plus
 * `table`, which opens the table draft pane (offered wherever `thread` is).
 */
export const TREE_PICKER_KINDS = ['container', 'project', 'doc', 'thread', 'table'] as const;
export type TreePickerKind = (typeof TREE_PICKER_KINDS)[number];

/**
 * A thread participant with its agent record. `agent` is null when the
 * agent is not in the roster; the row then shows the agent id prefix.
 */
export interface ThreadAgentEntry {
  participant: ThreadParticipant;
  agent: SnagletAgent | null;
}

export interface DragPayload {
  id: string;
  kind: TreeDragKind;
  /**
   * Pre-drag placement and display name, stamped at dragstart, so drop
   * handlers in other components can record an exact undo inverse. Optional:
   * not every producer sets them.
   */
  parentId?: string | null;
  sortOrder?: number;
  label?: string;
}

/**
 * Where on a target row the cursor sits during a drag-over: `above` / `below`
 * land the source beside the row in the same parent; `inside` (containers
 * only) appends it to the container. Containers split 25 / 50 / 25; other
 * rows split 50 / 50.
 */
export type DropZone = 'above' | 'inside' | 'below';

interface CreatorPicker {
  stage: 'picker';
  parentContainerId: string | null;
  anchorLeft: number;
  anchorTop: number;
}

/**
 * The inline name prompt. Threads and tables draft inside their scope's
 * Threads / Tables group (parentContainerId = the project, or null for the
 * workspace-level group); every other kind drafts among the parent's children.
 */
export interface CreatorEditing {
  stage: 'editing';
  parentContainerId: string | null;
  kind: CreatableKind | 'table';
}

/** Kinds whose draft row lives inside a generated scope group, not among folder children. */
export function draftsInScopeGroup(kind: CreatorEditing['kind']): kind is 'thread' | 'table' {
  return kind === 'thread' || kind === 'table';
}

/**
 * A root-level draft of this kind is drawn in the workspace "Docs & context"
 * group; a new project's draft stays up with the projects.
 */
export function draftsInRootItems(kind: CreatorEditing['kind']): boolean {
  return kind !== 'project' && !draftsInScopeGroup(kind);
}

export type CreatorState = CreatorPicker | CreatorEditing | null;
