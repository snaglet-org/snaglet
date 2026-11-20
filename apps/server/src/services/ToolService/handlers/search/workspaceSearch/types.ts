import { WORKSPACE_NODE_KINDS } from '@server/services/ToolService/lib/workspaceScope';
import type { ContainerCategory } from '@snaglet/shared/constants';

export type SearchChannel = 'fts' | 'vector' | 'graph' | 'fuzzy' | 'structured';

export interface DocHit {
  kind: 'doc';
  id: string;
  title: string;
  updatedAt: string;
  rank: number;
  snippet: string;
  score?: number;
  channels?: SearchChannel[];
}
export interface FileHit {
  kind: 'file';
  id: string;
  /** Project-relative on-disk path; doubles as the display label. */
  relativePath: string;
  projectId: string;
  sizeBytes: number;
  updatedAt: string;
  score?: number;
  /** FTS rank (lexical channel only). */
  rank?: number;
  /** Path snippet with FTS highlights (lexical channel only). */
  snippet?: string;
  channels?: SearchChannel[];
  /**
   * Winning-chunk offsets (vector channel only). When a file is matched via a
   * specific embedded chunk, these carry that chunk's byte offsets so callers
   * can surface the matched line range ("grep-with-semantics") rather than just
   * the containing file. Null/undefined for FTS-only or older unchunked hits.
   */
  chunkIndex?: number | null;
  chunkStart?: number | null;
  chunkEnd?: number | null;
  /**
   * Every project path referencing this hit's content (embeddings are
   * content-addressed in file_embeddings). Length > 1 means the same bytes are linked by
   * multiple projects/paths; `relativePath`/`projectId` above mirror the
   * primary (first) entry. Populated on the semantic channel.
   */
  paths?: Array<{ projectId: string; relativePath: string }>;
}
export interface ThreadHit {
  kind: 'thread';
  id: string;
  title: string;
  updatedAt: string;
}
export interface ContainerHit {
  kind: 'container';
  id: string;
  name: string;
  category: ContainerCategory | null;
  updatedAt: string;
  path: string;
  channels?: SearchChannel[];
}
export interface MessageHit {
  kind: 'message';
  id: string;
  threadId: string;
  threadTitle: string;
  sender: string;
  sentAt: string;
  updatedAt: string;
  snippet: string;
  score?: number;
  channels?: SearchChannel[];
}
export interface MemoryHit {
  kind: 'memory';
  id: string;
  key: string | null;
  content: string | null;
  agentId: string | null;
  sourceThreadId: string | null;
  updatedAt: string;
  /** Weighted FTS relevance from the stored vector (lexical channel only). */
  rank?: number;
}
export interface ThreadSummaryHit {
  kind: 'thread_summary';
  id: string;
  threadId: string;
  threadTitle: string;
  agentId: string | null;
  summaryText: string | null;
  updatedAt: string;
  /** Weighted FTS relevance from the stored vector (lexical channel only). */
  rank?: number;
}
export interface ToolHit {
  kind: 'tool';
  id: string;
  name: string;
  description: string | null;
  categoryPath: string;
  tier: string;
  enabled: boolean;
  updatedAt: string;
  /** Weighted FTS relevance from the stored vector (lexical channel only). */
  rank?: number;
}
export interface ImageHit {
  kind: 'image';
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  mimeType: string;
  sizeBytes: number;
  containerId: string | null;
  updatedAt: string;
}
export type SearchHit =
  | DocHit
  | FileHit
  | ThreadHit
  | ContainerHit
  | MessageHit
  | MemoryHit
  | ThreadSummaryHit
  | ToolHit
  | ImageHit;

export const MESSAGES_PER_THREAD = 10;
export type SearchMode = 'hybrid' | 'semantic' | 'keyword';
export const SEARCH_MODES = new Set<SearchMode>(['hybrid', 'semantic', 'keyword']);
export type DetailLevel = 'compact' | 'preview' | 'full';
export const DETAIL_LEVELS = new Set<DetailLevel>(['compact', 'preview', 'full']);
export type SemanticSearchKind = 'doc' | 'message' | 'memory' | 'thread_summary' | 'file';
/**
 * Capability set: every kind the semantic pipeline can score, including `file`.
 * Backs `isSemanticSearchKind` (validity) and the graph channel, so an explicit
 * `kinds: ['file']` with `mode: 'hybrid'` still runs end-to-end. This is not the
 * default set: files are absent from the defaults below because they flood the
 * shared pool (~70% of the corpus). Files surface only via an explicit
 * `kinds: ['file']` or the code-ish file lane (see tool.ts).
 * Workspace threads and containers remain keyword/fuzzy/navigation kinds;
 * neither advertises a semantic lane. Per-agent `thread_summary` nodes retain
 * their own content-bearing semantic surface.
 */
export const SEMANTIC_SEARCH_KINDS = new Set<SemanticSearchKind>([
  'doc',
  'message',
  'memory',
  'thread_summary',
  'file',
]);
/**
 * Structural fuzzy kinds: the name/title/path-bearing kinds the `fuzzy` mode
 * matches with pg_trgm trigram similarity (VS Code Cmd+P "Go to File" model).
 * Every kind here exposes a human name column the trigram indexes cover, or a
 * small enough table to scan: doc titles, container + tool +
 * image names, thread titles, memory keys, and file paths.
 * `message` and `thread_summary` are absent on purpose: they are content with
 * no title/name to fuzzy-match, so fuzzy mode never touches them.
 */
export const FUZZY_SEARCH_KINDS = new Set<SearchableKind>([
  'doc',
  'container',
  'thread',
  'memory',
  'tool',
  'image',
  'file',
]);

/**
 * DEFAULT semantic kinds when a caller passes `mode: 'semantic'|'hybrid'` with no
 * explicit `kinds`. `file` is intentionally absent — see SEMANTIC_SEARCH_KINDS.
 * Structural thread/container lookup remains available through keyword and
 * fuzzy search over authored titles/names.
 */
export const DEFAULT_SEMANTIC_SEARCH_KINDS: readonly SemanticSearchKind[] = [
  'doc',
  'message',
  'memory',
  'thread_summary',
];
/**
 * DEFAULT kinds searched when a caller passes no `kinds`. `file` is intentionally
 * absent (files leave the shared pool; the code-ish file lane in tool.ts surfaces
 * them). SEARCHABLE_KINDS below re-adds `file` so `kinds: ['file']` stays valid.
 */
export const DEFAULT_SEARCH_KINDS = [
  ...WORKSPACE_NODE_KINDS,
  'message',
  'memory',
  'thread_summary',
  'tool',
  'image',
] as const;
/**
 * All kinds a caller MAY explicitly request via `kinds: [...]`. Superset of the
 * defaults by exactly `file`: files are never in the default pool but remain
 * fully searchable on explicit request (semantic + lexical + hydration).
 */
export const SEARCHABLE_KINDS = [...DEFAULT_SEARCH_KINDS, 'file'] as const;
export type SearchableKind = (typeof SEARCHABLE_KINDS)[number];

export type SemanticRankedHit = {
  id: string;
  kind: SemanticSearchKind;
  score: number;
  channels: SearchChannel[];
  /**
   * Winning-chunk offsets from the vector channel, carried through ranking so
   * hydration can surface the matched chunk's line range on file hits.
   * Undefined for FTS/graph-only hits and older unchunked rows.
   */
  chunkIndex?: number | null;
  chunkStart?: number | null;
  chunkEnd?: number | null;
};
