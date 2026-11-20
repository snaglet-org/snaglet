import {
  AGENT_ID_PREFIX,
  idPrefixAlternation,
  LEGACY_ID_PREFIX,
  NODE_KIND,
} from '@snaglet/shared/constants/nodeKinds';
import type { ContainerRecord, ContainerTreeNode, LibraryTreeChild } from '@desktop/utils/api';
import type { WikiNodeKind } from './WikiLinkPreviewModal';

// The kinds a chip can name — mirrors LinkNodeType in
// packages/db/tables/links/LinkModel.ts. One alternation feeds both chip
// forms below so they cannot drift from each other.
const CHIP_KIND_ALT = idPrefixAlternation([
  LEGACY_ID_PREFIX.PAGE,
  NODE_KIND.CONTAINER,
  LEGACY_ID_PREFIX.LIBRARY_NODE,
  NODE_KIND.THREAD,
  NODE_KIND.THREAD_SUMMARY,
  NODE_KIND.MESSAGE,
  NODE_KIND.MEMORY,
  AGENT_ID_PREFIX,
  LEGACY_ID_PREFIX.TASK,
  LEGACY_ID_PREFIX.PROJECT,
  NODE_KIND.TOOL,
  NODE_KIND.IMAGE,
  // Sketch and post ids have no feature behind them but can appear in
  // stored content, so the parser still recognizes their prefixes.
  LEGACY_ID_PREFIX.SKETCH,
  LEGACY_ID_PREFIX.POST,
]);

// Match the chip URL scheme: `<kind>:<uuid>`.
export const CHIP_URL_RE = new RegExp(`^(${CHIP_KIND_ALT}):([^\\s]+)$`, 'i');

// Match the prefixed-id chip form: `<kind>-<rest>` (e.g. `thread-1782…`),
// which `chipMd` emits when the id already carries its kind prefix.
export const CHIP_PREFIXED_ID_RE = new RegExp(`^(${CHIP_KIND_ALT})-([^\\s]+)$`, 'i');

/** The first non-empty line of a body, without leading heading markers. Titles
 *  kinds with no `title` column (message, memory, thread summary). */
export function firstNonEmptyLine(s: string | null | undefined, max = 80): string {
  if (!s) return '';
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim().replace(/^#+\s*/, '');
    if (line.length === 0) continue;
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return '';
}

/** Chip markdown for a node: `[Label](thread-…)` when the id carries its kind
 *  prefix, otherwise the scheme form `[Label](kind:uuid)`. */
export function chipMd(label: string, kind: string, id: string): string {
  const prefixed = id.startsWith(`${kind}-`);
  const href = prefixed ? id : `${kind}:${id}`;
  return `[${label}](${href})`;
}

/** Parse a chip URL into kind and id, or null. Accepts the scheme form
 *  (`kind:uuid`) and the prefixed-id form (`kind-uuid`); the latter keeps the
 *  full prefixed id, the shape APIs expect. */
export function parseChipUrl(url: string): { kind: WikiNodeKind; id: string } | null {
  // A `task` chip names a doc with the same id, so it previews as `page`.
  const normalize = (kind: string): WikiNodeKind =>
    (kind === 'task' ? 'page' : kind) as WikiNodeKind;
  const scheme = CHIP_URL_RE.exec(url);
  if (scheme) {
    return { kind: normalize(scheme[1].toLowerCase()), id: scheme[2] };
  }
  const prefixed = CHIP_PREFIXED_ID_RE.exec(url);
  if (prefixed) {
    return { kind: normalize(prefixed[1].toLowerCase()), id: url };
  }
  return null;
}

/** Walk the tree response and find the matching container. Mirrors the
 *  helper inside ContainerView so we hand the embedded view a node with
 *  real children instead of an empty placeholder. */
export function findContainerInTree(
  nodes: LibraryTreeChild[],
  id: string
): ContainerTreeNode | null {
  for (const n of nodes) {
    if (n.kind !== 'container') continue;
    if (n.id === id) return n;
    const inChildren = findContainerInTree(n.children ?? [], id);
    if (inChildren) return inChildren;
  }
  return null;
}

/** Build a ContainerTreeNode from a bare ContainerRecord when listTree can't
 *  find the row (e.g. a project-scoped container). Children start empty;
 *  ContainerView refetches them on library events. */
export function containerRecordToTreeNode(record: ContainerRecord): ContainerTreeNode {
  return {
    ...record,
    kind: 'container',
    children: [],
    // ContainerRecord carries these optionally (and no githubUrl at all);
    // the tree node declares them non-optional, mirroring the wire.
    category: record.category ?? null,
    folderPath: record.folderPath ?? null,
    githubUrl: null,
  };
}
