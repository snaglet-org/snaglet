import type { CSSProperties } from 'react';
import { safeJsonParse } from '@snaglet/shared/utils';
import type { ContainerTreeNode, LibraryTreeChild, ThreadTreeNode } from '../../utils/api';
import { EXPANDED_STORAGE_KEY } from './constants';

/**
 * Left padding of a row or group header at `depth` — the one indent rhythm
 * every tree row shares (and the shared SidebarTree rows match).
 */
export function rowIndent(depth: number): number {
  return 8 + depth * 14;
}

/**
 * Inline style of an `.indentGuide` group whose dashed line hangs off the
 * chevron of a parent row at `depth` (the chevron center sits 6px into the
 * row's padding).
 */
export function guideStyle(depth: number): CSSProperties {
  return { '--guide-left': `${rowIndent(depth) + 6}px` } as CSSProperties;
}

/**
 * The persisted `expanded` set, plus the workspace "Docs & context" group the
 * first time this browser loads the tree: that group holds the main rows, so
 * it starts open, and the one-time seed lets a later collapse stick.
 */
export function loadExpanded(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  const expanded = readExpanded();
  try {
    if (window.localStorage.getItem(ROOT_ITEMS_SEEDED_KEY) === null) {
      expanded.add(ROOT_ITEMS_GROUP_ID);
      window.localStorage.setItem(ROOT_ITEMS_SEEDED_KEY, '1');
    }
  } catch {
    expanded.add(ROOT_ITEMS_GROUP_ID);
  }
  return expanded;
}

function readExpanded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = safeJsonParse<unknown>(raw, null);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function findNodeInRoots(
  roots: LibraryTreeChild[] | null,
  id: string
): LibraryTreeChild | null {
  if (!roots) return null;
  for (const r of roots) {
    if (r.id === id) return r;
    if (r.kind === 'container') {
      const found = findNodeInRoots(r.children, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * All node ids strictly under `node` (excluding `node` itself). Walks
 * container.children — other node kinds are leaves in the tree.
 */
export function collectDescendantIds(node: LibraryTreeChild): Set<string> {
  const ids = new Set<string>();
  if (node.kind !== 'container') return ids;
  const stack: LibraryTreeChild[] = [...node.children];
  while (stack.length > 0) {
    const n = stack.pop()!;
    ids.add(n.id);
    if (n.kind === 'container') {
      for (const c of n.children) stack.push(c);
    }
  }
  return ids;
}

/**
 * The parent a node's placement hangs off: a container's parent folder, a
 * doc/image's folder, and — because threads are not in the folder
 * tree — a thread's project (`null` when flat). Every move, paste and undo
 * capture reads placement through this one rule.
 */
export function placementParentOf(node: LibraryTreeChild): string | null {
  if (node.kind === 'container') return node.parentId;
  if (node.kind === 'thread') return node.projectId;
  return node.containerId;
}

/** True for a project container — the only place a thread or table can be scoped. */
export function isProjectNode(
  node: LibraryTreeChild | undefined | null
): node is ContainerTreeNode {
  return node?.kind === 'container' && node.category === 'project';
}

/**
 * Expansion key of the generated Threads group under a project (`null` =
 * the workspace-level group for flat threads). Lives in the same persisted
 * `expanded` set as container ids; the `/` keeps it apart from node ids.
 */
export function threadsGroupId(projectId: string | null): string {
  return projectId === null ? 'workspace/threads' : `${projectId}/threads`;
}

/**
 * Expansion key of the generated Tables group under a project (`null` =
 * the workspace-level group for unlinked tables), parallel to
 * `threadsGroupId`.
 */
export function tablesGroupId(projectId: string | null): string {
  return projectId === null ? 'workspace/tables' : `${projectId}/tables`;
}

/**
 * Expansion key of the workspace "Docs & context" group: the top-level
 * folders, docs and images, drawn under their own header after
 * the projects so they never read as part of the project above them.
 */
export const ROOT_ITEMS_GROUP_ID = 'workspace/items';
const ROOT_ITEMS_SEEDED_KEY = `${EXPANDED_STORAGE_KEY}.itemsGroupSeeded`;

/**
 * Split the top-level rows (threads already removed) into the projects,
 * drawn first and flat, and everything else, drawn in the "Docs & context"
 * group. Each side keeps the payload's order.
 */
export function partitionRootNodes(nodes: LibraryTreeChild[]): {
  projects: ContainerTreeNode[];
  items: LibraryTreeChild[];
} {
  const projects: ContainerTreeNode[] = [];
  const items: LibraryTreeChild[] = [];
  for (const node of nodes) {
    if (isProjectNode(node)) projects.push(node);
    else items.push(node);
  }
  return { projects, items };
}

/**
 * Split a child list into the threads scoped to its owner and everything
 * that renders as a folder-tree row. The server nests a project's threads
 * among its children and lists flat threads at the root; the tree draws
 * them in a Threads group after the folders instead of in place.
 */
export function partitionThreads(nodes: LibraryTreeChild[]): {
  threads: ThreadTreeNode[];
  others: LibraryTreeChild[];
} {
  const threads: ThreadTreeNode[] = [];
  const others: LibraryTreeChild[] = [];
  for (const node of nodes) {
    if (node.kind === 'thread') threads.push(node);
    else others.push(node);
  }
  return { threads, others };
}

/** Display string for any library tree node — matches the fallback rules used in TreeRow. */
export function labelOfNode(node: LibraryTreeChild): string {
  if (node.kind === 'container') return node.name ?? '';
  if (node.kind === 'doc') return node.title ?? '';
  if (node.kind === 'thread') return node.title ?? '';
  return node.name ?? '';
}

/**
 * Canonical "copy link" markdown for a workspace node — `[Label](id)`.
 *
 * Every live node id is prefixed (`doc-…`, `container-…`, `thread-…`,
 * `image-…`), so the id already carries its type and no `<scheme>:` prefix is
 * needed — this is exactly what the server content-ref parser
 * (PREFIXED_NODE_LINK_RE) and `linkForm` emit. The scheme-qualified
 * `[Title](kind:id)` form does not parse for a prefixed id, so it is
 * deliberately not produced. `]` and `\` in the label are escaped so a title
 * can't break out of the markdown link text; an empty label falls back to the
 * id (which still resolves).
 */
export function nodeCopyLink(id: string, label: string | null | undefined): string {
  const safe = (label ?? '').replace(/[\]\\]/g, '\\$&') || id;
  return `[${safe}](${id})`;
}

/** First non-empty line of a string, trimmed. Falls back to empty string. */
export function firstLine(s: string | null | undefined): string {
  if (!s) return '';
  for (const ln of s.split('\n')) {
    const t = ln.trim();
    if (t) return t;
  }
  return '';
}
