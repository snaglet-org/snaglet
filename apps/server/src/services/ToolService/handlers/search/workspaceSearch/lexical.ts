import { getDb } from '@snaglet/db';
import { visibleThreadRowSql } from '@snaglet/db/tables/threads/visibility';
import { Containers } from '@snaglet/db/tables/containers';
import {
  timeRangeBoostSql,
  timeRangeFilterSql,
  timeRangeParams,
  type NormalizedSearchTimeRange,
} from '@server/services/search/timeRange';
import type { StructuredSearchOrder } from '@server/services/search/searchPolicy';
import { filePathTsQuery, rankCd, toolTsQuery } from '@server/services/search/lexicalQuery';
import { formatSnippet } from './formatters';
import { buildContainerPathResolver } from './helpers';
import { memoryScopeParams, memoryScopeSql, type MemorySearchScope } from './memoryScope';
import type {
  ContainerHit,
  DocHit,
  FileHit,
  ImageHit,
  MemoryHit,
  MessageHit,
  SearchHit,
  SearchableKind,
  ThreadHit,
  ThreadSummaryHit,
  ToolHit,
} from './types';

type ContainerRows = Awaited<ReturnType<typeof Containers.listAllOrdered>>;

const LEXICAL_TIME_FROM_PARAM = 3;
const LEXICAL_TIME_TO_PARAM = 4;
const LEXICAL_LIMIT_PARAM = 5;

function lexicalTimeFilter(
  expression: string,
  timeRange: NormalizedSearchTimeRange | null
): string {
  return timeRangeFilterSql(expression, timeRange, LEXICAL_TIME_FROM_PARAM, LEXICAL_TIME_TO_PARAM);
}

function lexicalTimeBoost(expression: string, timeRange: NormalizedSearchTimeRange | null): string {
  const boost = timeRangeBoostSql(
    expression,
    timeRange,
    LEXICAL_TIME_FROM_PARAM,
    LEXICAL_TIME_TO_PARAM
  );
  // No active boost range => timeRangeBoostSql returns a no-op constant.
  // The current shape is `(1.0)`, but normalize by stripping any wrapping
  // parens/whitespace so we catch `1.0`, `(1.0)`, `( 1.0 )`, etc. As a
  // multiplier the constant is harmless, but Postgres rejects a non-integer
  // constant in ORDER BY position ('non-integer constant in ORDER BY').
  // Wrap it in a per-row CASE so the value stays 1.0 but is never a bare
  // constant, making it safe in every ORDER BY across all kind queries.
  const normalized = boost.trim().replace(/^\(+\s*|\s*\)+$/g, '');
  if (normalized === '1.0') {
    return `(CASE WHEN ${expression} IS NULL THEN 1.0 ELSE 1.0 END)`;
  }
  return boost;
}

export async function searchLexicalWorkspace(args: {
  query: string;
  kinds: Set<SearchableKind>;
  limit: number;
  allowedContainerIds: string[] | null;
  containerRowsCache: ContainerRows | null;
  timeRange: NormalizedSearchTimeRange | null;
  orderBy?: StructuredSearchOrder;
  // Project-scope filter for file-kind hits (mirrors the semantic channel's
  // $8 file filter). null => workspace-wide file search (no project scoping).
  fileProjectId?: string | null;
  // Path-prefix LIKE pattern narrowing file hits to a satellite project's
  // subtree of the owner index (mirrors the semantic channel's $9). null => none.
  filePathPrefix?: string | null;
  // Archived policy: archived nodes are EXCLUDED from every branch unless the
  // caller explicitly opts in (workspace_search include_archived) — archived
  // content must never compete with living content by default.
  includeArchived?: boolean;
  // Historical versions are hidden from ordinary retrieval. An explicit
  // kinds:['thread_summary'] request may opt in; exact-id/history APIs bypass
  // this search path entirely.
  includeSupersededThreadSummaries?: boolean;
  // Whose memories may come back (memoryScope.ts). None: no memory matches.
  memoryScope?: MemorySearchScope | null;
}): Promise<{ hits: SearchHit[]; threadIds: string[] }> {
  const { query, kinds, limit, allowedContainerIds, timeRange } = args;
  const fileProjectId = args.fileProjectId ?? null;
  const filePathPrefix = args.filePathPrefix ?? null;
  let containerRowsCache = args.containerRowsCache;
  const archivedFilter = args.includeArchived ? '' : 'AND n.archived = false';
  // Messages/summaries also exclude items whose PARENT THREAD is archived.
  const messageArchivedFilter = args.includeArchived
    ? ''
    : 'AND mn.archived = false AND tn.archived = false';
  const summaryArchivedFilter = args.includeArchived
    ? ''
    : 'AND n.archived = false AND tn.archived = false';
  const threadSummaryCurrentFilter = args.includeSupersededThreadSummaries
    ? ''
    : 'AND ts.is_current = true';

  // - 'english' config matches the docs_update_search_text trigger so
  //   stemming/stopwords behave consistently between write and read.
  // - websearch_to_tsquery accepts user-friendly operators (AND-default,
  //   "quoted phrases", OR, -negation) and won't throw on messy input.
  // - regexp_replace strips wiki-link markdown so embedded `[Foo](doc-…)`
  //   chips don't pollute snippets with ID gibberish when the query
  //   collides with id substrings.
  const docTimeExpression = timeRange?.field === 'created_at' ? 'd.created_at' : 'n.updated_at';
  const containerTimeExpression =
    timeRange?.field === 'created_at' ? 'c.created_at' : 'n.updated_at';
  const messageTimeExpression =
    timeRange?.field === 'updated_at' ? 'mn.updated_at' : 'm.created_at';
  const threadTimeExpression =
    timeRange?.field === 'created_at'
      ? 't.created_at'
      : timeRange?.field === 'updated_at'
        ? 'n.updated_at'
        : 'COALESCE(t.last_message_at, n.updated_at, t.created_at)';
  const memoryTimeExpression = timeRange?.field === 'created_at' ? 'm.created_at' : 'n.updated_at';
  const imageTimeExpression = timeRange?.field === 'created_at' ? 'n.created_at' : 'n.updated_at';
  const threadSummaryTimeExpression =
    timeRange?.field === 'created_at' ? 'ts.created_at' : 'n.updated_at';
  const toolTimeExpression = timeRange?.field === 'created_at' ? 't.created_at' : 't.updated_at';
  const fileTimeExpression = timeRange?.field === 'created_at' ? 'n.created_at' : 'n.updated_at';
  const lexicalOrder = (timeExpression: string, relevance: string, id: string): string => {
    if (args.orderBy === 'created_desc' || args.orderBy === 'updated_desc') {
      return `${timeExpression} DESC NULLS LAST, ${relevance} DESC, ${id} ASC`;
    }
    return `${relevance} DESC, ${id} ASC`;
  };

  const docSql = `
    SELECT d.id, d.title, n.updated_at,
           (ts_rank(d.search_text, q) * ${lexicalTimeBoost(docTimeExpression, timeRange)}) AS rank,
           ts_headline(
             'english',
             regexp_replace(d.content, '\\[([^\\]]+)\\]\\([^)]+\\)', '\\1', 'g'),
             q,
             'StartSel="**", StopSel="**", MaxFragments=2, FragmentDelimiter=" … ", MinWords=8, MaxWords=24, HighlightAll=FALSE'
           ) AS snippet
    FROM public.docs d
    JOIN public.nodes n ON n.id = d.id,
         websearch_to_tsquery('english', $1) q
    WHERE d.search_text @@ q
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
      ${archivedFilter}
      ${lexicalTimeFilter(docTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(docTimeExpression, 'rank', 'd.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  // A thread is in a container scope when its project (nodes.project_id) is
  // the scope container or nested in it; threads are not in the folder tree.
  // Messages and summaries below follow their thread the same way. Subagent
  // helper threads, and everything in them, are never search results — with
  // or without include_archived.
  const threadSql = `
    SELECT t.id, COALESCE(t.title, '(untitled thread)') AS title,
           COALESCE(t.last_message_at, n.updated_at, t.created_at) AS updated_at
    FROM public.threads t
    JOIN public.nodes n ON n.id = t.id
    WHERE COALESCE(t.title, '') ILIKE $1
      AND ${visibleThreadRowSql('t')}
      AND ($2::text[] IS NULL OR n.project_id = ANY($2::text[]))
      ${archivedFilter}
      ${lexicalTimeFilter(threadTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(threadTimeExpression, lexicalTimeBoost(threadTimeExpression, timeRange), 't.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  // A container's parent is read from nodes.container_id, its single source of truth.
  const containerSql = `
    SELECT c.id, c.name, n.container_id AS parent_id, n.updated_at
    FROM public.containers c
    JOIN public.nodes n ON n.id = c.id
    WHERE c.name ILIKE $1
      AND ($2::text[] IS NULL OR c.id = ANY($2::text[]))
      ${archivedFilter}
      ${lexicalTimeFilter(containerTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(containerTimeExpression, lexicalTimeBoost(containerTimeExpression, timeRange), 'c.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  const messageSql = `
    WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
    SELECT m.id,
           m.thread_id,
           COALESCE(t.title, '(untitled thread)') AS thread_title,
           m.role,
           m.agent_id,
           a.name AS agent_name,
           m.user_id,
           u.name AS user_name,
           m.created_at,
           (ts_rank(m.search_text, q.tsq) * ${lexicalTimeBoost(messageTimeExpression, timeRange)}) AS rank,
           ts_headline(
             'english',
             m.content,
             q.tsq,
             'StartSel="**", StopSel="**", MaxFragments=2, FragmentDelimiter=" … ", MinWords=8, MaxWords=24, HighlightAll=FALSE'
           ) AS snippet
    FROM public.messages m
    JOIN public.nodes mn ON mn.id = m.id
    JOIN public.threads t ON t.id = m.thread_id
    JOIN public.nodes tn ON tn.id = m.thread_id
    LEFT JOIN public.agents a ON a.id = m.agent_id
    LEFT JOIN public.users u ON u.id = m.user_id
    CROSS JOIN q
    WHERE m.search_text @@ q.tsq
      AND ${visibleThreadRowSql('t')}
      AND ($2::text[] IS NULL OR mn.container_id = ANY($2::text[]) OR tn.project_id = ANY($2::text[]))
      ${messageArchivedFilter}
      ${lexicalTimeFilter(messageTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(messageTimeExpression, 'rank', 'm.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  const memorySql = `
    WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
    SELECT m.id, m.memory_key, m.content, m.agent_id, m.source_thread_id, n.updated_at,
           (${rankCd('m.search_text', 'q.tsq')} * ${lexicalTimeBoost(memoryTimeExpression, timeRange)}) AS rank
    FROM public.memories m
    JOIN public.nodes n ON n.id = m.id
    CROSS JOIN q
    WHERE m.search_text @@ q.tsq
      AND ${memoryScopeSql('m', LEXICAL_LIMIT_PARAM, LEXICAL_LIMIT_PARAM + 1)}
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
      ${archivedFilter}
      ${lexicalTimeFilter(memoryTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(memoryTimeExpression, 'rank', 'm.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM + 2}
  `;

  const threadSummarySql = `
    WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
    SELECT ts.id,
           ts.thread_id,
           COALESCE(t.title, '(untitled thread)') AS thread_title,
           ts.agent_id,
           ts.summary_text,
           n.updated_at,
           (${rankCd('ts.search_text', 'q.tsq')} * ${lexicalTimeBoost(threadSummaryTimeExpression, timeRange)}) AS rank
    FROM public.thread_summaries ts
    JOIN public.nodes n ON n.id = ts.id
    JOIN public.threads t ON t.id = ts.thread_id
    JOIN public.nodes tn ON tn.id = ts.thread_id
    CROSS JOIN q
    WHERE ts.search_text @@ q.tsq
      AND ${visibleThreadRowSql('t')}
      ${threadSummaryCurrentFilter}
      ${summaryArchivedFilter}
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]) OR tn.project_id = ANY($2::text[]))
      ${lexicalTimeFilter(threadSummaryTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(threadSummaryTimeExpression, 'rank', 'ts.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  // Tools query both configurations: identity/aliases/keywords are stored
  // `simple`, the description `english`. One canonical expression serves this
  // lane and node search, so the same query ranks tools identically in both.
  const toolSql = `
    WITH q AS (SELECT ${toolTsQuery('$1')} AS tsq)
    SELECT t.id, t.name, t.description, t.category_path, t.tier, t.enabled, t.updated_at,
           (${rankCd('t.search_text', 'q.tsq')} * ${lexicalTimeBoost(toolTimeExpression, timeRange)}) AS rank
    FROM public.tools t
    CROSS JOIN q
    WHERE t.search_text @@ q.tsq
      AND ($2::text[] IS NULL OR TRUE)
      ${lexicalTimeFilter(toolTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(toolTimeExpression, 'rank', 't.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  // Images have no FTS column — match against alt_text + description (ILIKE)
  // and tags (array_to_string ILIKE catches partial tag matches like
  // "graph" hitting `["bar-graph", "chart"]`). Cheap, mirrors the
  // palette-search query shape for the same kind.
  const imageSql = `
    SELECT i.id,
           i.alt_text,
           i.description,
           i.tags,
           i.metadata,
           n.container_id,
           n.updated_at
      FROM public.images i
      JOIN public.nodes n ON n.id = i.id
     WHERE TRUE
       ${archivedFilter}
       AND (
         COALESCE(i.alt_text, '') ILIKE $1
         OR COALESCE(i.description, '') ILIKE $1
         OR COALESCE(array_to_string(i.tags, ' '), '') ILIKE $1
       )
       AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
       ${lexicalTimeFilter(imageTimeExpression, timeRange)}
     ORDER BY ${lexicalOrder(imageTimeExpression, lexicalTimeBoost(imageTimeExpression, timeRange), 'i.id')}
     LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  // FTS over file relative_path. File bodies live on disk (not in the DB), so the
  // path is the indexable signal here — which is exactly what makes literal
  // symbol/path lookup work (e.g. "reorderChildren", "WorkspaceTree/reorder.ts").
  // Container-scoped like docs via the $2 filter.
  // Paths are indexed and queried under `simple`, both verbatim and with
  // separators split into segments — the parser reads `src/index.ts` as a
  // single token, so without the split arm a search for `index.ts` could never
  // match its own file. `english` would stem path segments, which is wrong for
  // identifiers.
  const fileSql = `
    WITH q AS (SELECT ${filePathTsQuery('$1')} AS tsq)
    SELECT f.id,
           f.relative_path,
           f.project_id,
           f.size_bytes,
           n.updated_at,
           (${rankCd('f.search_text', 'q.tsq')} * ${lexicalTimeBoost(fileTimeExpression, timeRange)}) AS rank,
           ts_headline('simple', COALESCE(f.relative_path, ''), q.tsq, 'StartSel=<<,StopSel=>>,MaxFragments=1,MaxWords=12,MinWords=3') AS snippet
    FROM public.files f
    JOIN public.nodes n ON n.id = f.id
    CROSS JOIN q
    WHERE f.search_text @@ q.tsq
      AND ($2::text[] IS NULL OR n.container_id = ANY($2::text[]))
      ${archivedFilter}
      -- Project scoping ($6): mirrors the semantic channel's file filter so
      -- scope_files:'project' is enforced consistently across BOTH channels.
      -- null => workspace-wide (no project constraint).
      AND ($6::text IS NULL OR f.project_id = $6::text)
      -- Subtree scoping ($7) for satellite projects nested in a shared folder.
      -- null => the owner's whole tree.
      AND ($7::text IS NULL OR f.relative_path LIKE $7::text)
      ${lexicalTimeFilter(fileTimeExpression, timeRange)}
    ORDER BY ${lexicalOrder(fileTimeExpression, 'rank', 'f.id')}
    LIMIT $${LEXICAL_LIMIT_PARAM}
  `;

  const ilikePattern = `%${query}%`;
  const pool = getDb();
  const lexicalTimeParams = timeRangeParams(timeRange);

  type DocRaw = { id: string; title: string; updated_at: string; rank: number; snippet: string };
  type ThreadRaw = { id: string; title: string; updated_at: string };
  type ContainerRaw = {
    id: string;
    name: string;
    parent_id: string | null;
    updated_at: string;
  };
  type MessageRaw = {
    id: string;
    thread_id: string;
    thread_title: string;
    role: string;
    agent_id: string | null;
    agent_name: string | null;
    user_id: string | null;
    user_name: string | null;
    created_at: string;
    rank: number;
    snippet: string | null;
  };
  type MemoryRaw = {
    id: string;
    memory_key: string | null;
    content: string | null;
    agent_id: string | null;
    source_thread_id: string | null;
    updated_at: string;
    rank: number;
  };
  type ThreadSummaryRaw = {
    id: string;
    thread_id: string;
    thread_title: string;
    agent_id: string | null;
    summary_text: string | null;
    updated_at: string;
    rank: number;
  };
  type ToolRaw = {
    id: string;
    name: string;
    description: string | null;
    category_path: string;
    tier: string;
    enabled: boolean;
    updated_at: string;
    rank: number;
  };
  type ImageRaw = {
    id: string;
    alt_text: string | null;
    description: string | null;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
    container_id: string | null;
    updated_at: string;
  };
  type FileRaw = {
    id: string;
    relative_path: string | null;
    project_id: string | null;
    size_bytes: number | null;
    updated_at: string;
    rank: number;
    snippet: string | null;
  };
  const [
    docRes,
    threadRes,
    containerRes,
    messageRes,
    memoryRes,
    threadSummaryRes,
    toolRes,
    imageRes,
    fileRes,
  ] = await Promise.all([
    kinds.has('doc')
      ? pool.query<DocRaw>(docSql, [query, allowedContainerIds, ...lexicalTimeParams, limit])
      : Promise.resolve({ rows: [] as DocRaw[] }),
    kinds.has('thread')
      ? pool.query<ThreadRaw>(threadSql, [
          ilikePattern,
          allowedContainerIds,
          ...lexicalTimeParams,
          limit,
        ])
      : Promise.resolve({ rows: [] as ThreadRaw[] }),
    kinds.has('container')
      ? pool.query<ContainerRaw>(containerSql, [
          ilikePattern,
          allowedContainerIds,
          ...lexicalTimeParams,
          limit,
        ])
      : Promise.resolve({ rows: [] as ContainerRaw[] }),
    kinds.has('message')
      ? pool.query<MessageRaw>(messageSql, [
          query,
          allowedContainerIds,
          ...lexicalTimeParams,
          limit,
        ])
      : Promise.resolve({ rows: [] as MessageRaw[] }),
    kinds.has('memory')
      ? pool.query<MemoryRaw>(memorySql, [
          query,
          allowedContainerIds,
          ...lexicalTimeParams,
          ...memoryScopeParams(args.memoryScope),
          limit,
        ])
      : Promise.resolve({ rows: [] as MemoryRaw[] }),
    kinds.has('thread_summary')
      ? pool.query<ThreadSummaryRaw>(threadSummarySql, [
          query,
          allowedContainerIds,
          ...lexicalTimeParams,
          limit,
        ])
      : Promise.resolve({ rows: [] as ThreadSummaryRaw[] }),
    kinds.has('tool')
      ? pool.query<ToolRaw>(toolSql, [query, allowedContainerIds, ...lexicalTimeParams, limit])
      : Promise.resolve({ rows: [] as ToolRaw[] }),
    kinds.has('image')
      ? pool.query<ImageRaw>(imageSql, [
          ilikePattern,
          allowedContainerIds,
          ...lexicalTimeParams,
          limit,
        ])
      : Promise.resolve({ rows: [] as ImageRaw[] }),
    kinds.has('file')
      ? pool.query<FileRaw>(fileSql, [
          query,
          allowedContainerIds,
          ...lexicalTimeParams,
          limit,
          fileProjectId, // $6 — project scope (null => workspace-wide)
          filePathPrefix, // $7 — subtree scope (null => owner's whole tree)
        ])
      : Promise.resolve({ rows: [] as FileRaw[] }),
  ]);

  const hits: SearchHit[] = [
    ...docRes.rows.map<DocHit>((r) => ({
      kind: 'doc',
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      rank: r.rank,
      snippet: formatSnippet(r.snippet),
    })),
    ...threadRes.rows.map<ThreadHit>((r) => ({
      kind: 'thread',
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
    })),
    ...messageRes.rows.map<MessageHit>((r) => {
      const sender =
        r.agent_name ??
        r.user_name ??
        (r.role === 'user' ? (r.user_id == null ? 'user' : `user ${r.user_id}`) : null) ??
        r.agent_id ??
        r.role;
      return {
        kind: 'message',
        id: r.id,
        threadId: r.thread_id,
        threadTitle: r.thread_title,
        sender,
        sentAt: r.created_at,
        updatedAt: r.created_at,
        snippet: formatSnippet(r.snippet),
      };
    }),
    ...memoryRes.rows.map<MemoryHit>((r) => ({
      kind: 'memory',
      id: r.id,
      key: r.memory_key,
      content: r.content,
      agentId: r.agent_id,
      sourceThreadId: r.source_thread_id,
      updatedAt: r.updated_at,
      rank: r.rank,
    })),
    ...threadSummaryRes.rows.map<ThreadSummaryHit>((r) => ({
      kind: 'thread_summary',
      id: r.id,
      threadId: r.thread_id,
      threadTitle: r.thread_title,
      agentId: r.agent_id,
      summaryText: r.summary_text,
      updatedAt: r.updated_at,
      rank: r.rank,
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
      rank: r.rank,
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
      rank: r.rank,
      snippet: r.snippet ?? undefined,
    })),
  ];

  // Container paths need the full row set to walk parents. Lazy-load if we
  // haven't already grabbed them for scope resolution.
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
      });
    }
  }

  return { hits, threadIds: threadRes.rows.map((thread) => thread.id) };
}
