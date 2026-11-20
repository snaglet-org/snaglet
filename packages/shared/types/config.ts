/**
 * Shared config types for agents and threads.
 *
 * These types define the shape of config_json JSONB columns.
 * Prose fields (systemPrompt, identity) accept inline text or doc references.
 */

/**
 * A content field that can be either inline text or a reference to a
 * workspace doc (or a specific block within a doc). The field is still named
 * `pageId` for compatibility with older config JSON.
 */
export type ContentField = string | { pageId: string } | { pageId: string; blockId: string };

export interface ModelConfig {
  provider: string;
  id: string;
  credential?: string;
}

export interface BudgetConfig {
  // There is no `maxOutputTokens` key: the conversation-total override is
  // `maxTotalOutputTokens`, and a stored `maxOutputTokens` is ignored.
  /**
   * Conversation-wide cap on the dispatch loop (thread scope).
   *   - `undefined` → use the settings default (24).
   *   - positive N  → cap of N waves per user message, honored exactly.
   *   - `null`      → no wave limit; the output-token cap still ends runaways.
   */
  maxWaves?: number | null;
  /**
   * Cap on total output tokens across all agents for one user message (thread
   * scope). A runaway guard: once spent, no further agent or wave starts; it
   * never shortens a single reply. Positive N, clamped to the server ceiling
   * (default 192k / SNAGLET_MAX_OUTPUT_TOKENS_CEILING). undefined → settings
   * default (also 192k).
   */
  maxTotalOutputTokens?: number;
  /**
   * @deprecated Ignored. Per-turn tool calls are bounded by the per-agent cap
   * (`maxToolCallsPerTurn`); a stored value here is read but not enforced.
   * Do not set it.
   */
  maxTotalToolIterations?: number;
  /**
   * Conversation-wide cap on per-agent participation (thread scope).
   * Positive N = soft threshold (hard ceiling is 2x). `0` = explicitly
   * unlimited. undefined/null (including the key being absent) = settings
   * default, not unlimited.
   */
  maxAgentDispatches?: number;
  /** Per-turn cap on tool calls within a single agent run (agent scope). */
  maxToolCallsPerTurn?: number;
  /**
   * @deprecated Use `maxToolCallsPerTurn` (per-turn agent cap). `runAgentTurn`
   * still honors a stored value. Do not set it in new code.
   */
  maxToolIterations?: number;
}

/**
 * Per-turn dispatch routing.
 *
 * Stored on the first-class `threads.dispatch_mode` column (not in
 * config_json). The type
 * stays exported here for the few callers (UI form widget, validation)
 * that still need the union of literal values.
 *
 * Cadence (parallel vs sequential) is implicit in the routing mode:
 *   - 'all'         → parallel (everyone fires at once)
 *   - 'mentioned'   → parallel (multiple mentions fire at once)
 * There are deliberately no standalone `dispatch.sequential` /
 * `dispatch.parallelOnMention` knobs — two ways to express the same
 * axis (mode vs cadence) made the UI confusing and the runtime logic
 * harder to reason about.
 */
export type DispatchRouting = 'all' | 'mentioned';

/**
 * Dispatch tuning that does not fit the mode column. Empty; a non-empty
 * stored `config_json.dispatch` is tolerated but ignored.
 */
export type DispatchConfig = Record<string, never>;

export type ToolAccessMode = 'all' | 'allow_list' | 'deny_list';

export interface ToolAccessConfig {
  mode: ToolAccessMode;
  allowList: string[];
  denyList: string[];
}

export interface ToolsConfig {
  allow?: string[];
  deny?: string[];
}

/**
 * Per-thread adjustment to an agent's enabled MCP servers.
 *
 * Unlike most thread overrides (which REPLACE the agent value), MCP enablement
 * uses an explicit add/remove DELTA so a thread can say "also give this agent
 * the browser here" without restating the agent's whole server list.
 */
export interface McpServerEnablementOverride {
  add?: string[];
  remove?: string[];
}

/**
 * Resolve the effective set of enabled MCP server ids for an agent in a thread.
 *
 * `base` is the agent's own `mcp_servers` column; `override` is the thread's
 * `{ add, remove }` delta. Result is deduped and order-stable (base order, then
 * appended adds). `remove` wins over `add` when an id appears in both.
 */
export function resolveEnabledMcpServers(
  base: string[] | null | undefined,
  override?: McpServerEnablementOverride | null
): string[] {
  const removed = new Set(override?.remove ?? []);
  const result: string[] = [];
  const seen = new Set<string>();
  const push = (id: unknown): void => {
    if (typeof id !== 'string') return;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed) || removed.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  };
  for (const id of Array.isArray(base) ? base : []) push(id);
  for (const id of override?.add ?? []) push(id);
  return result;
}

/**
 * Per-agent, per-tool override. Lives at agent.configJson.toolOverrides[toolId]
 * and (optionally) at thread.config_json.agents[agentId].toolOverrides[toolId].
 *
 * - `settings` is merged into the tool's base config_json before the handler runs.
 * - `requiresConfirmation` gates the human confirmation flow for that tool.
 */
export interface ToolOverride {
  settings?: Record<string, unknown>;
  requiresConfirmation?: boolean;
}

function normalizeToolIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

/**
 * Normalize tool access fields into a single UI/runtime shape.
 *
 * Older input shapes also accepted:
 * - toolAccessMode: 'allowlist'
 * - tools: string[] (implicit allow list)
 * - tools: { allow?: string[]; deny?: string[] }
 */
export function normalizeToolAccessConfig(
  config: Record<string, unknown> | null | undefined
): ToolAccessConfig {
  const rawMode = config?.toolAccessMode;
  const rawTools = config?.tools;
  const legacyTools =
    typeof rawTools === 'object' && rawTools !== null && !Array.isArray(rawTools)
      ? (rawTools as Record<string, unknown>)
      : null;

  let mode: ToolAccessMode = 'all';
  if (rawMode === 'allow_list' || rawMode === 'deny_list' || rawMode === 'all') {
    mode = rawMode;
  } else if (rawMode === 'allowlist') {
    mode = 'allow_list';
  }

  const allowList = normalizeToolIdList(
    config?.toolAllowList ?? legacyTools?.allow ?? (Array.isArray(rawTools) ? rawTools : undefined)
  );
  const denyList = normalizeToolIdList(config?.toolDenyList ?? legacyTools?.deny);

  // No explicit mode: infer it when only one list exists.
  if (rawMode == null && mode === 'all') {
    if (allowList.length > 0) mode = 'allow_list';
    else if (denyList.length > 0) mode = 'deny_list';
  }

  return { mode, allowList, denyList };
}

// There is no HistoryConfig: the token budget ratio (0.6) and tail-message
// count are fixed, overridable only via model metadata. Stale `history` stanzas
// in config_json rows are ignored by all readers.

export interface AgentConfig {
  model?: ModelConfig;
  fallbacks?: ModelConfig[];
  budget?: BudgetConfig;
  tools?: ToolsConfig | string[];
  toolAccessMode?: ToolAccessMode | 'allowlist';
  toolAllowList?: string[];
  toolDenyList?: string[];
  toolOverrides?: Record<string, ToolOverride>;
  temperature?: number;
  systemPrompt?: ContentField;
  identity?: ContentField;
}

export interface ThreadAgentOverride {
  model?: ModelConfig;
  fallbacks?: ModelConfig[];
  budget?: BudgetConfig;
  tools?: ToolsConfig;
  toolAccessMode?: ToolAccessMode | 'allowlist';
  toolAllowList?: string[];
  toolDenyList?: string[];
  toolOverrides?: Record<string, ToolOverride>;
  /** Per-thread add/remove delta over the agent's enabled MCP servers. */
  mcpServers?: McpServerEnablementOverride;
  /**
   * Prose appended to the agent's base systemPrompt for this thread only.
   * Threads may only append — edit the agent directly to change their identity.
   */
  systemPromptAddendum?: ContentField;
}

export interface ThreadConfig {
  systemPrompt?: ContentField;
  dispatch?: DispatchConfig;
  budget?: BudgetConfig;
  tools?: ToolsConfig;
  /** Per-agent overrides, keyed by agent UUID. Only thread participants may have entries. */
  agents?: Record<string, ThreadAgentOverride>;
}
