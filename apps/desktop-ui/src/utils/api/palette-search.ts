import { fetchData, getApiUrl } from './core';
import {
  PALETTE_NODE_KINDS,
  type PaletteEntryHit,
  type PaletteNodeKind,
  type PaletteSearchMode,
} from '@snaglet/shared';
import {
  TABLE_ORIGINS,
  type TableCatalogEntry,
  type TableOrigin,
} from '@snaglet/shared/types/tables';

export { PALETTE_NODE_KINDS };
export type { PaletteEntryHit, PaletteNodeKind };

export type PaletteSearchChannel = 'fts' | 'vector';
export type PaletteSemanticStatus = 'ready' | 'disabled' | 'unavailable';
export type PaletteCoverageMode = 'hybrid' | 'semantic' | 'lexical' | 'disabled';
type PaletteFilesystemKind = 'file' | 'folder';
export type PaletteSearchKind = PaletteNodeKind | PaletteFilesystemKind;

export interface PaletteSearchHit {
  node_id: string;
  kind: PaletteNodeKind;
  score: number;
  channels: PaletteSearchChannel[];
  /** Raw cosine similarity from the vector channel, when present. */
  vectorSimilarity?: number;
  payload: Record<string, unknown>;
}

interface PaletteSearchResult {
  byKind: Partial<Record<PaletteNodeKind, PaletteSearchHit[]>>;
  channelsUsed: PaletteSearchChannel[];
  semanticStatus: PaletteSemanticStatus;
  /** User-facing reason when semanticStatus is not 'ready' (e.g. the embedder is not installed yet). */
  semanticStatusReason?: string | null;
  coverage: Partial<Record<PaletteNodeKind, PaletteCoverageMode>>;
  /**
   * What the server actually executed. Mirrors `SearchExecutionMetadata` on the
   * server; the unions list only values the server can send.
   */
  executionPlan?: {
    query: string;
    scopePolicy: 'strict' | 'neutral';
    /** Project name — or table name for `table:<name> entry:` — when typed in the query. */
    scopeLabel?: string;
    /** The project/container (or table) id the strict filter used. */
    scopeId?: string;
    scopeSource?: 'explicit' | 'named_project' | 'named_table';
    /**
     * Present only when a requested scope could NOT be applied. Always
     * accompanied by zero results — never render this as an empty search.
     */
    scopeError?: {
      code: 'not_found' | 'ambiguous' | 'conflict';
      message: string;
      name?: string;
      matches?: string[];
    };
    timeLabel?: string;
    ordering: 'relevance' | 'updated_desc' | 'created_desc';
    gaps: string[];
  };
}

type PaletteKindFilterOption = {
  prefix: string;
  kind: PaletteNodeKind;
  label: string;
  aliases: readonly string[];
};

/**
 * Canonical human-search type filters. Cmd+K, workspace-tree search, and the
 * editor @ query all consume this registry so a searchable kind cannot be
 * added to one surface and silently omitted from the others.
 */
// Exported for tests (palette-search.test.ts); app code consumes the derived
// PALETTE_KIND_FILTER_PREFIXES / PREFIX_FILTER_META instead.
export const PALETTE_KIND_FILTER_OPTIONS: readonly PaletteKindFilterOption[] = [
  { prefix: 'doc', kind: 'doc', label: 'Doc', aliases: ['docs'] },
  { prefix: 'thread', kind: 'thread', label: 'Thread', aliases: ['threads', 'chat'] },
  {
    prefix: 'container',
    kind: 'container',
    label: 'Container',
    aliases: ['containers', 'project', 'projects'],
  },
  { prefix: 'image', kind: 'image', label: 'Image', aliases: ['images', 'photo', 'photos'] },
  { prefix: 'agent', kind: 'agent', label: 'Agent', aliases: ['agents'] },
  { prefix: 'message', kind: 'message', label: 'Message', aliases: ['messages', 'msg'] },
  { prefix: 'memory', kind: 'memory', label: 'Memory', aliases: ['memories'] },
  { prefix: 'tool', kind: 'tool', label: 'Tool', aliases: ['tools'] },
  {
    prefix: 'summary',
    kind: 'thread_summary',
    label: 'Summary',
    aliases: ['summaries', 'thread_summary', 'thread_summaries'],
  },
  // Database catalog tables (built-in and custom), matched by name.
  { prefix: 'table', kind: 'table', label: 'Table', aliases: ['tables'] },
] as const;

export const PALETTE_KIND_FILTER_PREFIXES = PALETTE_KIND_FILTER_OPTIONS.map(
  (option) => option.prefix
);

export const PREFIX_FILTER_META: Record<string, { kind: PaletteNodeKind; label: string }> =
  Object.fromEntries(
    PALETTE_KIND_FILTER_OPTIONS.flatMap((option) =>
      [option.prefix, ...option.aliases].map((prefix) => [
        prefix,
        { kind: option.kind, label: option.label },
      ])
    )
  );

export function parsePalettePrefix(
  value: string
): { prefix: string; remainder: string; kind: PaletteNodeKind | 'file' | 'folder' } | null {
  const match = value.match(/^([a-z][a-z0-9_]*):(.*)$/i);
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  if (prefix === 'file' || prefix === 'folder') {
    return { prefix, remainder: match[2], kind: prefix };
  }
  const meta = PREFIX_FILTER_META[prefix];
  return meta ? { prefix, remainder: match[2], kind: meta.kind } : null;
}

/**
 * Whether a search with these kind filters lists table rows beside its results: an unfiltered one,
 * or one filtered to tables alone (its results are the tables, then their rows; nothing else).
 * Every quick search (sidebar, `@` picker, ⌘K) follows this one rule.
 */
export function entrySectionWanted(kinds: readonly string[] | null | undefined): boolean {
  return !kinds?.length || (kinds.length === 1 && kinds[0] === 'table');
}

function payloadText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A table hit's catalog entry, when its hydrated payload carries the whole
 * entry. The hit id is the catalog id — never a workspace node id.
 */
export function paletteTableEntry(
  tableId: string,
  payload: Record<string, unknown>
): TableCatalogEntry | null {
  const name = payloadText(payload, 'name') ?? payloadText(payload, 'title');
  const createdAt = payloadText(payload, 'createdAt');
  const origin = payload.origin;
  const isOrigin = (value: unknown): value is TableOrigin =>
    (TABLE_ORIGINS as readonly unknown[]).includes(value);
  if (!name || !createdAt || !isOrigin(origin)) return null;
  // filled by the tree/palette payload once the server emits it
  const sortOrder = typeof payload.sortOrder === 'number' ? payload.sortOrder : 0;
  return {
    id: tableId,
    name,
    origin,
    projectId: payloadText(payload, 'projectId'),
    sortOrder,
    createdAt,
  };
}

/** Human-readable evidence excerpt carried by a palette result payload. */
export function paletteHitContext(hit: Pick<PaletteSearchHit, 'kind' | 'payload'>): string | null {
  // Tables carry no text evidence; name the tree group they live in.
  if (hit.kind === 'table') {
    const origin = hit.payload.origin;
    return origin === 'builtin' ? 'Snaglet table' : origin === 'custom' ? 'Your table' : null;
  }
  if (hit.kind !== 'image') return payloadText(hit.payload, 'subtitle');
  const description = payloadText(hit.payload, 'description');
  const tags = Array.isArray(hit.payload.tags)
    ? hit.payload.tags.filter(
        (tag): tag is string => typeof tag === 'string' && Boolean(tag.trim())
      )
    : [];
  const boundedDescription = description?.slice(0, 240) ?? null;
  const boundedTags = tags.slice(0, 8).map((tag) => tag.trim().slice(0, 64));
  return (
    [boundedDescription, boundedTags.length > 0 ? `Tags: ${boundedTags.join(', ')}` : null]
      .filter((value): value is string => Boolean(value))
      .join(' · ') || null
  );
}

export type PaletteWorkspaceItem = {
  type: 'workspace';
  nodeId: string;
  nodeType: PaletteNodeKind;
  title: string;
  subtitle: string | null;
  icon: string | null;
  score: number;
  archived: boolean;
};

export type PaletteFilesystemItem = {
  type: 'filesystem';
  filesystemKind: PaletteFilesystemKind;
  name: string;
  path: string;
  subtitle: string | null;
  score: number;
};

/**
 * An embedded `file` node match (semantic). Parallel to PaletteFilesystemItem
 * (filename fuzzy) — the server returns both so the UI can show them together.
 */
export type PaletteFileNodeItem = {
  type: 'file-node';
  nodeId: string;
  relativePath: string;
  /** Absolute on-disk path — used as a file chip's reference so it resolves /
   * previews correctly (a relative path can't be located on disk server-side). */
  absolutePath: string;
  projectId: string;
  sizeBytes: number;
  updatedAt: string;
  score: number;
};

type PaletteSearchItem = PaletteWorkspaceItem | PaletteFilesystemItem;

export type PaletteAugmentedResponse = PaletteSearchResult & {
  items: PaletteSearchItem[];
  filesystem: PaletteFilesystemItem[];
  files: PaletteFileNodeItem[];
  /**
   * Table rows: an `entry:` search's results, or the short Entries section an
   * unfiltered search asked for with `includeEntries`. Best first; always set
   * by `paletteSearchApi.search` (optional for hand-built responses).
   */
  entries?: PaletteEntryHit[];
  meta: {
    query: string;
    kinds: PaletteSearchKind[];
    workspaceCount: number;
    filesystemCount: number;
  };
};

export type PaletteSearchRequest = {
  query: string;
  kinds?: PaletteSearchKind[];
  mode?: PaletteSearchMode;
  limit?: number;
  perKindLimit?: number;
  projectId?: string;
  containerId?: string;
  threadId?: string;
  activeNodeId?: string;
  clientDebounceMs?: number;
  /** Add a short Entries section (table rows) to an unfiltered search. */
  includeEntries?: boolean;
  /**
   * Abort the in-flight request. Interactive surfaces pass a per-request
   * signal so a new keystroke cancels the previous fetch (tiered search).
   */
  signal?: AbortSignal;
};

function normalizeKinds(kinds?: PaletteSearchKind[]): PaletteSearchKind[] {
  if (!kinds || kinds.length === 0) return [];
  const allowed = new Set<PaletteSearchKind>([...PALETTE_NODE_KINDS, 'file', 'folder']);
  return kinds.filter((kind): kind is PaletteSearchKind => allowed.has(kind));
}

/**
 * Built-in (Snaglet-managed) tables are an agent-tool surface, not a UI one: they
 * never appear in search results, the tree or pickers. Agents keep them via
 * the `table` tool; a chip to one still opens its read-only view.
 */
function withoutBuiltinTables(
  byKind: PaletteSearchResult['byKind']
): PaletteSearchResult['byKind'] {
  const tables = byKind?.table;
  if (!tables) return byKind;
  return { ...byKind, table: tables.filter((hit) => hit.payload.origin !== 'builtin') };
}

function workspaceItemsFromByKind(byKind: PaletteSearchResult['byKind']): PaletteWorkspaceItem[] {
  return Object.values(byKind ?? {})
    .filter((bucket): bucket is PaletteSearchHit[] => Array.isArray(bucket))
    .flat()
    .map((hit) => ({
      type: 'workspace' as const,
      nodeId: hit.node_id,
      nodeType: hit.kind,
      title: String(hit.payload.title ?? hit.payload.name ?? hit.node_id),
      subtitle: paletteHitContext(hit),
      icon: typeof hit.payload.icon === 'string' ? hit.payload.icon : null,
      score: hit.score,
      archived: Boolean(hit.payload.archived),
    }));
}

export const paletteSearchApi = {
  async search(request: PaletteSearchRequest): Promise<PaletteAugmentedResponse> {
    // fetchData unwraps the {success, data} envelope — fetchJson here would
    // hand back the raw envelope and every field read below would be
    // undefined (server results silently empty).
    const response = await fetchData<
      PaletteSearchResult & {
        filesystem?: PaletteFilesystemItem[];
        files?: PaletteFileNodeItem[];
        entries?: PaletteEntryHit[];
      }
    >(getApiUrl('/search/palette'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({
        query: request.query,
        kinds: normalizeKinds(request.kinds),
        mode: request.mode ?? 'hybrid',
        limit: request.limit,
        perKindLimit: request.perKindLimit,
        projectId: request.projectId,
        containerId: request.containerId,
        threadId: request.threadId,
        activeNodeId: request.activeNodeId,
        clientDebounceMs: request.clientDebounceMs,
        ...(request.includeEntries ? { includeEntries: true } : {}),
      }),
    });

    const byKind = withoutBuiltinTables(response.byKind);
    const workspaceItems = workspaceItemsFromByKind(byKind);
    const filesystemItems = response.filesystem ?? [];
    // The server's file-node hits omit the `type` discriminant that
    // PaletteFileNodeItem declares. Attach it here so downstream
    // `file.type === 'file-node'` checks (CommandPalette + tree onOpenFile)
    // route file-node items to the by-id preview, not the filesystem branch —
    // otherwise selecting a `file:` result opened an empty "not found" pane.
    const asFileNode = (file: PaletteFileNodeItem): PaletteFileNodeItem => ({
      ...file,
      type: 'file-node' as const,
    });
    const fileItems = (response.files ?? []).map(asFileNode);

    return {
      ...response,
      byKind,
      filesystem: filesystemItems,
      files: fileItems,
      entries: response.entries ?? [],
      items: [...workspaceItems, ...filesystemItems],
      meta: {
        query: request.query,
        kinds: normalizeKinds(request.kinds),
        workspaceCount: workspaceItems.length,
        filesystemCount: filesystemItems.length,
      },
    };
  },
  async resolveFilePath(path: string): Promise<PaletteFileNodeItem | null> {
    const response = await fetchData<{ file: PaletteFileNodeItem | null }>(
      getApiUrl('/search/palette/resolve-file-path'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }
    );
    return response.file;
  },
};
