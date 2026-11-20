import type { ArchivedNode, ArchiveTreeResponse } from '@desktop/utils/api';

/** `default` keeps the server's order; `newest` sorts siblings by archive time. */
export type ArchiveSort = 'default' | 'newest';

/** The kinds the drawer lists, in the order the filter shows them. */
export const ARCHIVE_KINDS = [
  { kind: 'container', label: 'Folders & projects' },
  { kind: 'doc', label: 'Docs' },
  { kind: 'thread', label: 'Threads' },
  { kind: 'table', label: 'Tables' },
  { kind: 'table_field', label: 'Columns' },
  { kind: 'agent', label: 'Agents' },
  { kind: 'automation', label: 'Automations' },
  { kind: 'image', label: 'Images' },
  { kind: 'memory', label: 'Memories' },
  { kind: 'message', label: 'Messages' },
  { kind: 'other', label: 'Other' },
] as const;

const KNOWN_KINDS: ReadonlySet<string> = new Set(ARCHIVE_KINDS.map((entry) => entry.kind));

export function archiveKindOf(type: string): string {
  return KNOWN_KINDS.has(type) ? type : 'other';
}

export function itemTitle(node: ArchivedNode): string {
  return node.title?.trim() || `Untitled ${node.type}`;
}

/** One listed item, in the drawer's tree order. */
export interface ArchiveEntry {
  id: string;
  node: ArchivedNode;
  title: string;
  kind: string;
  depth: number;
  /** Index of the parent entry, or -1 for a root. */
  parent: number;
  /**
   * Where the item sits, outermost first: the active folders or project a
   * root was archived from, then the titles of its archived ancestors.
   */
  path: readonly string[];
  /** Lowercased title and path: every word of a query must be in here. */
  haystack: string;
  /**
   * Lowercased text that is the item's own: its title, plus a root's
   * location (its active parents are not rows of their own). At least one
   * word of a query must be in here.
   */
  own: string;
}

function archivedTime(node: ArchivedNode): number {
  const ms = node.archived_at ? Date.parse(node.archived_at) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function ordered(nodes: readonly ArchivedNode[], sort: ArchiveSort): readonly ArchivedNode[] {
  if (sort === 'default') return nodes;
  return [...nodes].sort((a, b) => archivedTime(b) - archivedTime(a));
}

/**
 * Flatten the archive listing into rows: each root followed by its subtree,
 * children grouped under the item they were archived with. Children whose
 * parent is not listed are left out, as the tree view leaves them out.
 */
export function buildArchiveIndex(tree: ArchiveTreeResponse, sort: ArchiveSort): ArchiveEntry[] {
  const childrenByParent = new Map<string, ArchivedNode[]>();
  for (const child of tree.children) {
    const key = child.container_id ?? '';
    const siblings = childrenByParent.get(key);
    if (siblings) siblings.push(child);
    else childrenByParent.set(key, [child]);
  }

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const visit = (node: ArchivedNode, depth: number, parent: number, path: readonly string[]) => {
    // A listing is a tree; the guard keeps a malformed one from looping.
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const title = itemTitle(node);
    const index = entries.length;
    entries.push({
      id: node.id,
      node,
      title,
      kind: archiveKindOf(node.type),
      depth,
      parent,
      path,
      haystack: [title, ...path].join('\n').toLowerCase(),
      own: (parent === -1 ? [title, ...path] : [title]).join('\n').toLowerCase(),
    });
    const kids = childrenByParent.get(node.id);
    if (!kids) return;
    const childPath = [...path, title];
    for (const kid of ordered(kids, sort)) visit(kid, depth + 1, index, childPath);
  };
  for (const root of ordered(tree.roots, sort)) visit(root, 0, -1, root.location ?? []);
  return entries;
}

/** The words of a query, lowercased. */
export function parseArchiveQuery(query: string): string[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)];
}

interface ArchiveResultRow {
  entry: ArchiveEntry;
  /** An ancestor shown only so its matching descendants keep their place. */
  context: boolean;
}

export interface ArchiveSearchResult {
  rows: ArchiveResultRow[];
  /** Matches of the query and kind filter. */
  total: number;
  /** Matches among `rows` (at most the limit). */
  shown: number;
  /** What the All chip lists for the query, whatever the kind filter. */
  queryTotal: number;
  /** What each kind's chip lists for the query, by kind. */
  kindCounts: Map<string, number>;
  /** Matches of the query and kind filter below each item, by item id. */
  insideCounts: Map<string, number>;
}

interface ArchiveSearchOptions {
  terms: readonly string[];
  /** A kind from ARCHIVE_KINDS, or `all`. */
  kind: string;
  /** Most matches to return as rows; the counts cover every match. */
  limit: number;
}

/**
 * Every word must be in the item's title or path. Listing all kinds, at least
 * one must also be in what is its own: a word matching only an archived
 * parent narrows the search ("radio segments") but does not list the parent's
 * whole subtree, since the parent is a row and matches itself. Listing one
 * kind, the path alone is enough, so Docs + "radio" lists the docs inside the
 * Radio show projects.
 */
function inPath(entry: ArchiveEntry, terms: readonly string[]): boolean {
  return terms.every((term) => entry.haystack.includes(term));
}

function ownMatch(entry: ArchiveEntry, terms: readonly string[]): boolean {
  return terms.length === 0 || terms.some((term) => entry.own.includes(term));
}

export function searchArchive(
  index: readonly ArchiveEntry[],
  { terms, kind, limit }: ArchiveSearchOptions
): ArchiveSearchResult {
  const rows: ArchiveResultRow[] = [];
  const kindCounts = new Map<string, number>();
  const insideCounts = new Map<string, number>();
  const emitted = new Set<number>();
  let total = 0;
  let queryTotal = 0;

  for (let i = 0; i < index.length; i += 1) {
    const entry = index[i];
    if (!entry || !inPath(entry, terms)) continue;
    const listedInAll = ownMatch(entry, terms);
    if (listedInAll) queryTotal += 1;
    kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + 1);
    if (kind === 'all' ? !listedInAll : entry.kind !== kind) continue;
    total += 1;
    for (let up = entry.parent; up !== -1; up = index[up]?.parent ?? -1) {
      const id = index[up]?.id;
      if (id) insideCounts.set(id, (insideCounts.get(id) ?? 0) + 1);
    }
    if (total > limit) continue;

    // Ancestors come before their descendants, so any already listed were
    // listed above; the rest are added as context, outermost first.
    const ancestors: number[] = [];
    for (let up = entry.parent; up !== -1 && !emitted.has(up); up = index[up]?.parent ?? -1) {
      ancestors.push(up);
    }
    for (const up of ancestors.reverse()) {
      const ancestor = index[up];
      if (!ancestor) continue;
      emitted.add(up);
      rows.push({ entry: ancestor, context: true });
    }
    emitted.add(i);
    rows.push({ entry, context: false });
  }

  return { rows, total, shown: Math.min(total, limit), queryTotal, kindCounts, insideCounts };
}

/**
 * Where the query's words occur in `text`, as merged `[start, end)` ranges.
 * Empty when lowercasing changes the text's length, since offsets in the
 * lowercased copy would then point at the wrong characters.
 */
export function matchRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  if (terms.length === 0 || lower.length !== text.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) {
      ranges.push([at, at + term.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
