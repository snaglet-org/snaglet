/**
 * The stable, every-turn tool catalog.
 *
 * Tool definitions still carry a `tier` for display and migration
 * compatibility, but provider advertisement is governed by this one explicit
 * set. Keep changes deliberate: every entry adds its full JSON schema to each
 * model request.
 *
 * The array order is the order core tools are sent to the model. The original
 * tools are most-used first, by live usage; the block added
 * later follows them in a fixed order, not by usage. Non-core
 * tools follow in catalog order.
 */
export const CORE_TOOL_ORDER: readonly string[] = Object.freeze([
  'action',
  'search',
  'file',
  'shell',
  'node',
  'doc',
  'table',
  'memory',
  'get_current_datetime',
  'tool',
  'container',
  'ask',
  'thread',
  'subagent',
  'update_plan',
  'resolve_path',
  'web_fetch',
  'web_search',
  // Added later, in a fixed order (not by usage).
  'hook',
  'automation',
  'agent',
  'model',
  'mcp',
  'custom_tool',
  'calendar',
  'orient',
  // Advertised only to agents with a skill assigned (AgentToolResolver).
  'skill',
]);

/**
 * Membership view of CORE_TOOL_ORDER. Order lives only in CORE_TOOL_ORDER:
 * the advertised set is sorted by it, so the cached tools prefix is
 * the same for every agent regardless of DB `sort_order`.
 */
export const CORE_TOOL_IDS: ReadonlySet<string> = new Set(CORE_TOOL_ORDER);

/**
 * Tools every tool-capable agent always has, whatever its allow or deny list:
 * `tool` (search and schema) to find tools and `get_current_datetime` to tell the time.
 * No allow or deny entry gates them, by id or any other name: tool
 * visibility, the call-time permission check and chat dispatch all exempt
 * them (server `alwaysAvailableTools.ts`), and the tool-access editor shows
 * them as always available.
 */
export const ALWAYS_AVAILABLE_TOOL_IDS: ReadonlySet<string> = new Set([
  'tool',
  'get_current_datetime',
]);

/**
 * Powerful process/filesystem primitives are core only when the agent's
 * effective access policy grants them. The other core tools remain visible in
 * allow-list mode and follow the existing call-time escalation behavior.
 */
export const ACCESS_GATED_CORE_TOOL_IDS: ReadonlySet<string> = new Set(['shell']);

/**
 * Tools a subagent helper (agents.parent_agent_id set) never gets,
 * whatever its access mode: no nesting, no memory writes, no questions to a
 * user who may not be watching its hidden thread. Removed at tool
 * resolution, so neither the advertised catalog nor allow-list escalation
 * can reach them.
 */
export const SUBAGENT_DENIED_TOOL_IDS: ReadonlySet<string> = new Set([
  'subagent',
  'memory',
  'ask',
  // Helpers are short-lived and hidden; scheduled wakes belong to their orchestrator.
  'automation',
]);
