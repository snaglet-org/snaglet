import type {
  FileTreeNode,
  HookWorkspaceInfo,
  LibraryTreeChild,
  ToolAvailability,
  ToolRow,
} from './api';
import type { ProjectIndexingRuntime } from '@snaglet/shared/types';

/**
 * Workspace mutation event bus. Components that hold their own copies of
 * workspace nodes (sidebar tree, pane selections, container browsers)
 * subscribe so a change anywhere reaches every cached copy without a refetch.
 * Emitters publish after the API call succeeds; receivers apply the change
 * idempotently.
 */

export type LibraryNodeKind = 'container' | 'doc' | 'thread' | 'image';

export type LibraryEvent =
  | {
      type: 'renamed';
      kind: LibraryNodeKind;
      id: string;
      /** New display name. For docs/threads this is the title; for containers/projects, the name. */
      name: string;
    }
  | {
      /**
       * A tool was enabled/disabled somewhere. Other panes holding a copy
       * of the tools state patch the matching row's `enabled` flag without
       * a refetch. The emitter has already updated its own state.
       */
      type: 'tool-enabled-changed';
      scope: 'tool';
      id: string;
      enabled: boolean;
      availability: ToolAvailability;
    }
  | {
      /**
       * A workspace-sourced tool's metadata was saved from the pane-hosted
       * ToolBuilderPanel. ToolsView's sidebar list holds its own copy of
       * every `ToolRow`, so this carries the full updated row for it to
       * re-render without a refetch.
       */
      type: 'tool-saved';
      tool: ToolRow;
    }
  | {
      /**
       * A hook's `hook.ts` was saved from the pane-hosted HookBuilderPanel;
       * the Automations list holds its own copy of every `HookWorkspaceInfo`.
       * `previousHookName` is set only when the save renamed the hook's
       * folder (hookName is the folder name), so consumers keyed by hookName
       * replace the row under the previous name.
       */
      type: 'hook-saved';
      hook: HookWorkspaceInfo;
      previousHookName?: string;
    }
  | {
      /**
       * A hook was deleted from Snaglet (files moved to the Trash, registration
       * deleted) somewhere other than the consumer, e.g. the archive drop
       * zone. Consumers keyed by hookName drop the matching row.
       */
      type: 'hook-deleted';
      hookName: string;
    }
  | {
      /**
       * A hook's automatic execution was turned on or off: from the
       * Automations list, its builder pane, or (relayed from the server's
       * `hook.enabled_changed`) the CLI or another window. Consumers keyed by
       * hookName patch their copy of the flag.
       */
      type: 'hook-enabled-changed';
      hookName: string;
      enabled: boolean;
    }
  | {
      /**
       * The server's hook registry saw these scripts' build or registration
       * change (relayed from `hook.registry_changed`): a build started or
       * ended, a folder appeared or went away. Lists re-read their copy.
       */
      type: 'hook-registry-changed';
      hookNames: string[];
    }
  | {
      /**
       * A doc's `content` was saved. Cached copies (sidebar tree,
       * detail-pane selections, container browsers) should swap in the
       * new body so reopening the doc later doesn't show stale content.
       */
      type: 'doc-saved';
      id: string;
      content: string;
      /** Optional fresh `updatedAt` — kept when the caller has it from the server response. */
      updatedAt?: string;
      /**
       * members.id the save stamped as the doc's editor (`lastEditedBy`).
       * Absent when the save was unattributed or the source didn't carry
       * it — consumers keep their current "Edited by" in that case.
       */
      lastEditedBy?: string;
    }
  | {
      /** Searchable image metadata changed in this or another client. */
      type: 'image-metadata-saved';
      id: string;
      description?: string | null;
      tags?: string[];
      updatedAt?: string;
    }
  | {
      /** Indexed file rows or their content-addressed embeddings changed. */
      type: 'file-embedding-coverage-changed';
    }
  | {
      /**
       * A file in a linked project folder was renamed in place. File panes
       * holding it by absolute path follow it to `toPath`.
       */
      type: 'file-renamed';
      fromPath: string;
      toPath: string;
      name: string;
    }
  | {
      /** A bounded project-folder scan completed using the current rules. */
      type: 'file-indexing-impact-changed';
      projectId: string;
      eligibleFiles: number;
      scannedEntries: number;
      capped: boolean;
    }
  | {
      /**
       * A project's indexing runtime changed: scan started/finished, backfill
       * progressed, clear began/completed, or an operation failed. Carries the
       * full runtime snapshot so status UIs update without a refetch.
       */
      type: 'file-indexing-status-changed';
      projectId: string;
      runtime: ProjectIndexingRuntime;
    }
  | {
      /**
       * One or more nodes (`ids`) were archived or restored elsewhere (drop
       * zone, archived drawer, agent tool call, …).
       *
       * `reload: true` makes consumers drop caches and refetch the tree.
       * By default the listener's local prune is enough for leaf archives
       * and avoids a loading flicker. Callers pass `reload: true` when
       * restoring (the node isn't in the local tree) or archiving a
       * container / project (the server cascades to children not in `ids`).
       */
      type: 'archive-changed';
      ids: string[];
      reload?: boolean;
    }
  | {
      /**
       * A node was structurally moved by an undo/redo replay. Consumers
       * holding hydrated child lists (sidebar tree, container panes) patch
       * in place via `applyNodeMoveToTree` for instant feedback; the undo
       * store follows up with `tree-invalidated` once the server settles,
       * so a consumer that can't apply the patch locally just waits for
       * that reconcile instead of refetching pre-write state.
       */
      type: 'node-moved';
      kind: LibraryNodeKind;
      id: string;
      /** Destination parent container (`null` = workspace root). */
      parentId: string | null;
      /** Destination slot; undefined = append to the parent's bucket. */
      sortOrder?: number;
      /** Snapshot for consumers that must re-insert a node they don't hold. */
      node?: LibraryTreeChild;
    }
  | {
      type: 'created';
      kind: LibraryNodeKind;
      id: string;
      parentId?: string;
      node: LibraryTreeChild;
    }
  | {
      type: 'deleted';
      kind: LibraryNodeKind;
      id: string;
    }
  | {
      /**
       * A workspace-tree shape change arrived from another client. Consumers
       * that own hydrated child lists should refetch rather than attempting
       * to reconstruct rich tree rows from the intentionally-small wire event.
       */
      type: 'tree-invalidated';
      ids: string[];
    };

const target = new EventTarget();
const EVENT_NAME = 'library';

export function emitLibraryEvent(event: LibraryEvent): void {
  target.dispatchEvent(new CustomEvent<LibraryEvent>(EVENT_NAME, { detail: event }));
}

export function onLibraryEvent(handler: (event: LibraryEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<LibraryEvent>).detail);
  target.addEventListener(EVENT_NAME, listener);
  return () => target.removeEventListener(EVENT_NAME, listener);
}

/**
 * Walk a workspace node and patch a doc's content/updatedAt if the id
 * matches. Recurses into container children. Returns the same reference
 * when nothing changed so React can skip re-renders.
 */
export function applyDocSavedToNode(
  node: LibraryTreeChild,
  id: string,
  content: string,
  updatedAt: string | undefined
): LibraryTreeChild {
  let updated: LibraryTreeChild = node;

  if (node.id === id && node.kind === 'doc') {
    const sameContent = node.content === content;
    const sameUpdatedAt = updatedAt === undefined || node.updatedAt === updatedAt;
    if (!sameContent || !sameUpdatedAt) {
      updated = {
        ...node,
        content,
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      };
    }
  }

  if (updated.kind === 'container') {
    const oldChildren = updated.children ?? [];
    if (oldChildren.length > 0) {
      const newChildren = oldChildren.map((c) => applyDocSavedToNode(c, id, content, updatedAt));
      const changed = newChildren.some((c, i) => c !== oldChildren[i]);
      if (changed) {
        updated = { ...updated, children: newChildren };
      }
    }
  }

  return updated;
}

/**
 * Walk a workspace node and apply a rename if the id matches. Recurses
 * into container children. Returns the same reference when nothing
 * changed so React can skip re-renders.
 */
export function applyRenameToNode(
  node: LibraryTreeChild,
  id: string,
  name: string
): LibraryTreeChild {
  let updated: LibraryTreeChild = node;

  if (node.id === id) {
    if (node.kind === 'container' && node.name !== name) {
      // A project's name is its container's name.
      updated = { ...node, name };
    } else if (node.kind === 'doc' && node.title !== name) {
      updated = { ...node, title: name };
    } else if (node.kind === 'thread' && node.title !== name) {
      updated = { ...node, title: name };
    } else if (node.kind === 'image' && node.name !== name) {
      updated = { ...node, name };
    }
  }

  if (updated.kind === 'container') {
    const oldChildren = updated.children ?? [];
    if (oldChildren.length > 0) {
      const newChildren = oldChildren.map((c) => applyRenameToNode(c, id, name));
      const changed = newChildren.some((c, i) => c !== oldChildren[i]);
      if (changed) {
        updated = { ...updated, children: newChildren };
      }
    }
  }

  return updated;
}

/** A path with its last segment replaced by `name`. */
function withBaseName(filePath: string, name: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? name : `${filePath.slice(0, slash + 1)}${name}`;
}

/**
 * Follow a renamed file in a file pane's node, matched by its absolute path
 * (a node opened by path also uses the path as its id). Returns the same
 * reference when the node is a different file.
 */
export function applyFileRenameToFileNode(
  node: FileTreeNode,
  rename: { fromPath: string; toPath: string; name: string }
): FileTreeNode {
  const idIsPath = node.id === rename.fromPath;
  if (!idIsPath && node.absolutePath !== rename.fromPath) return node;
  return {
    ...node,
    id: idIsPath ? rename.toPath : node.id,
    name: rename.name,
    relativePath:
      node.relativePath === rename.fromPath
        ? rename.toPath
        : withBaseName(node.relativePath, rename.name),
    absolutePath: rename.toPath,
  };
}

/**
 * Patch searchable image metadata in a node or one of its container children.
 * Returns the original reference when the event does not change anything.
 */
export function applyImageMetadataToNode(
  node: LibraryTreeChild,
  id: string,
  patch: {
    description?: string | null;
    tags?: string[];
    updatedAt?: string;
  }
): LibraryTreeChild {
  let updated: LibraryTreeChild = node;

  if (node.id === id && node.kind === 'image') {
    const nextDescription = patch.description !== undefined ? patch.description : node.description;
    const nextTags = patch.tags !== undefined ? patch.tags : node.tags;
    const nextUpdatedAt = patch.updatedAt !== undefined ? patch.updatedAt : node.updatedAt;
    const sameTags =
      nextTags.length === node.tags.length &&
      nextTags.every((tag, index) => tag === node.tags[index]);
    if (nextDescription !== node.description || !sameTags || nextUpdatedAt !== node.updatedAt) {
      updated = {
        ...node,
        description: nextDescription,
        tags: nextTags,
        updatedAt: nextUpdatedAt,
      };
    }
  }

  if (updated.kind === 'container') {
    const oldChildren = updated.children ?? [];
    if (oldChildren.length > 0) {
      const newChildren = oldChildren.map((child) => applyImageMetadataToNode(child, id, patch));
      const changed = newChildren.some((child, index) => child !== oldChildren[index]);
      if (changed) updated = { ...updated, children: newChildren };
    }
  }

  return updated;
}

/** Structural move a consumer wants applied to a locally-held tree. */
export interface NodeMovePatch {
  id: string;
  /** Destination parent container (`null` = the tree's own top level). */
  parentId: string | null;
  /** Destination slot; undefined = append. */
  sortOrder?: number;
  /** Fallback snapshot when the consumer's tree doesn't hold the node. */
  node?: LibraryTreeChild;
}

/**
 * Apply a structural move to a hydrated tree: detach the node, then
 * re-insert it under the destination parent (a thread's parent is its
 * project) at the requested slot. Best-effort: an unknown node with no
 * snapshot leaves the tree unchanged, and a destination outside this tree
 * still detaches. Sibling `sortOrder`s are not renumbered; the follow-up
 * `tree-invalidated` reconcile fixes them. `rootParentId` is the container
 * this tree's top level represents (`null` = workspace root).
 */
export function applyNodeMoveToTree(
  nodes: LibraryTreeChild[],
  move: NodeMovePatch,
  opts: { rootParentId?: string | null } = {}
): LibraryTreeChild[] {
  const rootParentId = opts.rootParentId ?? null;

  let found: LibraryTreeChild | null = null;
  const detach = (list: LibraryTreeChild[]): LibraryTreeChild[] => {
    let changed = false;
    const out: LibraryTreeChild[] = [];
    for (const n of list) {
      if (n.id === move.id) {
        found = n;
        changed = true;
        continue;
      }
      if (n.kind === 'container' && (n.children?.length ?? 0) > 0) {
        const kids = detach(n.children);
        if (kids !== n.children) {
          out.push({ ...n, children: kids });
          changed = true;
        } else {
          out.push(n);
        }
      } else {
        out.push(n);
      }
    }
    return changed ? out : list;
  };

  const detached = detach(nodes);
  const subject: LibraryTreeChild | null = found ?? move.node ?? null;
  if (!subject) return nodes;

  const insertInto = (siblings: LibraryTreeChild[]): LibraryTreeChild[] => {
    const slot = move.sortOrder ?? siblings.reduce((max, s) => Math.max(max, s.sortOrder), -1) + 1;
    // Retarget the node's own placement fields so follow-up captures (the
    // next drag's inverse) read the post-move values, not stale ones. A
    // thread's placement is its project.
    const moved: LibraryTreeChild =
      subject.kind === 'container'
        ? { ...subject, parentId: move.parentId, sortOrder: slot }
        : subject.kind === 'thread'
          ? { ...subject, projectId: move.parentId, sortOrder: slot }
          : { ...subject, containerId: move.parentId, sortOrder: slot };
    let index = siblings.findIndex((s) => s.sortOrder >= slot);
    if (index === -1) index = siblings.length;
    return [...siblings.slice(0, index), moved, ...siblings.slice(index)];
  };

  if (move.parentId === rootParentId) return insertInto(detached);

  let inserted = false;
  const insertWalk = (list: LibraryTreeChild[]): LibraryTreeChild[] => {
    let changed = false;
    const out = list.map((n) => {
      if (inserted || n.kind !== 'container') return n;
      if (n.id === move.parentId) {
        inserted = true;
        changed = true;
        return { ...n, children: insertInto(n.children ?? []) };
      }
      const oldKids = n.children ?? [];
      const kids = insertWalk(oldKids);
      if (kids === oldKids) return n;
      changed = true;
      return { ...n, children: kids };
    });
    return changed ? out : list;
  };

  const next = insertWalk(detached);
  // Destination not visible in this tree — the node left this subtree, so
  // the detach alone is the correct local outcome.
  return inserted ? next : detached;
}

/**
 * Recursively drop any node whose id is in `ids` from a tree. Walks into
 * container children. Returns the same reference when nothing changed so
 * React can skip re-renders. The caller filters the top-level roots array
 * separately; this only prunes descendants of the given node.
 */
export function pruneNodesById(node: LibraryTreeChild, ids: Set<string>): LibraryTreeChild {
  if (node.kind !== 'container') return node;
  const oldChildren = node.children ?? [];
  if (oldChildren.length === 0) return node;

  const newChildren = oldChildren.filter((c) => !ids.has(c.id)).map((c) => pruneNodesById(c, ids));

  const removed = newChildren.length !== oldChildren.length;
  const recursed = newChildren.some((c, i) => {
    // Index alignment only holds when nothing was filtered out; if anything
    // was, the list already changed.
    return !removed && c !== oldChildren[i];
  });

  if (removed || recursed) {
    return { ...node, children: newChildren };
  }
  return node;
}
