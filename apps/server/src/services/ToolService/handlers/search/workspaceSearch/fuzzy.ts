import { visibleThreadRowSql } from '@snaglet/db/tables/threads/visibility';
/**
 * fuzzy — structural title/path fallback for keyword workspace search.
 *
 * The VS Code Cmd+P "Go to File" mental model: "I roughly know what this thing
 * is called." It matches only the human name/title/path columns of workspace
 * nodes with pg_trgm trigram similarity (+ a substring ILIKE catch), gated by
 * the index-served `%` / `<%` operators from the pg_trgm indexes. Deterministic,
 * DB-side, and instant: no embedding, FTS/tsvector, vector, rerank or quality
 * floor. Ranks purely by trigram similarity desc.
 *
 * Reuses the trigram scoring convention (trigramGateSql / trigramScoreSql) from
 * the existing fuzzy-title channel so the operators live in one place, and
 * produces the same SearchHit shapes the keyword/semantic modes return so the
 * UI/agent consume fuzzy results identically.
 *
 * Kinds are honored exactly like the lexical channel: only the requested,
 * fuzzy-capable kinds are queried (FUZZY_SEARCH_KINDS — every name-bearing kind;
 * `message`/`thread_summary` have no title and are never touched). Container
 * scope (`allowedContainerIds`; a thread matches through its project) and
 * file project scope mirror the lexical channel branch-for-branch.
 */

import { getDb } from '@snaglet/db';
import { Containers } from '@snaglet/db/tables/containers';
import { trigramGateSql, trigramScoreSql } from '@server/services/search/ftsSearchNodes';
import { formatSnippet } from './formatters';
import { buildContainerPathResolver } from './helpers';
import { memoryScopeParams, memoryScopeSql, type MemorySearchScope } from './memoryScope';
import { FUZZY_SEARCH_KINDS } from './types';
import type {
  ContainerHit,
  DocHit,
  FileHit,
  ImageHit,
  MemoryHit,
  SearchHit,
  SearchableKind,
  ThreadHit,
  ToolHit,
} from './types';

type ContainerRows = Awaited<ReturnType<typeof Containers.listAllOrdered>>;

const FUZZY_LIMIT_PARAM = 4;

/**
 * Per-kind trigram gate + order fragment. `col` is the name/title/path column;
 * `$1` is the raw query (trigram operands), `$3` a `%query%` ILIKE pattern so an
 * exact substring always surfaces even below the trigram threshold.
 */
function fuzzyMatchSql(col: string): { gate: string; score: string } {
  return {
    gate: `(${trigramGateSql(col, '$1')} OR ${col} ILIKE $3)`,
    score: trigramScoreSql(col, '$1'),
  };
}

export async function searchFuzzyWorkspace(args: {
  query: string;
  kinds: Set<SearchableKind>;
  limit: number;
  allowedContainerIds: string[] | null;
  containerRowsCache: ContainerRows | null;
  // Project-scope filter for file-kind hits (mirrors the lexical channel). null
  // => workspace-wide file search (no project scoping).
  fileProjectId?: string | null;
  // Path-prefix LIKE pattern narrowing file hits to a satellite subtree. null =>
  // the owner's whole tree.
  filePathPrefix?: string | null;
  // Archived nodes are EXCLUDED from every branch unless explicitly requested.
  includeArchived?: boolean;
  // Whose memories may come back (memoryScope.ts). None: no memory matches.
  memoryScope?: MemorySearchScope | null;
}): Promise<{ hits: SearchHit[]; threadIds: string[] }> {
  const { query, kinds, limit, allowedContainerIds } = args;
  if (!query.trim()) return { hits: [], threadIds: [] };
  const fileProjectId = args.fileProjectId ?? null;
  const filePathPrefix = args.filePathPrefix ?? null;
  let containerRowsCache = args.containerRowsCache;
  const archivedFilter = args.includeArchived ? '' : 'AND n.archived = false';

  const doc = fuzzyMatchSql('d.title');
  const docSql = `
    SELECT d.id, d.title, n.updated_at, ${doc.score} AS score
    FROM public.docs d
    JOIN public.nodes n ON n.id = d.id
    WHERE ${doc.gate}
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
      ${archivedFilter}
    ORDER BY score DESC, d.id ASC
    LIMIT $${FUZZY_LIMIT_PARAM}
  `;

  const thread = fuzzyMatchSql("COALESCE(t.title, '')");
  const threadSql = `
    SELECT t.id, COALESCE(t.title, '(untitled thread)') AS title,
           COALESCE(t.last_message_at, n.updated_at, t.created_at) AS updated_at,
           ${thread.score} AS score
    FROM public.threads t
    JOIN public.nodes n ON n.id = t.id
    WHERE ${thread.gate}
      AND ${visibleThreadRowSql('t')}
      AND ($2::text[] IS NULL OR n.project_id = ANY($2::text[]))
      ${archivedFilter}
    ORDER BY score DESC, t.id ASC
    LIMIT $${FUZZY_LIMIT_PARAM}
  `;

  const container = fuzzyMatchSql('c.name');
  const containerSql = `
    SELECT c.id, c.name, n.container_id AS parent_id, n.updated_at, ${container.score} AS score
    FROM public.containers c
    JOIN public.nodes n ON n.id = c.id
    WHERE ${container.gate}
      AND ($2::text[] IS NULL OR c.id = ANY($2::text[]))
      ${archivedFilter}
    ORDER BY score DESC, c.id ASC
    LIMIT $${FUZZY_LIMIT_PARAM}
  `;

  const memory = fuzzyMatchSql("COALESCE(mem.memory_key, '')");
  const memorySql = `
    SELECT mem.id, mem.memory_key, mem.content, mem.agent_id, mem.source_thread_id,
           n.updated_at, ${memory.score} AS score
    FROM public.memories mem
    JOIN public.nodes n ON n.id = mem.id
    WHERE ${memory.gate}
      AND ${memoryScopeSql('mem', FUZZY_LIMIT_PARAM, FUZZY_LIMIT_PARAM + 1)}
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
      ${archivedFilter}
    ORDER BY score DESC, mem.id ASC
    LIMIT $${FUZZY_LIMIT_PARAM + 2}
  `;

  // Tools aren't container-scoped (mirrors the lexical channel's `$2 IS NULL OR
  // TRUE`); the caller applies per-agent access control on the returned hits.
  const tool = fuzzyMatchSql('t.name');
  const toolSql = `
    SELECT t.id, t.name, t.description, t.category_path, t.tier, t.enabled,
           t.updated_at, ${tool.score} AS score
    FROM public.tools t
    WHERE ${tool.gate}
      AND ($2::text[] IS NULL OR TRUE)
    ORDER BY score DESC, t.id ASC
    LIMIT $${FUZZY_LIMIT_PARAM}
  `;

  const image = fuzzyMatchSql("COALESCE(i.alt_text, '')");
  const imageSql = `
    SELECT i.id, i.alt_text, i.description, i.tags, i.metadata,
           n.container_id, n.updated_at, ${image.score} AS score
    FROM public.images i
    JOIN public.nodes n ON n.id = i.id
    WHERE ${image.gate}
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
      ${archivedFilter}
    ORDER BY score DESC, i.id ASC
    LIMIT $${FUZZY_LIMIT_PARAM}
  `;

  // The file relative_path IS the "container path" surface — this is exactly the
  // Cmd+P path-matching case. Project + subtree scope mirror the lexical channel.
  const file = fuzzyMatchSql('f.relative_path');
  const fileSql = `
    SELECT f.id, f.relative_path, f.project_id, f.size_bytes, n.updated_at, ${file.score} AS score
    FROM public.files f
    JOIN public.nodes n ON n.id = f.id
    WHERE ${file.gate}
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
      ${archivedFilter}
      AND ($5::text IS NULL OR f.project_id = $5::text)
      AND ($6::text IS NULL OR f.relative_path LIKE $6::text)
    ORDER BY score DESC, f.id ASC
    LIMIT $${FUZZY_LIMIT_PARAM}
  `;

  const ilikePattern = `%${query}%`;
  const pool = getDb();
  // Common param tuple for the container-scoped branches: [query, scope, ilike, limit].
  const baseParams = [query, allowedContainerIds, ilikePattern, limit];

  type DocRaw = { id: string; title: string; updated_at: string; score: number };
  type ThreadRaw = { id: string; title: string; updated_at: string; score: number };
  type ContainerRaw = {
    id: string;
    name: string;
    parent_id: string | null;
    updated_at: string;
    score: number;
  };
  type MemoryRaw = {
    id: string;
    memory_key: string | null;
    content: string | null;
    agent_id: string | null;
    source_thread_id: string | null;
    updated_at: string;
    score: number;
  };
  type ToolRaw = {
    id: string;
    name: string;
    description: string | null;
    category_path: string;
    tier: string;
    enabled: boolean;
    updated_at: string;
    score: number;
  };
  type ImageRaw = {
    id: string;
    alt_text: string | null;
    description: string | null;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
    container_id: string | null;
    updated_at: string;
    score: number;
  };
  type FileRaw = {
    id: string;
    relative_path: string | null;
    project_id: string | null;
    size_bytes: number | null;
    updated_at: string;
    score: number;
  };
  const wants = (kind: SearchableKind): boolean => kinds.has(kind) && FUZZY_SEARCH_KINDS.has(kind);

  const [docRes, threadRes, containerRes, memoryRes, toolRes, imageRes, fileRes] =
    await Promise.all([
      wants('doc')
        ? pool.query<DocRaw>(docSql, baseParams)
        : Promise.resolve({ rows: [] as DocRaw[] }),
      wants('thread')
        ? pool.query<ThreadRaw>(threadSql, baseParams)
        : Promise.resolve({ rows: [] as ThreadRaw[] }),
      wants('container')
        ? pool.query<ContainerRaw>(containerSql, baseParams)
        : Promise.resolve({ rows: [] as ContainerRaw[] }),
      wants('memory')
        ? pool.query<MemoryRaw>(memorySql, [
            ...baseParams.slice(0, -1),
            ...memoryScopeParams(args.memoryScope),
            limit,
          ])
        : Promise.resolve({ rows: [] as MemoryRaw[] }),
      wants('tool')
        ? pool.query<ToolRaw>(toolSql, baseParams)
        : Promise.resolve({ rows: [] as ToolRaw[] }),
      wants('image')
        ? pool.query<ImageRaw>(imageSql, baseParams)
        : Promise.resolve({ rows: [] as ImageRaw[] }),
      wants('file')
        ? pool.query<FileRaw>(fileSql, [...baseParams, fileProjectId, filePathPrefix])
        : Promise.resolve({ rows: [] as FileRaw[] }),
    ]);

  const hits: SearchHit[] = [
    ...docRes.rows.map<DocHit>((r) => ({
      kind: 'doc',
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      rank: r.score,
      snippet: formatSnippet(null),
      channels: ['fuzzy'],
    })),
    ...threadRes.rows.map<ThreadHit>((r) => ({
      kind: 'thread',
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
    })),
    ...memoryRes.rows.map<MemoryHit>((r) => ({
      kind: 'memory',
      id: r.id,
      key: r.memory_key,
      content: r.content,
      agentId: r.agent_id,
      sourceThreadId: r.source_thread_id,
      updatedAt: r.updated_at,
    })),
    ...toolRes.rows.map<ToolHit>((r) => ({
      kind: 'tool',
      id: r.id,
      name: r.name,
      description: r.description,
      categoryPath: r.category_path,
      tier: r.tier,
      enabled: r.enabled,
      updatedAt: r.updated_at,
    })),
    ...imageRes.rows.map<ImageHit>((r) => {
      const meta = r.metadata ?? {};
      return {
        kind: 'image',
        id: r.id,
        name: r.alt_text ?? '',
        description: r.description,
        tags: r.tags ?? [],
        mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
        sizeBytes: typeof meta.sizeBytes === 'number' ? meta.sizeBytes : 0,
        containerId: r.container_id,
        updatedAt: r.updated_at,
      };
    }),
    ...fileRes.rows.map<FileHit>((r) => ({
      kind: 'file',
      id: r.id,
      relativePath: r.relative_path ?? '',
      projectId: r.project_id ?? '',
      sizeBytes: r.size_bytes ?? 0,
      updatedAt: r.updated_at,
      score: r.score,
      channels: ['fuzzy'],
    })),
  ];

  // Container paths need the full row set to walk parents — lazy-load once.
  if (containerRes.rows.length > 0) {
    if (!containerRowsCache) containerRowsCache = await Containers.listAllOrdered();
    const { byId, pathOf } = buildContainerPathResolver(containerRowsCache);
    for (const r of containerRes.rows) {
      hits.push({
        kind: 'container',
        id: r.id,
        name: r.name,
        category: byId.get(r.id)?.category ?? null,
        updatedAt: r.updated_at,
        path: pathOf(r.id),
      } satisfies ContainerHit);
    }
  }

  return { hits, threadIds: threadRes.rows.map((thread) => thread.id) };
}
