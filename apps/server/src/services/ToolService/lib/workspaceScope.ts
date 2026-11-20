/**
 * workspaceScope — shared container-subtree resolution used by workspace_tree
 * and workspace_search.
 *
 * Both tools support scoping the operation to a single container's subtree.
 * Callers can identify that container three ways:
 *
 *   - `container_id`: direct id (fastest, no ambiguity)
 *   - `path`:         slash-delimited names from root (e.g. "/Snaglet/docs")
 *   - `name`:         a container name; if multiple containers share the
 *                     name, the result is `ambiguous` with their paths so
 *                     the agent can disambiguate on the next call.
 *
 * Name matching is case-insensitive — agents shouldn't have to remember
 * exact casing. Path matching is case-insensitive segment-by-segment for
 * the same reason. The matched container's REAL name (preserving casing)
 * is used in any paths echoed back to the agent.
 */

import type { ContainerRow } from '@snaglet/db/tables/containers';
import { NODE_KIND } from '@snaglet/shared/constants';
import { asNonEmptyString, safeJsonParse } from '@snaglet/shared/utils';

/**
 * The subset of `public.node_type` that participates in the workspace —
 * the nodes an agent navigates via `workspace_tree` / `workspace_search`.
 * Other node types (memory, agent, message, etc.) live in their own
 * tool metadata and are intentionally excluded here.
 */
export const WORKSPACE_NODE_KINDS = [NODE_KIND.CONTAINER, NODE_KIND.DOC, NODE_KIND.THREAD] as const;
export type WorkspaceNodeKind = (typeof WORKSPACE_NODE_KINDS)[number];

/**
 * Kinds that render like a workspace node in search output.
 */
export type SearchRenderKind = WorkspaceNodeKind;

/**
 * Glyph rendered as a prefix on every result line. Reinforces the kind for
 * skim-reading even though the link form already encodes it (`doc-…`,
 * `container-…`, etc.).
 */
export const KIND_GLYPH: Record<SearchRenderKind, string> = {
  container: '📂',
  doc: '📄',
  thread: '💬',
};

/**
 * Map a `WorkspaceNodeKind` to the `LinkNodeType` scheme used by
 * `linkForm()`. For prefixed ids (`doc-…`) the scheme is irrelevant since
 * `linkForm` emits the bare `[Title](doc-id)` form; it only matters for
 * bare-UUID ids (still present in older content), which use `page:` as their
 * scheme.
 */
export const KIND_TO_LINK_SCHEME = {
  container: 'container',
  doc: 'doc',
  thread: 'thread',
} as const satisfies Record<SearchRenderKind, string>;

/**
 * Parse a `kinds` input: accepts an array of strings, a single comma-
 * separated string, or null/undefined for "all kinds". Unknown values are
 * silently dropped. Returns the deduplicated, validated set.
 */
export function parseKinds(input: unknown): WorkspaceNodeKind[] {
  if (input == null) return [...WORKSPACE_NODE_KINDS];
  // Handle JSON-stringified arrays emitted by smaller models (e.g. '["doc","task"]')
  let normalized: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    // Malformed JSON falls through to the comma-split below.
    if (trimmed.startsWith('[')) normalized = safeJsonParse<unknown>(trimmed, input);
  }
  const raw: unknown[] = Array.isArray(normalized)
    ? normalized
    : typeof normalized === 'string'
      ? normalized.split(',')
      : [];
  const set = new Set<WorkspaceNodeKind>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim().toLowerCase();
    if ((WORKSPACE_NODE_KINDS as readonly string[]).includes(t)) {
      set.add(t as WorkspaceNodeKind);
    }
  }
  return set.size === 0 ? [...WORKSPACE_NODE_KINDS] : [...set];
}

export interface ScopeInput {
  container_id?: unknown;
  path?: unknown;
  name?: unknown;
}

export type ScopeResult =
  | { kind: 'unscoped' }
  | { kind: 'scoped'; containerId: string }
  | { kind: 'error'; message: string };

function buildChildrenIndex(rows: ContainerRow[]): Map<string | null, ContainerRow[]> {
  const out = new Map<string | null, ContainerRow[]>();
  for (const c of rows) {
    const key = c.parentId ?? null;
    const list = out.get(key);
    if (list) list.push(c);
    else out.set(key, [c]);
  }
  return out;
}

/**
 * Walk parent pointers from `id` up to a root, returning a `/`-prefixed path.
 * Returns the raw id if its row is missing — defensive against orphans.
 */
function containerPath(id: string, rows: ContainerRow[]): string {
  const byId = new Map(rows.map((c) => [c.id, c]));
  const segments: string[] = [];
  let cur = byId.get(id);
  while (cur) {
    segments.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return segments.length > 0 ? `/${segments.join('/')}` : id;
}

/**
 * Resolve `{ container_id, path, name }` against `containerRows` into a
 * single container id (or `unscoped` / an error message).
 *
 * Precedence when multiple inputs are set: `container_id` > `path` > `name`.
 */
export function resolveContainerScope(
  input: ScopeInput,
  containerRows: ContainerRow[]
): ScopeResult {
  const containerId = asNonEmptyString(input.container_id);
  if (containerId) return { kind: 'scoped', containerId };

  const pathInput = asNonEmptyString(input.path);
  if (pathInput) {
    const segments = pathInput.split('/').filter(Boolean);
    if (segments.length === 0) return { kind: 'unscoped' };

    const byParent = buildChildrenIndex(containerRows);
    let parentId: string | null = null;
    let matched: ContainerRow | null = null;
    for (const seg of segments) {
      const siblings: ContainerRow[] = byParent.get(parentId) ?? [];
      const hits = siblings.filter((c: ContainerRow) => c.name.toLowerCase() === seg.toLowerCase());
      if (hits.length === 0) {
        const here = parentId === null ? '/' : containerPath(parentId, containerRows);
        return {
          kind: 'error',
          message: `No container "${seg}" under ${here}.`,
        };
      }
      if (hits.length > 1) {
        const here = parentId === null ? '/' : containerPath(parentId, containerRows);
        const idList = hits.map((c) => c.id).join(', ');
        return {
          kind: 'error',
          message: `Ambiguous path segment "${seg}" under ${here} — multiple containers share this name. Call again with \`container_id\` set to one of: ${idList}.`,
        };
      }
      matched = hits[0];
      parentId = matched.id;
    }
    return matched ? { kind: 'scoped', containerId: matched.id } : { kind: 'unscoped' };
  }

  const nameInput = asNonEmptyString(input.name);
  if (nameInput) {
    const needle = nameInput.toLowerCase();
    const hits = containerRows.filter((c) => c.name.toLowerCase() === needle);
    if (hits.length === 0) {
      return { kind: 'error', message: `No container named "${nameInput}".` };
    }
    if (hits.length === 1) {
      return { kind: 'scoped', containerId: hits[0].id };
    }
    const paths = hits.map((c) => `- ${containerPath(c.id, containerRows)}`).join('\n');
    return {
      kind: 'error',
      message: `Multiple containers named "${nameInput}":\n${paths}\n\nCall again with \`path\` set to one of these to disambiguate.`,
    };
  }

  return { kind: 'unscoped' };
}
