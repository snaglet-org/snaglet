/**
 * ConfigResolverService — single resolution path for agent and thread config.
 *
 * Prose fields (systemPrompt, identity) accept ContentField
 * values: inline strings or { pageId, blockId? } references (pageId is an
 * alias for a doc id, still accepted in stored config_json).
 *
 * Resolution chain:
 *   agent config_json (base defaults)
 *     ↓ overridden by (replace semantics, not merge)
 *   thread_participants columns (per-thread, per-agent overrides)
 *     ↓ overridden by
 *   runtime API overrides (ephemeral, never persisted)
 */

import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { type AgentRow } from '@snaglet/db/tables/agents';
import { getDb } from '@snaglet/db';
import type {
  ContentField,
  ModelConfig,
  ThreadConfig,
  DispatchConfig,
  BudgetConfig,
  ToolsConfig,
  ToolAccessConfig,
  ToolOverride,
  McpServerEnablementOverride,
} from '@snaglet/shared/types';
import { BARE_NODE_REF_RE, TRANSCLUSION_RE } from '@server/services/contentRefs';
import { logger } from '@server/config/logger';
import { resolveMaxOutputTokensCeiling } from '@server/services/groupChat/safety';
import {
  getErrorMessage,
  sliceDocAnchor,
  splitDocRef,
  type DocAnchor,
} from '@snaglet/shared/utils';
import { neutralizeSystemFraming } from '@server/services/ToolService/lib/untrustedContent';

const MAX_TRANSCLUSION_DEPTH = 3;

interface DocInfo {
  id: string;
  title: string;
  content: string;
  path: string;
}

async function loadDocsWithPaths(ids: string[]): Promise<Map<string, DocInfo>> {
  const out = new Map<string, DocInfo>();
  if (ids.length === 0) return out;
  try {
    const pool = getDb();
    const result = await pool.query<{
      doc_id: string;
      title: string;
      content: string;
      segments: string[];
    }>(
      `WITH RECURSIVE chain AS (
         SELECT
           d.id            AS doc_id,
           n.container_id  AS next_id,
           d.title         AS title,
           d.content       AS content,
           d.title         AS name,
           0               AS depth
         FROM docs d
         JOIN nodes n ON n.id = d.id
         WHERE d.id = ANY($1)
         UNION ALL
         SELECT
           chain.doc_id,
           n.container_id,
           chain.title,
           chain.content,
           c.name,
           chain.depth + 1
         FROM chain
         JOIN nodes      n ON n.id = chain.next_id
         JOIN containers c ON c.id = chain.next_id
         WHERE chain.next_id IS NOT NULL
       )
       SELECT
         doc_id,
         MAX(title)   AS title,
         MAX(content) AS content,
         array_agg(name ORDER BY depth DESC) AS segments
       FROM chain
       GROUP BY doc_id`,
      [ids]
    );
    for (const row of result.rows) {
      out.set(row.doc_id, {
        id: row.doc_id,
        title: row.title,
        content: row.content,
        path: '/' + (row.segments ?? []).join('/'),
      });
    }
  } catch (err) {
    logger.warn('[config resolver] transclusion fetch failed', {
      ids,
      error: getErrorMessage(err),
    });
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/** A closing `</doc>` tag (any case, inner spaces), the one way out of the wrapper. */
const DOC_CLOSE_TAG_RE = /<\/(\s*doc\s*)>/gi;

/**
 * A transcluded doc is someone else's text inside the system prompt, between
 * `<doc …>` and `</doc>`: escape a forged `<system-reminder>` tag and a
 * literal `</doc>` that would end the wrapper early. Anything else, Mermaid
 * arrows (`A --> B`) included, passes through byte-identical, so a clean doc
 * leaves the cached prefix unchanged.
 */
function neutralizeTranscludedText(text: string): string {
  return neutralizeSystemFraming(text).replace(DOC_CLOSE_TAG_RE, '&lt;/$1&gt;');
}

/**
 * Walk a resolved prompt string and replace every `![](doc-…)` transclusion (and
 * the `!doc-…` bare-form equivalent) with the doc's content wrapped in a
 * `<doc id="…" path="…">…</doc>` tag, so the receiving LLM can tell where one
 * doc ends and the surrounding prompt resumes. A `#L…`/`#h=…` part shows only
 * that part, with `part="…"` on the tag.
 *
 * Distinct from `[Title](doc-…)`, which stays as a literal markdown link
 * (mirrors markdown's image-vs-link distinction).
 *
 * Recursion guards:
 *   - Per-traversal `visited` set: a doc already on the path becomes
 *     `<doc … skipped="loop"/>`, never expanded.
 *   - `MAX_TRANSCLUSION_DEPTH` caps descent on bushy acyclic graphs.
 *   - A missing doc becomes `<doc id="…" missing="true"/>`, a missing part
 *     `<doc … missing="part"/>`.
 */
async function expandTransclusions(text: string): Promise<string> {
  // The cache is shared across the entire recursion: once a doc has been
  // looked up, child levels (and the cycle-marker render) reuse its info
  // without a second query. `null` = known missing, `undefined` = not
  // yet seen.
  return expandRecursive(
    text,
    new Set<string>(),
    new Map<string, DocInfo | null>(),
    0,
    MAX_TRANSCLUSION_DEPTH
  );
}

async function expandRecursive(
  text: string,
  visited: Set<string>,
  cache: Map<string, DocInfo | null>,
  depth: number,
  maxDepth: number
): Promise<string> {
  if (!text) return text;

  // Collect the spans for both grammars synchronously before any
  // awaits — module-scoped regexes share lastIndex state, so we can
  // never interleave exec() with await across concurrent callers.
  type Site = { id: string; start: number; end: number; anchor?: DocAnchor; part?: string };
  const markdownSites: Site[] = [];
  const ids = new Set<string>();

  TRANSCLUSION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRANSCLUSION_RE.exec(text)) !== null) {
    // [2] = `page:<uuid>` uuid (older content), [3] = prefixed `doc-…` id,
    // perhaps with a `#L…`/`#h=…` part.
    const ref = m[3] ? splitDocRef(m[3]) : null;
    const id = m[2] ?? ref?.id;
    if (!id) continue;
    const hash = m[3]?.indexOf('#') ?? -1;
    markdownSites.push({
      id,
      start: m.index,
      end: m.index + m[0].length,
      ...(ref?.anchor ? { anchor: ref.anchor, part: m[3]!.slice(hash + 1) } : {}),
    });
    ids.add(id);
  }

  const bareSites: Site[] = [];
  BARE_NODE_REF_RE.lastIndex = 0;
  while ((m = BARE_NODE_REF_RE.exec(text)) !== null) {
    // Only the `!doc-…` form is a transclusion. Other bare ids stay as text.
    if (m[1] !== '!' || !m[2]?.startsWith('doc-')) continue;
    bareSites.push({ id: m[2], start: m.index, end: m.index + m[0].length });
    ids.add(m[2]);
  }

  if (markdownSites.length === 0 && bareSites.length === 0) return text;

  // Only fetch ids we haven't already seen on the current traversal.
  // Records the misses too (as `null`) so a repeated missing id doesn't
  // re-query.
  const toFetch = [...ids].filter((id) => !cache.has(id));
  if (toFetch.length > 0) {
    const fresh = await loadDocsWithPaths(toFetch);
    for (const id of toFetch) {
      cache.set(id, fresh.get(id) ?? null);
    }
  }

  // Markers follow the doc tool's: one self-closing tag, never an HTML
  // comment, and a loop is never expanded.
  const renderRef = async (site: Pick<Site, 'id' | 'anchor' | 'part'>): Promise<string> => {
    const { id } = site;
    const info = cache.get(id);
    if (info == null) {
      return `<doc id="${escapeAttr(id)}" missing="true"/>`;
    }
    const partAttr = site.part ? ` part="${escapeAttr(site.part)}"` : '';
    const tag = `<doc id="${escapeAttr(info.id)}" path="${escapeAttr(info.path)}"${partAttr}`;
    if (visited.has(id)) {
      return `${tag} skipped="loop"/>`;
    }
    let body = info.content;
    if (site.anchor) {
      const part = sliceDocAnchor(info.content, site.anchor).text;
      if (part === null) return `${tag} missing="part"/>`;
      body = part;
    }
    // Neutralized before recursing, so the tags this walk writes for nested
    // transclusions stay intact.
    const content = neutralizeTranscludedText(body);
    if (depth + 1 >= maxDepth) {
      return `${tag}>\n${content}\n</doc>`;
    }
    visited.add(id);
    const expanded = await expandRecursive(content, visited, cache, depth + 1, maxDepth);
    visited.delete(id);
    return `${tag}>\n${expanded}\n</doc>`;
  };

  // Pass 1: markdown-form, applied to the original text.
  let pass1 = '';
  let cursor = 0;
  for (const site of markdownSites) {
    pass1 += text.slice(cursor, site.start);
    pass1 += await renderRef(site);
    cursor = site.end;
  }
  pass1 += text.slice(cursor);

  // Pass 2: bare-form, applied to pass-1 output. We re-scan because
  // pass 1 changed string offsets, but the bare regex won't match the
  // `doc-…` ids that now live inside `<doc id="…">` markup (no `!`
  // prefix, so the transclusion-form guard skips them).
  const pass2Sites: Site[] = [];
  BARE_NODE_REF_RE.lastIndex = 0;
  while ((m = BARE_NODE_REF_RE.exec(pass1)) !== null) {
    if (m[1] !== '!' || !m[2]?.startsWith('doc-')) continue;
    pass2Sites.push({ id: m[2], start: m.index, end: m.index + m[0].length });
  }

  if (pass2Sites.length === 0) return pass1;

  let result = '';
  cursor = 0;
  for (const site of pass2Sites) {
    result += pass1.slice(cursor, site.start);
    result += await renderRef(site);
    cursor = site.end;
  }
  result += pass1.slice(cursor);
  return result;
}

/**
 * Resolve a ContentField to its string value.
 *
 * Inline strings pass through unchanged with transclusions expanded.
 * Non-string fields resolve to null.
 */
export async function resolveContentField(
  field: ContentField | undefined | null
): Promise<string | null> {
  if (field == null) return null;
  if (typeof field === 'string') {
    return field.length > 0 ? expandTransclusions(field) : field;
  }
  return null;
}

/** Per-agent overrides from thread config_json. */
export interface ThreadAgentRuntimeConfig {
  /**
   * Additive thread-focused prompt — concatenated onto the agent's base
   * systemPrompt for this thread only. Threads may only append, not replace.
   */
  systemPromptAddendum?: string | null;
  model?: { provider: string; modelId: string; credential?: string };
  toolAccess?: ToolAccessConfig;
  toolOverrides?: Record<string, ToolOverride>;
  /**
   * Add/remove delta over the agent's enabled MCP servers in this thread.
   * No participant column stores one, so it is unset; the resolver
   * applies it when set, and a helper reads its orchestrator's from the
   * parent thread, never one on its own hidden thread.
   */
  mcpServers?: McpServerEnablementOverride;
  budget?: BudgetConfig;
}

/** Full runtime config for a thread, resolved from config_json. */
export interface ThreadRuntimeConfig {
  systemPrompt?: string | null;
  agentOverrides: Map<string, ThreadAgentRuntimeConfig>;
  /**
   * Dispatch tuning bag, currently empty: `routing` lives on the
   * `threads.dispatch_mode` column and cadence is implicit in the routing
   * mode. A slot for future per-thread dispatch tuning.
   */
  dispatch: DispatchConfig;
  budget?: BudgetConfig;
  tools?: ToolsConfig;
  // A `history` stanza in stored config_json is ignored.
}

/**
 * Resolve runtime config for a thread.
 *
 * Thread-level fields (systemPrompt, budget, tools) come from threads.config_json.
 * Per-agent overrides come from thread_participants flat columns.
 *
 * Returns null if the thread doesn't exist.
 */
export async function resolveThreadRuntimeConfig(
  threadId: string
): Promise<ThreadRuntimeConfig | null> {
  const thread = await Threads.findById(threadId);
  if (!thread) return null;

  // Thread-level system prompt (applies to all agents in this thread), stored
  // on the threads.thread_system_prompt column.
  const systemPrompt = await resolveContentField(thread.threadSystemPrompt ?? undefined);

  // Thread budget, rebuilt from the typed columns into the BudgetConfig shape
  // its consumers already expect. The maxWaves encoding is the interesting
  // part: the column stores -1 for "unbounded" because a nullable integer
  // cannot distinguish that from "unset", and BudgetConfig expresses unbounded
  // as an explicit null. Translating here keeps that three-state contract
  // intact for buildConversationBudget without changing its logic.
  const budget: BudgetConfig = {};
  if (thread.maxWaves === -1) budget.maxWaves = null;
  else if (typeof thread.maxWaves === 'number') budget.maxWaves = thread.maxWaves;
  if (typeof thread.maxTotalOutputTokens === 'number') {
    budget.maxTotalOutputTokens = thread.maxTotalOutputTokens;
  }
  if (typeof thread.maxAgentDispatches === 'number') {
    budget.maxAgentDispatches = thread.maxAgentDispatches;
  }
  // A subagent's thread has no limits to set (its settings show neither): it
  // runs with no wave cap and the largest output budget the server allows,
  // whatever its row or the settings profile say.
  if (thread.parentThreadId) {
    budget.maxWaves = null;
    budget.maxTotalOutputTokens = resolveMaxOutputTokensCeiling();
  }

  // Thread tool access, rebuilt into the ToolsConfig {allow, deny} shape.
  const tools: ToolsConfig = {};
  if (Array.isArray(thread.toolAccessAllowList) && thread.toolAccessAllowList.length > 0) {
    tools.allow = thread.toolAccessAllowList;
  }
  if (Array.isArray(thread.toolAccessDenyList) && thread.toolAccessDenyList.length > 0) {
    tools.deny = thread.toolAccessDenyList;
  }

  const dispatch: DispatchConfig = {} as DispatchConfig;

  // Per-agent overrides from thread_participants flat columns.
  const agentOverrides = new Map<string, ThreadAgentRuntimeConfig>();
  const participants = await ThreadParticipants.listByThread(threadId);

  for (const p of participants) {
    if (!p.agentId) continue;

    const agentConfig: ThreadAgentRuntimeConfig = {};

    if (p.systemPromptAddendum) {
      agentConfig.systemPromptAddendum = await resolveContentField(p.systemPromptAddendum);
    }

    if (p.modelId && p.providerId) {
      agentConfig.model = {
        provider: p.providerId,
        modelId: p.modelId,
        ...(p.credentialId ? { credential: p.credentialId } : {}),
      };
    }

    if (p.toolAccessMode) {
      const mode = p.toolAccessMode as ToolAccessConfig['mode'];
      agentConfig.toolAccess = {
        mode,
        allowList: Array.isArray(p.toolAccessAllowList) ? p.toolAccessAllowList : [],
        denyList: Array.isArray(p.toolAccessDenyList) ? p.toolAccessDenyList : [],
      };
    }

    if (p.toolOverrides && typeof p.toolOverrides === 'object') {
      agentConfig.toolOverrides = p.toolOverrides as Record<string, ToolOverride>;
    }

    // Only maxToolCallsPerTurn is surfaced: BudgetConfig has no duration field,
    // so `thread_participants.max_duration_seconds` is stored and editable but
    // not enforced at runtime. Guarding on it here as well would imply it round
    // trips, which it does not — enforcement would need a reader added first.
    if (p.maxToolCallsPerTurn != null) {
      agentConfig.budget = { maxToolCallsPerTurn: p.maxToolCallsPerTurn };
    }

    agentOverrides.set(p.agentId, agentConfig);
  }

  return {
    systemPrompt,
    agentOverrides,
    dispatch,
    budget: Object.keys(budget).length > 0 ? budget : undefined,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
  };
}

export interface ResolvedAgentConfig {
  systemPrompt: string;
  identity: string | null;
  model: ModelConfig | null;
  provider: string;
  modelId: string | null;
}

/**
 * Resolve an agent's effective config from its flat columns.
 * systemPrompt and identity may be wiki-link refs — expand them.
 */
export async function resolveAgentConfig(row: AgentRow): Promise<ResolvedAgentConfig> {
  let systemPrompt: string | null = null;
  let identity: string | null = null;

  if (row.systemPrompt != null) {
    systemPrompt = await resolveContentField(row.systemPrompt as ContentField);
  }
  if (row.identity != null) {
    identity = await resolveContentField(row.identity as ContentField);
  }

  const provider = row.providerId ?? '';
  const modelId = row.modelId ?? null;
  const model: ModelConfig | null =
    provider && modelId
      ? { provider, id: modelId, ...(row.credentialId ? { credential: row.credentialId } : {}) }
      : null;

  return {
    systemPrompt: systemPrompt ?? '',
    identity,
    model,
    provider,
    modelId,
  };
}

/**
 * Stub retained so caller tools keep compiling. ConfigResolverService no
 * longer maintains a content cache.
 */
export function invalidateAll(): void {
  // no-op
}
