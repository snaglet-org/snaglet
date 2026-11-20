import type { ToolHandler } from '@server/services/ToolService/types';
import { formatHeadingFragment, resolveDocAnchor, splitDocRef } from '@snaglet/shared/utils';
import type { SearchHit } from './types';
import {
  finishCommittedSearch,
  renderHonestEmpty,
  weakMatchesFooter,
  COMMITTED_RERANK_POOL,
} from './committedSearch';
import { RERANK_MAX_CANDIDATES } from './rerankHits';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { Containers } from '@snaglet/db/tables/containers';
import { resolveContainerScope } from '@server/services/ToolService/lib/workspaceScope';
import { resolveCallerProject } from '../findConversation/projectScope';
import type { NodeSearchMode } from '@server/services/search/nodeSearch';
import { pinArchivedFirst, searchWorkspace } from '@server/services/search/core';
import {
  resolveSearchTimeRange,
  type NormalizedSearchTimeRange,
} from '@server/services/search/timeRange';
import { clampLimit } from '@server/utils/pagination';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  buildThreadEnrichment,
  looksLikeSearchId,
  renderResolvedIds,
  renderResults,
} from './formatters';
import { isCodeishQuery } from './codeishQuery';
import { collectDescendants } from './graph';
import { hydrateHybridDocHits, hydrateHybridMessageHits } from './hydration';
import { searchLexicalWorkspace } from './lexical';
import {
  isSemanticSearchKind,
  parseDetail,
  parseGraphDepth,
  parseIds,
  parseSearchKinds,
  parseThreadId,
} from './parsers';
import { searchSemanticWorkspace } from './semantic';
import { searchFuzzyWorkspace } from './fuzzy';
import { resolveMemorySearchScope, type MemorySearchScope } from './memoryScope';
import {
  isRangedContentKind,
  parseContentRange,
  validateRangedQueryLimit,
  MAX_RANGED_RESULTS,
  MAX_RANGE_LINES,
  RANGED_CONTENT_KINDS,
  type ContentRangeRequest,
} from './contentRange';
import { loadDoc, rangedSectionForHits, runRangedRead } from './rangedRead';
import {
  appendFileFallback,
  composeWithFileLane,
  fileFallbackForScope,
  resolveFileProjectId,
  runFileLane,
} from './fileLane';
import { FUZZY_SEARCH_KINDS, SEARCH_MODES, type FileHit, type SearchableKind } from './types';

export { composeWithFileLane } from './fileLane';

/**
 * Bounded rerank/reorder pool for committed semantic searches. A small buffer
 * over `limit` gives the reranker room to promote a relevant item across the
 * final cut (pool-level, not final-10), capped at the reranker's
 * per-call ceiling to hold p50 within budget.
 */
function committedRerankPoolSize(limit: number): number {
  return Math.min(RERANK_MAX_CANDIDATES, Math.max(limit + 6, COMMITTED_RERANK_POOL));
}

/**
 * Per-call plumbing for `content_range`. `collect` receives the hits a QUERY
 * path finally decided to show, so the wrapper below can re-read those exact
 * items at their authoritative source. Exact-id paths never call it — they
 * render their ranged output themselves and return early.
 */
interface RangedRunOptions {
  contentRange: ContentRangeRequest | null;
  collect: (hits: readonly SearchHit[]) => void;
  /**
   * Whose memories this call may return or read by id: the caller's own plus
   * kept facts about its thread's human (memoryScope.ts). Resolved once, on
   * first use.
   */
  memoryScope: () => Promise<MemorySearchScope | null>;
}

async function runWorkspaceSearch(
  input: Record<string, unknown>,
  settings: Record<string, unknown>,
  context: Parameters<ToolHandler>[2],
  ranged: RangedRunOptions
): Promise<string> {
  const rawQuery = typeof input.query === 'string' ? input.query.trim() : '';
  const ids = parseIds([input.id, ...(Array.isArray(input.ids) ? input.ids : [input.ids])]);
  // Node ids to drop from SEARCH results — already in the caller's context
  // (e.g. the message just sent, perceived messages, docs in the system prompt).
  // Does not affect direct id/ids fetches below.
  const excludeIds = new Set(
    parseIds(Array.isArray(input.exclude_ids) ? input.exclude_ids : [input.exclude_ids])
  );
  const detail = parseDetail(input.detail);
  // Part links as ids read just that part: `doc-…#L12-L20` (lines) or
  // `doc-…#h=rate-limits` / `#h3=…` (a heading's section, found by name so it
  // survives edits above it). An explicit content_range wins over a line
  // fragment. Ids without a fragment keep the normal path.
  const anchorOf = (id: string) => splitDocRef(id).anchor;
  if (
    ids.length > 0 &&
    ids.some((id) => {
      const a = anchorOf(id);
      return a !== null && (!ranged.contentRange || 'heading' in a);
    })
  ) {
    const blocks: string[] = [];
    const plain = ids.filter((id) => anchorOf(id) === null);
    for (const id of ids) {
      const { id: bare, anchor } = splitDocRef(id);
      if (!anchor) continue;
      let lines: { startLine: number; endLine: number };
      let note = '';
      if ('lines' in anchor) {
        lines = ranged.contentRange ?? anchor.lines;
      } else {
        const source = await loadDoc(bare);
        if (typeof source === 'string') {
          blocks.push(source);
          continue;
        }
        const resolved = resolveDocAnchor(source.content, anchor);
        if (!resolved.lines) {
          blocks.push(`"${id}": ${resolved.note}`);
          continue;
        }
        lines = resolved.lines;
        note = `Section "${formatHeadingFragment(anchor.heading)}" = lines ${lines.startLine}-${lines.endLine}.${resolved.note ? ` ${resolved.note}` : ''}`;
      }
      const span = lines.endLine - lines.startLine + 1;
      if (span > MAX_RANGE_LINES) {
        blocks.push(
          `"${id}" spans ${span} lines; the most one read returns is ${MAX_RANGE_LINES}. Narrow it with a line link.`
        );
        continue;
      }
      const read = await runRangedRead(
        [bare],
        { startLine: lines.startLine, endLine: lines.endLine },
        settings,
        [],
        await ranged.memoryScope()
      );
      blocks.push(note ? `${note}\n${read}` : read);
    }
    if (plain.length > 0) {
      blocks.push(await renderResolvedIds(plain, detail, await ranged.memoryScope()));
    }
    return blocks.join('\n\n');
  }
  if (ids.length > 0) {
    // The exact-id ranged read: re-read the CURRENT content of each id and
    // return only the requested lines, instead of the detail-level preview.
    const memoryScope = await ranged.memoryScope();
    return ranged.contentRange
      ? runRangedRead(ids, ranged.contentRange, settings, [], memoryScope)
      : renderResolvedIds(ids, detail, memoryScope);
  }
  if (!rawQuery) return 'Search query or id is required.';

  const query = rawQuery;
  let timeRange: NormalizedSearchTimeRange | null = null;
  if (input.time_range != null) {
    try {
      timeRange = resolveSearchTimeRange({
        query,
        timeRange: input.time_range,
      }).timeRange;
    } catch (err) {
      return getErrorMessage(err);
    }
  }

  const hasExplicitWorkspaceScope = ['container_id', 'path', 'name'].some(
    (key) => typeof input[key] === 'string' && (input[key] as string).trim()
  );
  const limit = clampLimit(input.limit, { defaultLimit: 10, defaultOnNonPositive: false, max: 50 });
  const requestedMode =
    typeof input.mode === 'string' && input.mode.trim() ? input.mode.trim() : undefined;
  const mode = requestedMode ?? 'hybrid';
  // Archived policy: excluded from every channel unless explicitly requested;
  // when requested, archived hits are the point — they get pinned first.
  const includeArchived = input.include_archived === true;

  // File-kind project scoping inputs. scope_files defaults to 'project' (scope
  // file hits to the active/explicit project); 'workspace' disables scoping.
  // project_id, when provided, takes precedence over the thread-inferred project.
  const scopeFilesRaw =
    typeof input.scope_files === 'string' ? input.scope_files.trim() : undefined;
  if (scopeFilesRaw && scopeFilesRaw !== 'project' && scopeFilesRaw !== 'workspace') {
    return 'scope_files must be one of: project, workspace.';
  }
  const scopeFiles: 'project' | 'workspace' =
    scopeFilesRaw === 'workspace' ? 'workspace' : 'project';
  const fileProjectArg =
    typeof input.project_id === 'string' && input.project_id.trim()
      ? input.project_id.trim()
      : undefined;
  if (requestedMode && !(SEARCH_MODES as ReadonlySet<string>).has(requestedMode)) {
    return 'mode must be one of: hybrid, semantic, or keyword.';
  }

  const explicitKinds = input.kinds != null;
  const parsedKinds = parseSearchKinds(input.kinds);
  // Explicit thread_summary searches may inspect superseded versions; normal
  // default retrieval keeps only each agent's current summary.
  const threadSummaryExplicit = explicitKinds && parsedKinds.includes('thread_summary');
  const kinds = new Set<SearchableKind>(
    (mode === 'semantic' || mode === 'hybrid') && !explicitKinds
      ? parsedKinds.filter(isSemanticSearchKind)
      : parsedKinds
  );

  // Memories are private: the calling agent's own, plus kept facts about the
  // calling thread's human; never a proposal. No calling agent: no memories.
  const memoryScope = kinds.has('memory') ? await ranged.memoryScope() : null;

  const docOnly = kinds.size === 1 && kinds.has('doc');
  const messageOnly = kinds.size === 1 && kinds.has('message');

  // File lane: files left the shared default pool, so a code-ish query with NO
  // explicit `kinds` fires an additional file-only lane (merged as a labeled
  // section below). When the caller passes explicit `kinds`, we honor them
  // literally — files flow only if 'file' is among them, via the inline path.
  const fileLaneActive = !explicitKinds && isCodeishQuery(query);
  // File scoping follows the explicit thread_id, else the thread making the call.
  const scopeThreadId = parseThreadId(input.thread_id) ?? context?.threadId ?? null;
  const laneThreadId = scopeThreadId;

  let containerRowsCache: Awaited<ReturnType<typeof Containers.listAllOrdered>> | null = null;
  let allowedContainerIds: string[] | null = null;
  let scopeContainerId: string | null = null;

  if (hasExplicitWorkspaceScope) {
    containerRowsCache = await Containers.listAllOrdered();
    const scope = resolveContainerScope(input, containerRowsCache);
    if (scope.kind === 'error') return scope.message;
    if (scope.kind === 'scoped') {
      scopeContainerId = scope.containerId;
    }
  }

  if (scopeContainerId && containerRowsCache) {
    const childrenByParent = new Map<string, string[]>();
    for (const container of containerRowsCache) {
      if (!container.parentId) continue;
      const list = childrenByParent.get(container.parentId);
      if (list) list.push(container.id);
      else childrenByParent.set(container.parentId, [container.id]);
    }
    allowedContainerIds = collectDescendants(scopeContainerId, childrenByParent);
    if (allowedContainerIds.length === 0) {
      return `No results for "${query}" in scope.`;
    }
  }

  if (looksLikeSearchId(query)) {
    const idScope = await ranged.memoryScope();
    const resolved = await renderResolvedIds([query], detail, idScope);
    // A literal id passed as `query` is an exact fetch, so it takes the exact-id
    // ranged path too — the backward-compatible spelling must not behave
    // differently from `id`.
    if (!resolved.startsWith('No node found')) {
      return ranged.contentRange
        ? runRangedRead([query], ranged.contentRange, settings, [], idScope)
        : resolved;
    }
  }

  if (mode === 'semantic' || mode === 'hybrid' || messageOnly) {
    const semanticKinds = [...kinds].filter(isSemanticSearchKind);
    const unsupportedModeKinds = [...kinds].filter((kind) => !isSemanticSearchKind(kind));

    if ((mode === 'semantic' || mode === 'hybrid') && unsupportedModeKinds.length > 0) {
      return `mode: "${mode}" is supported for semantic-capable kinds only: doc, message, memory, thread_summary, file. Unsupported kind(s): ${unsupportedModeKinds.join(', ')}. Use mode: "keyword" for thread/container title and name lookup.`;
    }

    if (
      (mode === 'semantic' || mode === 'hybrid') &&
      ((!docOnly && !messageOnly) || semanticKinds.length > 1)
    ) {
      // Project-folder scoping for the `file` kind (see resolveFileProjectId).
      const fileScope = await resolveFileProjectId({
        scopeFiles,
        wantsFiles: semanticKinds.includes('file'),
        fileProjectArg,
        threadId: scopeThreadId,
      });
      const inlineFileFallback = semanticKinds.includes('file')
        ? await fileFallbackForScope({
            query,
            limit,
            channel: 'semantic',
            scopeFiles,
            scope: fileScope,
            excludeIds,
          })
        : null;
      const indexedSemanticKinds = inlineFileFallback
        ? semanticKinds.filter((kind) => kind !== 'file')
        : semanticKinds;

      // Committed (agent-driven) search: fetch the fused POOL (poolMode), then
      // rerank + candidate cards + quality floor at pool level in the
      // finish pipeline, before the final cut to `limit`.
      const poolSize = committedRerankPoolSize(limit);
      const pool =
        indexedSemanticKinds.length > 0
          ? await searchSemanticWorkspace({
              query,
              kinds: indexedSemanticKinds,
              mode: mode as 'semantic' | 'hybrid',
              limit,
              allowedContainerIds,
              threadId: scopeThreadId,
              graphDepth: parseGraphDepth(input.graph_depth),
              timeRange,
              fileProjectId: fileScope?.projectId ?? null,
              filePathPrefix: fileScope?.pathPrefix ?? null,
              poolMode: { size: poolSize },
              includeArchived,
              includeSupersededThreadSummaries: threadSummaryExplicit,
              memoryScope,
            })
          : [];
      const visiblePool = pool.filter((h) => !excludeIds.has(h.id));
      const finished = await finishCommittedSearch({
        query,
        hits: visiblePool,
        limit,
        cardContext: {
          threadId: context?.threadId ?? null,
          projectId: fileProjectArg,
          containerId: scopeContainerId,
        },
        includeArchived,
        semanticPath: true,
        rerankPoolSize: poolSize,
      });
      let visible = finished.hits;
      if (includeArchived) visible = await pinArchivedFirst(visible);
      // The lane is an enhancement, never a dependency — a lane exception must
      // not reject the whole call and discard the already-computed main results.
      const fileLane = fileLaneActive
        ? await runFileLane({
            query,
            channel: mode as 'semantic' | 'hybrid',
            limit,
            allowedContainerIds,
            scopeFiles,
            fileProjectArg,
            threadId: laneThreadId,
            timeRange,
            includeArchived,
            excludeIds,
          }).catch(() => ({ hits: [] as FileHit[], fallback: null }))
        : { hits: [] as FileHit[], fallback: null };
      const fileFallback = inlineFileFallback ?? fileLane.fallback;
      ranged.collect([...visible, ...fileLane.hits]);
      if (visible.length === 0 && fileLane.hits.length === 0 && !fileFallback) {
        // Honest empty state: the pool had candidates but none cleared the
        // relevance floor — say what to try instead of ten look-alikes.
        return finished.floorApplied && finished.weakCut > 0
          ? renderHonestEmpty(query, finished.weakCut)
          : `No results for "${query}".`;
      }
      // The floor may have emptied the shared pool while the file lane still has
      // hits — that composition must not read as an honest "nothing in the
      // pool"; it's withheld, not empty (mirrors the standalone empty-state
      // branch above).
      const emptyPoolNote =
        visible.length === 0 && finished.floorApplied && finished.weakCut > 0
          ? renderHonestEmpty(query, finished.weakCut)
          : undefined;
      const body =
        visible.length > 0 || fileLane.hits.length > 0
          ? composeWithFileLane(
              query,
              visible,
              new Map(),
              fileLane.hits,
              finished.cardById,
              emptyPoolNote
            )
          : null;
      const composed = appendFileFallback(body, fileFallback);
      return finished.floorApplied && finished.weakCut > 0 && visible.length > 0
        ? `${composed}\n\n${weakMatchesFooter(finished.weakCut)}`
        : composed;
    }

    if (!docOnly && !messageOnly) {
      return 'Hybrid workspace_search modes are currently supported only with kinds: ["doc"] or kinds: ["message"]. Omit mode for mixed lexical workspace search.';
    }

    const kind = messageOnly ? 'message' : 'doc';
    const poolSize = committedRerankPoolSize(limit);
    const search = await searchWorkspace(query, {
      kind,
      scope: {
        container_id: scopeContainerId ?? 'root',
      },
      limit: poolSize,
      mode: (mode ?? 'hybrid') as NodeSearchMode,
      time_range: timeRange,
      order_by: 'relevance',
      // Pool mode: the finish pipeline reranks with scores (for the floor) +
      // candidate cards + quality floor at pool level, so skip the internal rerank here.
      rerank: false,
    });
    const rawHits = messageOnly
      ? await hydrateHybridMessageHits(query, search.hits)
      : await hydrateHybridDocHits(query, search.hits);
    const pool = rawHits.filter((h) => !excludeIds.has(h.id));
    const finished = await finishCommittedSearch({
      query,
      hits: pool,
      limit,
      cardContext: {
        threadId: context?.threadId ?? null,
        projectId: fileProjectArg,
        containerId: scopeContainerId,
      },
      includeArchived,
      semanticPath: mode !== 'keyword',
      rerankPoolSize: poolSize,
    });
    const visible = finished.hits;
    if (visible.length === 0) {
      return finished.floorApplied && finished.weakCut > 0
        ? renderHonestEmpty(query, finished.weakCut)
        : (search.suggested ?? `No results for "${query}".`);
    }
    ranged.collect(visible);
    const body = renderResults(query, visible, new Map(), finished.cardById);
    return finished.floorApplied && finished.weakCut > 0
      ? `${body}\n\n${weakMatchesFooter(finished.weakCut)}`
      : body;
  }

  // Project-folder scoping for the `file` kind in the lexical/FTS channel —
  // mirrors the semantic channel so scope_files:'project' is enforced on both.
  const lexicalFileScope = await resolveFileProjectId({
    scopeFiles,
    wantsFiles: kinds.has('file'),
    fileProjectArg,
    threadId: scopeThreadId,
  });

  const inlineLexicalFileFallback = kinds.has('file')
    ? await fileFallbackForScope({
        query,
        limit,
        channel: 'lexical',
        scopeFiles,
        scope: lexicalFileScope,
        excludeIds,
      })
    : null;
  const indexedLexicalKinds = new Set(kinds);
  if (inlineLexicalFileFallback) indexedLexicalKinds.delete('file');

  const lexical =
    indexedLexicalKinds.size > 0
      ? await searchLexicalWorkspace({
          query,
          kinds: indexedLexicalKinds,
          limit,
          allowedContainerIds,
          containerRowsCache,
          timeRange,
          orderBy: 'relevance',
          fileProjectId: lexicalFileScope?.projectId ?? null,
          filePathPrefix: lexicalFileScope?.pathPrefix ?? null,
          includeArchived,
          includeSupersededThreadSummaries: threadSummaryExplicit,
          memoryScope,
        })
      : { hits: [] as SearchHit[], threadIds: [] as string[] };

  // Access-control: tool node hits must respect the calling agent's
  // allow/deny list and admin enable flags — otherwise workspace_search leaks
  // tools the agent cannot invoke (same gap closed for search_tools /
  // discovery). resolveAgentTools is the single source of truth.
  const hasToolHits = lexical.hits.some((h) => h.kind === 'tool');
  if (hasToolHits && context?.agentId) {
    const accessible = await resolveAgentTools(context.agentId);
    const accessibleToolIds = new Set(accessible.map((t) => t.tool.id));
    lexical.hits = lexical.hits.filter((h) => {
      if (h.kind === 'tool') return accessibleToolIds.has(h.id);
      return true;
    });
  }

  lexical.hits = lexical.hits.filter((h) => !excludeIds.has(h.id));

  // Keyword searches build the same evidence cards as committed semantic
  // searches, but keep lexical ordering and do not run the cross-encoder floor.
  // Count is preserved — each kind is already capped at `limit` in SQL.
  const finishedLexical = await finishCommittedSearch({
    query,
    hits: lexical.hits,
    limit: lexical.hits.length,
    cardContext: {
      threadId: context?.threadId ?? null,
      projectId: fileProjectArg,
      containerId: scopeContainerId,
    },
    includeArchived,
    semanticPath: false,
    rerankPoolSize: lexical.hits.length,
  });
  lexical.hits = finishedLexical.hits;
  if (includeArchived) lexical.hits = await pinArchivedFirst(lexical.hits);

  // The lane is an enhancement, never a dependency — a lane exception must not
  // reject the whole call and discard the already-computed main results.
  const fileLane = fileLaneActive
    ? await runFileLane({
        query,
        channel: 'lexical',
        limit,
        allowedContainerIds,
        scopeFiles,
        fileProjectArg,
        threadId: laneThreadId,
        timeRange,
        includeArchived,
        excludeIds,
      }).catch(() => ({ hits: [] as FileHit[], fallback: null }))
    : { hits: [] as FileHit[], fallback: null };
  const fileFallback = inlineLexicalFileFallback ?? fileLane.fallback;
  if (lexical.hits.length === 0 && fileLane.hits.length === 0 && !fileFallback) {
    const fuzzyKinds = new Set<SearchableKind>(
      [...kinds].filter((kind) => FUZZY_SEARCH_KINDS.has(kind))
    );
    if (fuzzyKinds.size > 0) {
      const fuzzyFileScope = fuzzyKinds.has('file')
        ? await resolveFileProjectId({
            scopeFiles,
            wantsFiles: true,
            fileProjectArg,
            threadId: scopeThreadId,
          })
        : null;
      const fuzzy = await searchFuzzyWorkspace({
        query,
        kinds: fuzzyKinds,
        limit,
        allowedContainerIds,
        containerRowsCache,
        fileProjectId: fuzzyFileScope?.projectId ?? null,
        filePathPrefix: fuzzyFileScope?.pathPrefix ?? null,
        includeArchived,
        memoryScope,
      });
      const fuzzyHits = fuzzy.hits.filter((h) => !excludeIds.has(h.id));
      if (fuzzyHits.length > 0) {
        const threadEnrichment = await buildThreadEnrichment(fuzzy.threadIds);
        ranged.collect(fuzzyHits);
        return renderResults(query, fuzzyHits, threadEnrichment);
      }
    }
    return `No results for "${query}".`;
  }

  const threadEnrichment = await buildThreadEnrichment(lexical.threadIds);
  ranged.collect([...lexical.hits, ...fileLane.hits]);
  const body =
    lexical.hits.length > 0 || fileLane.hits.length > 0
      ? composeWithFileLane(
          query,
          lexical.hits,
          threadEnrichment,
          fileLane.hits,
          finishedLexical.cardById
        )
      : null;
  return appendFileFallback(body, fileFallback);
}

/**
 * Reject `content_range` against an explicit `kinds` list that can never carry
 * ranged content — a caller asking for `kinds: ['thread']` with a range has a
 * wrong mental model, and silently returning an un-ranged result would hide it.
 * A MIXED list (some rangeable, some not) is allowed: the rangeable kinds are
 * read and the rest are named in the section's notes.
 */
function validateRangedKinds(input: Record<string, unknown>): string | null {
  if (input.kinds == null) return null;
  const requested = parseSearchKinds(input.kinds);
  if (requested.some((kind) => isRangedContentKind(kind))) return null;
  return (
    `content_range is not supported for kinds: ${requested.join(', ')}. ` +
    `Ranged reads are available for: ${RANGED_CONTENT_KINDS.join(', ')}.`
  );
}

const tool: ToolHandler = async (input, settings, context) => {
  const parsedRange = parseContentRange(input.content_range);
  if (!parsedRange.ok) return parsedRange.error;
  const contentRange = parsedRange.range;

  let effectiveInput = input;
  if (contentRange) {
    const kindsError = validateRangedKinds(input);
    if (kindsError) return kindsError;
    const hasIds =
      parseIds([input.id, ...(Array.isArray(input.ids) ? input.ids : [input.ids])]).length > 0;
    // The multiplying case: `limit` results x a range each. Only query searches
    // multiply — an exact-id list is already capped at 20 by parseIds and bounded
    // again by the shared response byte budget.
    //
    // An UNSTATED limit is lowered to the ranged cap rather than rejected: the
    // caller expressed no opinion, so silently searching wider than we can read
    // would be the surprise. An EXPLICIT limit above the cap is a real conflict
    // and is rejected, because quietly returning a fifth of what was asked for
    // is exactly the silent truncation this feature exists to avoid.
    if (!hasIds) {
      if (input.limit == null) {
        effectiveInput = { ...input, limit: MAX_RANGED_RESULTS };
      } else {
        const limitError = validateRangedQueryLimit(
          clampLimit(input.limit, { defaultLimit: 10, defaultOnNonPositive: false, max: 50 })
        );
        if (limitError) return limitError;
      }
    }
  }

  // `project_scope: 'only'` is the calling thread's project as a container scope, so it takes
  // the same path as `container_id` (subtree of folders, plus threads and messages through
  // `nodes.project_id`). An explicit container_id/path/name wins; a thread outside any project
  // searches everywhere and says so.
  let scopeNote = '';
  const explicitScope = ['container_id', 'path', 'name'].some(
    (key) => typeof input[key] === 'string' && (input[key] as string).trim()
  );
  if (input.project_scope === 'only' && !explicitScope) {
    const caller = await resolveCallerProject(parseThreadId(input.thread_id) ?? context?.threadId);
    if (caller) effectiveInput = { ...effectiveInput, container_id: caller.projectId };
    else
      scopeNote =
        'This thread is not in a project, so project_scope: "only" searched everywhere.\n\n';
  }

  // Resolved at most once per call, and only when a memory may be involved.
  let memoryScope: Promise<MemorySearchScope | null> | null = null;
  const memoryScopeOnce = () => (memoryScope ??= resolveMemorySearchScope(context));

  const collected: SearchHit[] = [];
  const body =
    scopeNote +
    (await runWorkspaceSearch(effectiveInput, settings, context, {
      contentRange,
      collect: (hits) => collected.push(...hits),
      memoryScope: memoryScopeOnce,
    }));
  // No range requested, or an exact-id path that already rendered its own ranged
  // output (those never collect) — return the search body byte-for-byte as before.
  if (!contentRange || collected.length === 0) return body;

  const section = await rangedSectionForHits(
    collected,
    contentRange,
    settings,
    collected.some((hit) => hit.kind === 'memory') ? await memoryScopeOnce() : null
  );
  return section ? `${body}\n\n${section}` : body;
};

export default tool;
