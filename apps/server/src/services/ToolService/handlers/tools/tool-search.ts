import { toolView } from '@snaglet/db';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolHandler } from '@server/services/ToolService/types';
import { generateQueryEmbedding } from '@server/services/EmbeddingService';
import { fuseRRF, RRF_K } from '@server/services/search/fuseRRF';
import {
  resolveAgentTools,
  resolveAgentToolsForExecution,
} from '@server/services/AgentToolResolver';
import { resolveThreadRuntimeConfig } from '@server/services/ConfigResolverService';
import { isHelperAgent } from '@server/services/subagents/helperVisibility';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import listTools from '@server/services/ToolService/handlers/trivial/listTools';
import {
  rankToolCandidates,
  type RankedTool,
  type ToolCandidate,
  type ToolCandidateType,
} from './ranking';

// Channel rows (ToolSearchEntry) and resolved rows both project onto this:
// the fields ranking needs beyond id/name/description are optional because
// not every channel carries them (a mocked or older row may omit them).
type RawTool = {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  aliases?: string[];
  type?: string;
  category_path?: string;
};

type ScoredRawTool = RawTool & { score?: number };

type ShapedTool = {
  id: string;
  name: string;
  description: string;
  score?: number;
  reasons?: string[];
};

// Slim result shape: agents get just enough to pick the right tool. Including
// schema/keywords/aliases/example_call would inflate this to 500–2000 tokens
// per result — agents fetch the full schema for the one they pick via the
// tool(op:schema).
function shape(t: RankedTool, explain: boolean): ShapedTool {
  const firstLine = t.description.split('\n', 1)[0].trim();
  const out: ShapedTool = {
    id: t.id,
    name: t.name,
    description: firstLine,
    score: t.score,
  };
  if (explain) out.reasons = t.reasons;
  return out;
}

function candidateType(raw: string | undefined): ToolCandidateType | undefined {
  return raw === 'builtin' || raw === 'mcp' || raw === 'external' ? raw : undefined;
}

// Project a fused/ordered pool onto ranking candidates. Resolved ToolRows (when
// the caller has an agentId) are the richer source of type/category/keywords;
// channel rows fill in for everything else. A pool entry without a channel
// score (keyword-only path) gets an RRF-shaped rank score so every candidate's
// base lives on one scale.
function toCandidates(pool: ScoredRawTool[], resolvedById: Map<string, ToolRow>): ToolCandidate[] {
  return pool.map((t, i) => {
    const row = resolvedById.get(t.id);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      keywords: row?.keywords ?? t.keywords ?? [],
      aliases: row?.aliases ?? t.aliases ?? [],
      type: candidateType(row?.type ?? t.type),
      categoryPath: row?.categoryPath ?? t.category_path,
      retrievalScore: typeof t.score === 'number' ? t.score : 1 / (RRF_K + i + 1),
      retrievalRank: i + 1,
    };
  });
}

// How many candidates each channel produces before fusion. Larger pools give
// RRF more signal; final slice still caps at TOP_N.
const CHANNEL_POOL = 10;
const TOP_N = 3;

type SearchMode = 'hybrid' | 'semantic' | 'keyword';

type SearchResponse = {
  tools: ShapedTool[];
  related?: ShapedTool[];
  count: number;
  search_query: string;
  search_mode: SearchMode;
  channels?: { semantic: number; keyword: number };
  ranking?: { query_verbs: string[]; query_objects: string[] };
  /** Matching tools that exist but the agent's tool access hides. */
  blocked?: ShapedTool[];
  blocked_note?: string;
  /** What to do with this result: the model's next step, in one line. */
  next: string;
};

function parseMode(raw: unknown): SearchMode | { error: string } {
  if (raw === undefined || raw === null || raw === '') return 'hybrid';
  const m = String(raw).toLowerCase().trim();
  if (m === 'hybrid' || m === 'semantic' || m === 'keyword') return m;
  return { error: `Error: Invalid mode '${m}'. Must be 'hybrid', 'semantic', or 'keyword'.` };
}

// Keywords signaling the agent wants something in the workspace (docs, tasks,
// threads, etc.) rather than the open web. When the query contains any of
// these, workspace_* tools are promoted above web tools (google_*) so agents
// reach for local sources first.
const WORKSPACE_DOMAIN_TERMS = [
  'doc',
  'document',
  'note',
  'container',
  'thread',
  'task',
  'subtask',
  'project',
  'idea',
  'memory',
  'memories',
  'message',
  'workspace',
];
const WORKSPACE_DOMAIN_RE = new RegExp(`\\b(${WORKSPACE_DOMAIN_TERMS.join('|')})s?\\b`, 'i');
function isWorkspaceDomainQuery(query: string): boolean {
  return WORKSPACE_DOMAIN_RE.test(query);
}

// How far domain membership may move a candidate, in rank positions. Bounded
// on purpose: domain is a PREFERENCE between comparably-relevant tools, not a
// verdict that outranks retrieval.
const DOMAIN_RANK_SHIFT = 3;

// Stable re-rank applied inside the ranking stage (via rankToolCandidates'
// `reRank` hook), before family grouping and the TOP_N slice. When the query
// is about workspace content, workspace_* tools gain ground and web tools
// lose it.
// Pure re-ordering: never adds or drops candidates, so a workspace tool only
// surfaces if a channel already retrieved it.
//
// This applies a BOUNDED rank shift rather than an absolute tier sort. The
// previous absolute sort put every workspace_*/thread_* candidate above every
// other candidate no matter how weakly it matched: once retrieval started
// ranking by relevance, "create a project brief document" surfaced
// `thread_delete` (which merely lists `project` among its keywords) at rank 8
// and the tier sort promoted it to first, above `create_doc`. A preference
// that can override eight places of relevance evidence is not a preference.
function reRankByDomain<T extends { id: string }>(tools: T[], query: string | undefined): T[] {
  if (!query || !isWorkspaceDomainQuery(query)) return tools;
  // thread / thread_* (thread(op), thread_send, …) are workspace-domain tools:
  // grouped with workspace_* so thread-creation discoverability isn't
  // penalized against a comparably-ranked workspace_* tool for thread queries.
  const shift = (id: string): number => {
    if (id.startsWith('workspace_') || id === 'thread' || id.startsWith('thread_')) {
      return -DOMAIN_RANK_SHIFT;
    }
    if (id.startsWith('google_')) return DOMAIN_RANK_SHIFT;
    return 0;
  };
  return tools
    .map((t, i) => ({ t, i, position: i + shift(t.id) }))
    .sort((a, b) => a.position - b.position || a.i - b.i)
    .map((x) => x.t);
}

// Live MCP tools aren't DB rows, so the semantic/keyword channels (which query
// the tools table) never retrieve them. Rank the agent's enabled-server MCP
// tools lexically against the query and merge them into the result pool.
function lexicalRankMcp(query: string, candidates: RawTool[], pool: number): ScoredRawTool[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  if (terms.length === 0) return [];
  return candidates
    .map((c) => {
      const hay = `${c.id} ${c.name} ${c.description}`.toLowerCase();
      let hits = 0;
      for (const t of terms) if (hay.includes(t)) hits += 1;
      return { ...c, score: hits / terms.length };
    })
    .filter((c) => (c.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, pool);
}

// Merge a single already-ranked channel with the live-MCP lexical channel via
// RRF, keyed by rank not raw score (the two channels' scores live on
// different, incomparable scales: a DB channel with no per-item score at
// all, cosine similarity, or term-hit-fraction). This is the same reasoning
// the full hybrid branch below uses for semantic+keyword.
//
// Appending mcpHits after `primary` and truncating to TOP_N would mean an MCP
// tool never surfaces whenever the primary channel alone fills TOP_N (the
// common case); RRF gives every MCP hit a fair rank-based shot at the top.
function mergeWithMcp(
  primary: RawTool[],
  mcpHits: ScoredRawTool[],
  query: string
): ScoredRawTool[] {
  if (mcpHits.length === 0) return primary;
  const byId = new Map<string, RawTool>();
  for (const t of primary) byId.set(t.id, t);
  for (const t of mcpHits) if (!byId.has(t.id)) byId.set(t.id, t);

  const fused = fuseRRF(
    [
      primary.map((t, i) => ({
        id: t.id,
        rank: i + 1,
        channel: 'primary' as const,
        title: t.name,
      })),
      mcpHits.map((t, i) => ({ id: t.id, rank: i + 1, channel: 'mcp' as const, title: t.name })),
    ],
    { query }
  );
  return fused.flatMap((f) => {
    const tool = byId.get(f.id);
    return tool ? [{ ...tool, score: f.rrfScore }] : [];
  });
}

// The result tells the model its next step, so a found tool is called rather
// than reported missing, a blocked one is reported as blocked, and a miss
// leads to creating a tool (toolDiscoveryBlock states the same rule).
const NEXT_FOUND =
  "Read a tool's parameters with tool({op: 'schema', name: '<id>'}), then call it with action({tool: '<id>', params: {...}}).";
const NEXT_ONLY_BLOCKED =
  'No tool you can use matches. The matches under `blocked` exist, but your tool access blocks them.';
const NO_MATCH = 'No matching tool. Search again with other words (the thing or the verb).';
const CREATE_TOOL_ID = 'custom_tool';
const NO_MATCH_CREATE = `${NO_MATCH} If nothing fits, you can create one with ${CREATE_TOOL_ID}({op: 'create', name, description, parameters_schema, handler_source}).`;
const NO_MATCH_ASK = `${NO_MATCH} If nothing fits, tell the user what tool you need: they can add one (Tools view → New tool), or allow \`${CREATE_TOOL_ID}\` in your Capabilities so you can create it.`;
const BLOCKED_NOTE = {
  agent:
    "These tools exist, but your tool access does not allow them. Do not tell the user they are missing or that you lost access: say they are blocked by your permissions, which the user can change in your agent's Capabilities settings (Agents).",
  thread:
    "These tools exist, but this thread's tool access does not allow them. Do not tell the user they are missing or that you lost access: say they are blocked in this thread, which the user can change in this thread's settings → Agents.",
} as const;

function nextStep(found: boolean, blocked: boolean, canCreate: boolean): string {
  if (found) return NEXT_FOUND;
  if (blocked) return NEXT_ONLY_BLOCKED;
  return canCreate ? NO_MATCH_CREATE : NO_MATCH_ASK;
}

function rankTop(
  pool: ScoredRawTool[],
  query: string,
  resolvedById: Map<string, ToolRow>
): ReturnType<typeof rankToolCandidates> & { top: RankedTool[] } {
  const ranked = rankToolCandidates(toCandidates(pool, resolvedById), query, {
    reRank: <T extends { id: string }>(list: T[]) => reRankByDomain(list, query),
  });
  return { ...ranked, top: ranked.primary.slice(0, TOP_N) };
}

// The one place a result is assembled: rank the fused pool with the bounded
// domain preference applied INSIDE the ranking stage (before family grouping,
// so `related` always belongs to the final winner's family), then slice and
// shape. `blocked` comes from ranking the same channels over every tool that
// exists for the agent: a blocked tool is listed only when it would have made
// the top results had the agent's access allowed it.
function finalize(args: {
  pool: ScoredRawTool[];
  query: string;
  mode: SearchMode;
  explain: boolean;
  resolvedById: Map<string, ToolRow>;
  channels?: { semantic: number; keyword: number };
  blocked?: {
    pool: ScoredRawTool[];
    ids: Set<string>;
    resolvedById: Map<string, ToolRow>;
    by: keyof typeof BLOCKED_NOTE;
  };
  canCreate: boolean;
}): string {
  const { pool, query, mode, explain, resolvedById, channels, blocked, canCreate } = args;
  const ranked = rankTop(pool, query, resolvedById);
  const primary = ranked.top;

  if (pool.length === 0) {
    logger.debug(`[tool(op:search)] ${mode} returned 0 hits`, { query });
  } else {
    logger.debug('[tool(op:search)] ranking', {
      query,
      verbs: ranked.query.verbs,
      objects: ranked.query.objects,
      top: primary.map((t) => ({ id: t.id, score: t.score, reasons: t.reasons })),
      related: ranked.related.map((t) => t.id),
    });
  }

  const blockedHits = blocked
    ? rankTop(blocked.pool, query, blocked.resolvedById).top.filter((t) => blocked.ids.has(t.id))
    : [];

  const out: SearchResponse = {
    tools: primary.map((t) => shape(t, explain)),
    count: primary.length,
    search_query: query,
    search_mode: mode,
    next: nextStep(primary.length > 0, blockedHits.length > 0, canCreate),
  };
  if (ranked.related.length > 0) out.related = ranked.related.map((t) => shape(t, explain));
  if (blockedHits.length > 0) {
    out.blocked = blockedHits.map((t) => shape(t, explain));
    out.blocked_note = BLOCKED_NOTE[blocked!.by];
  }
  if (channels) out.channels = channels;
  if (explain) {
    out.ranking = { query_verbs: ranked.query.verbs, query_objects: ranked.query.objects };
  }
  return JSON.stringify(out);
}

/** The thread's tool-access override for this agent, if any (null-safe). */
async function threadToolAccessFor(
  threadId: string,
  agentId: string
): Promise<ToolAccessConfig | undefined> {
  try {
    const config = await resolveThreadRuntimeConfig(threadId);
    return config?.agentOverrides.get(agentId)?.toolAccess;
  } catch (err) {
    logger.warn('[tool(op:search)] thread tool access resolution failed; using agent access', err);
    return undefined;
  }
}

/** The raw channel results for one query, before any access gate. */
type ChannelResults =
  | { mode: 'keyword'; keyword: RawTool[] }
  | { mode: 'semantic'; semantic: RawTool[] }
  | { mode: 'hybrid'; semantic: RawTool[]; keyword: RawTool[] };

// Query-only path: HYBRID SEARCH.
// Run semantic (pgvector cosine over tool embeddings) and keyword (ILIKE +
// tokenized fallback) channels in parallel; fusePool then fuses the two ranked
// lists with Reciprocal Rank Fusion. RRF weights rank position, not raw
// scores, so the two channels' incomparable score scales don't bias the
// result.
//
// Degradation: if the embedding provider is unavailable or fails, we run
// keyword-only and report search_mode='keyword'.
async function runChannels(query: string, mode: SearchMode): Promise<ChannelResults> {
  const keywordOnly = async (): Promise<ChannelResults> => ({
    mode: 'keyword',
    keyword: (await toolView.searchByKeyword(query, CHANNEL_POOL)).tools,
  });
  // Mode: 'keyword' — skip embedding call entirely.
  if (mode === 'keyword') return keywordOnly();

  // generateQueryEmbedding swallows provider errors and returns {embedding:null}
  // when no provider is available, so we don't need a try/catch wrapper.
  const { embedding, model } = await generateQueryEmbedding(query);

  // Mode: 'semantic' — fall back to keyword when no provider is available.
  if (mode === 'semantic') {
    if (!embedding) return keywordOnly();
    const semantic = await toolView.semanticSearch(embedding, CHANNEL_POOL, undefined, model);
    return { mode: 'semantic', semantic: semantic.tools };
  }

  // Mode: 'hybrid' (default). Keyword channel always runs — it's our floor.
  const keywordPromise = toolView.searchByKeyword(query, CHANNEL_POOL);
  if (!embedding) return { mode: 'keyword', keyword: (await keywordPromise).tools };
  const [semantic, keyword] = await Promise.all([
    toolView.semanticSearch(embedding, CHANNEL_POOL, undefined, model),
    keywordPromise,
  ]);
  return { mode: 'hybrid', semantic: semantic.tools, keyword: keyword.tools };
}

/**
 * Fuse one gated view of the channel results with the live-MCP lexical hits.
 * Gating happens before fusion so tools outside the gate never enter the
 * ranked set or the rehydration map.
 */
function fusePool(
  results: ChannelResults,
  gate: <T extends { id: string }>(tools: T[]) => T[],
  mcpHits: ScoredRawTool[],
  query: string
): { pool: ScoredRawTool[]; channels?: { semantic: number; keyword: number } } {
  if (results.mode === 'keyword')
    return { pool: mergeWithMcp(gate(results.keyword), mcpHits, query) };
  if (results.mode === 'semantic') {
    return { pool: mergeWithMcp(gate(results.semantic), mcpHits, query) };
  }
  const semantic = gate(results.semantic);
  const keyword = gate(results.keyword);

  // Rehydration map: fuseRRF works on ids; we need the full tool record back.
  const byId = new Map<string, RawTool>();
  for (const t of semantic) byId.set(t.id, t);
  for (const t of keyword) if (!byId.has(t.id)) byId.set(t.id, t);
  for (const t of mcpHits) if (!byId.has(t.id)) byId.set(t.id, t);

  const fused = fuseRRF(
    [
      semantic.map((t, i) => ({
        id: t.id,
        rank: i + 1,
        channel: 'semantic' as const,
        title: t.name,
      })),
      keyword.map((t, i) => ({
        id: t.id,
        rank: i + 1,
        channel: 'keyword' as const,
        title: t.name,
      })),
      // Live MCP tools as a lexical channel (same scale as keyword).
      mcpHits.map((t, i) => ({
        id: t.id,
        rank: i + 1,
        channel: 'keyword' as const,
        title: t.name,
      })),
    ],
    { query }
  );

  const pool = fused.flatMap((f) => {
    const tool = byId.get(f.id);
    return tool ? [{ ...tool, score: f.rrfScore }] : [];
  });
  return { pool, channels: { semantic: semantic.length, keyword: keyword.length } };
}

/**
 * Tools that exist for this agent (every tool it could reach with access
 * mode All) but its effective access hides: an allow list that does not name
 * them, or a deny entry. Search lists matching ones under `blocked`, so the
 * agent can say a tool is blocked instead of claiming it does not exist. Any
 * failure leaves the list empty (the gated results are unaffected).
 */
async function blockedToolsFor(
  agentId: string,
  accessibleIds: Set<string>
): Promise<{ ids: Set<string>; resolvedById: Map<string, ToolRow> } | null> {
  try {
    const everything = (await resolveAgentToolsForExecution(agentId)) ?? [];
    const ids = new Set(everything.map((r) => r.tool.id).filter((id) => !accessibleIds.has(id)));
    if (ids.size === 0) return null;
    return { ids, resolvedById: new Map(everything.map((r) => [r.tool.id, r.tool])) };
  } catch (err) {
    logger.warn('[tool(op:search)] blocked-tool resolution failed; listing none', err);
    return null;
  }
}

const tool: ToolHandler = async (input, _settings, context) => {
  if (input.mode === 'list') return listTools(input, _settings, context);
  const query = input.query ? String(input.query) : undefined;
  const modeOrErr = parseMode(input.mode);
  if (typeof modeOrErr !== 'string') return modeOrErr.error;
  const mode: SearchMode = modeOrErr;
  const explain = input.explain === true;

  if (!query) {
    return "Error: Provide a non-empty 'query'";
  }

  // Access gate — tool(op:search) must never surface a tool the calling agent
  // cannot actually invoke as usable. resolveAgentTools is the single source
  // of truth: it applies tool and integration gates plus the agent's
  // allow/deny list. We build the reachable id set once and filter every
  // result path before ranking/slicing, so inaccessible tools don't consume
  // TOP_N slots (they may appear under `blocked` instead, never in `tools`).
  // If agentId is absent (e.g. system context), we skip filtering rather than
  // hide everything.
  let accessibleIds: Set<string> | null = null;
  let threadAccess = false;
  let mcpCandidates: RawTool[] = [];
  const resolvedById = new Map<string, ToolRow>();
  if (context?.agentId) {
    try {
      // Thread-effective access: the catalog is advertised from the
      // agent's base access in every thread, so a tool a thread grants beyond
      // that base is reachable only through discovery — search must see it.
      // A subagent helper's access is its orchestrator's (the resolver reads
      // it); an override on its hidden thread never applies to its calls, so
      // search must not list by it either.
      const access =
        context.threadId && !(await isHelperAgent(context.agentId))
          ? await threadToolAccessFor(context.threadId, context.agentId)
          : undefined;
      const resolved = access
        ? await resolveAgentTools(context.agentId, { access })
        : await resolveAgentTools(context.agentId);
      threadAccess = access !== undefined;
      accessibleIds = new Set(resolved.map((r) => r.tool.id));
      for (const r of resolved) resolvedById.set(r.tool.id, r.tool);
      mcpCandidates = resolved
        .filter((r) => r.tool.type === 'mcp')
        .map((r) => ({ id: r.tool.id, name: r.tool.name, description: r.tool.description }));
    } catch (err) {
      logger.warn('[tool(op:search)] resolveAgentTools failed; returning unfiltered', err);
    }
  }
  const allowed = accessibleIds;
  const gate = <T extends { id: string }>(tools: T[]): T[] =>
    allowed ? tools.filter((t) => allowed.has(t.id)) : tools;

  // MCP tools (gated by construction — they come from the agent's resolved set).
  const mcpHits = lexicalRankMcp(query, mcpCandidates, CHANNEL_POOL);

  const results = await runChannels(query, mode);
  const { pool, channels } = fusePool(results, gate, mcpHits, query);

  const blockedSet =
    context?.agentId && allowed ? await blockedToolsFor(context.agentId, allowed) : null;
  const blocked = blockedSet
    ? {
        ...blockedSet,
        by: threadAccess ? ('thread' as const) : ('agent' as const),
        pool: fusePool(
          results,
          <T extends { id: string }>(tools: T[]) =>
            tools.filter((t) => allowed!.has(t.id) || blockedSet.ids.has(t.id)),
          mcpHits,
          query
        ).pool,
      }
    : undefined;

  return finalize({
    pool,
    query,
    mode: results.mode,
    explain,
    resolvedById,
    channels,
    blocked,
    canCreate: !allowed || allowed.has(CREATE_TOOL_ID),
  });
};

export default tool;
