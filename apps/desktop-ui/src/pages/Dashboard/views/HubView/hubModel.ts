/**
 * Pure helpers behind the Home pane: indexing the workspace tree into the
 * lists Home shows, the greeting, message snippets and the pin shapes.
 */

import type { TableCatalogEntry } from '@snaglet/shared/types';
import type {
  ContainerTreeNode,
  DocTreeNode,
  LibraryTreeChild,
  ThreadTreeNode,
} from '@desktop/utils/api';

/** What Home can pin. Projects are containers with `category === 'project'`. */
export type PinKind = 'thread' | 'doc' | 'project' | 'table';

/** One pin as stored in the `home.pinned` setting. */
export interface PinRecord {
  kind: PinKind;
  id: string;
  /** The item's name when it was pinned; shown only if the item is gone. */
  title?: string;
  pinnedAt: string;
}

/** How many items each of Home's recent lists (threads, docs) holds; they scroll. */
const HUB_RECENT_LIMIT = 30;

export function pinKey(kind: PinKind, id: string): string {
  return `${kind}:${id}`;
}

const PIN_KINDS: ReadonlySet<string> = new Set(['thread', 'doc', 'project', 'table']);

/** The pins of one person from the stored map; malformed entries are dropped. */
export function readPins(value: unknown, userId: string): PinRecord[] {
  if (!value || typeof value !== 'object') return [];
  const mine = (value as Record<string, unknown>)[userId];
  if (!mine || typeof mine !== 'object') return [];
  const pins: PinRecord[] = [];
  for (const raw of Object.values(mine as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const pin = raw as Record<string, unknown>;
    if (typeof pin.kind !== 'string' || !PIN_KINDS.has(pin.kind)) continue;
    if (typeof pin.id !== 'string' || !pin.id) continue;
    pins.push({
      kind: pin.kind as PinKind,
      id: pin.id,
      ...(typeof pin.title === 'string' ? { title: pin.title } : {}),
      pinnedAt: typeof pin.pinnedAt === 'string' ? pin.pinnedAt : '',
    });
  }
  // Oldest first, so a new pin joins the end and the others stay put.
  return pins.sort((a, b) => a.pinnedAt.localeCompare(b.pinnedAt));
}

export interface IndexedDoc {
  node: DocTreeNode;
  /** Names of the folders and projects above the doc, outermost first. */
  path: string[];
}

export interface IndexedThread {
  node: ThreadTreeNode;
  /** The thread's project name, or null for a workspace-level thread. */
  projectName: string | null;
}

export interface TreeIndex {
  docs: IndexedDoc[];
  threads: IndexedThread[];
  projects: ContainerTreeNode[];
  docsById: Map<string, IndexedDoc>;
  threadsById: Map<string, IndexedThread>;
  projectsById: Map<string, ContainerTreeNode>;
}

/** Walk the workspace tree once into the lists and lookups Home needs. */
export function indexTree(tree: LibraryTreeChild[]): TreeIndex {
  const index: TreeIndex = {
    docs: [],
    threads: [],
    projects: [],
    docsById: new Map(),
    threadsById: new Map(),
    projectsById: new Map(),
  };
  const walk = (nodes: LibraryTreeChild[], path: string[], projectName: string | null) => {
    for (const node of nodes) {
      if (node.kind === 'doc') {
        const entry = { node, path };
        index.docs.push(entry);
        index.docsById.set(node.id, entry);
      } else if (node.kind === 'thread') {
        const entry = { node, projectName };
        index.threads.push(entry);
        index.threadsById.set(node.id, entry);
      } else if (node.kind === 'container') {
        const isProject = node.category === 'project';
        if (isProject) {
          index.projects.push(node);
          index.projectsById.set(node.id, node);
        }
        walk(node.children, [...path, node.name], isProject ? node.name : projectName);
      }
    }
  };
  walk(tree, [], null);
  return index;
}

/** When a thread was last active: its last message, else its last change. */
export function threadActivityAt(thread: ThreadTreeNode): string {
  return thread.lastMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

function newestFirst(a: string, b: string): number {
  return (Date.parse(b) || 0) - (Date.parse(a) || 0);
}

export function recentThreads(index: TreeIndex, limit = HUB_RECENT_LIMIT): IndexedThread[] {
  return [...index.threads]
    .sort((a, b) => newestFirst(threadActivityAt(a.node), threadActivityAt(b.node)))
    .slice(0, limit);
}

export function recentDocs(index: TreeIndex, limit = HUB_RECENT_LIMIT): IndexedDoc[] {
  return [...index.docs]
    .sort((a, b) => newestFirst(a.node.updatedAt, b.node.updatedAt))
    .slice(0, limit);
}

/**
 * Tables Home offers to pin: the user's own active tables. Built-in system
 * tables (Agents, Docs, Hooks…) stay out of Home for now.
 */
export function pinnableTables(tables: TableCatalogEntry[]): TableCatalogEntry[] {
  return tables.filter((table) => !table.state && table.origin !== 'builtin');
}

/** "Good morning" before noon, "Good afternoon" before 6 pm, else "Good evening". */
export function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Mon, Nov 16" in the user's locale. */
export function shortDate(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * One line of plain text from a chat message's markdown: chips and links keep
 * their label, code fences and images drop out, emphasis marks and headings
 * go, and whitespace collapses. Cut at `max` characters with an ellipsis.
 */
export function messageSnippet(content: string, max = 160): string {
  const text = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
