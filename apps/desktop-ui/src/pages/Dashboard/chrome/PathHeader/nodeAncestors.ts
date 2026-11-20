import type { LibraryTreeChild } from '@desktop/utils/api';

/** A container on the path to a node: a folder or a project. */
export type AncestorContainer = Extract<LibraryTreeChild, { kind: 'container' }>;

/**
 * Walk the library tree to find the containers leading to `nodeId`. A
 * project is a container, so its id matches directly. A thread is nested
 * under its project (never under a folder), so a project thread's path ends
 * at the project and a flat thread has no ancestors.
 *
 * Returns null when the node isn't anywhere in the tree (orphan / not
 * yet loaded). Returns the containers in document order — topmost first,
 * direct parent last.
 */
export function findNodeAncestorNodes(
  tree: LibraryTreeChild[],
  nodeId: string,
  stack: AncestorContainer[] = []
): AncestorContainer[] | null {
  for (const node of tree) {
    if (node.id === nodeId) return stack;
    if (node.kind === 'container') {
      const sub = findNodeAncestorNodes(node.children ?? [], nodeId, [...stack, node]);
      if (sub !== null) return sub;
    }
  }
  return null;
}

/** Same as `findNodeAncestorNodes`, as display names ("Untitled" for a blank one). */
export function findNodeAncestors(tree: LibraryTreeChild[], nodeId: string): string[] | null {
  return (
    findNodeAncestorNodes(tree, nodeId)?.map((ancestor) => ancestor.name || 'Untitled') ?? null
  );
}

/**
 * Same as `findNodeAncestors` but returns the *container ids* on the
 * path instead of names. Used by the workspace tree to know which
 * containers to expand when auto-revealing an node opened from a
 * different surface (icon pane, deep link, etc.).
 *
 * Returns null when the node isn't found anywhere in the tree.
 */
export function findNodeAncestorIds(
  tree: LibraryTreeChild[],
  nodeId: string,
  stack: string[] = []
): string[] | null {
  for (const node of tree) {
    if (node.id === nodeId) return stack;
    if (node.kind === 'container') {
      const sub = findNodeAncestorIds(node.children ?? [], nodeId, [...stack, node.id]);
      if (sub !== null) return sub;
    }
  }
  return null;
}

/** A tree node's display name: a container's or image's name, otherwise its title. */
function treeNodeTitle(node: LibraryTreeChild): string | null {
  const title = node.kind === 'container' || node.kind === 'image' ? node.name : node.title;
  return title?.trim() || null;
}

/**
 * The current display name of `nodeId` in the library tree. Returns null when
 * the node isn't in the tree or has no title.
 */
export function findNodeTitle(tree: LibraryTreeChild[], nodeId: string): string | null {
  for (const node of tree) {
    if (node.id === nodeId) return treeNodeTitle(node);
    if (node.kind === 'container') {
      const sub = findNodeTitle(node.children ?? [], nodeId);
      if (sub !== null) return sub;
    }
  }
  return null;
}
