/**
 * AgentToolResolver — which tools an agent can use, with per-tool overrides.
 * Access comes from `ToolAccessConfig` (thread override ?? agent); per-tool
 * settings merge agent then thread `toolOverrides` (thread wins).
 *
 * Confirmation precedence (native and MCP alike; dispatch only reads
 * `requiresConfirmation`): thread override > agent `trustedToolCalls` (no
 * prompt) > agent override > tool default / MCP server policy. Trust never
 * widens access: allow/deny lists and MCP enablement run before this step.
 */

import { Tools, type ToolRow } from '@snaglet/db/tables/tools';
import { Agents } from '@snaglet/db/tables/agents';
import { SkillAssignments } from '@snaglet/db/tables/skill_assignments';
import { SkillRegistry } from '@snaglet/db/tables/skill_registry';
import { logger } from '@server/config/logger';
import {
  type ToolAccessConfig,
  type ToolOverride,
  type McpServerEnablementOverride,
  resolveEnabledMcpServers,
} from '@snaglet/shared/types';
import {
  ACCESS_GATED_CORE_TOOL_IDS,
  CORE_TOOL_IDS,
  CORE_TOOL_ORDER,
} from '@snaglet/shared/constants';
import { getToolAvailability } from '@server/services/ToolAvailabilityService';
import { mcpService, type McpToolDef } from '@server/services/McpService';
import { mcpToolDefToToolRow } from '@server/services/McpService/mcpToolRow';
import { MCP_PREFIX } from '@server/services/McpService/mcpTypes';
import { parseRule, UNGUARDED_OPS } from '@server/services/ToolService/lib/toolPermission';
import { toolRegistry } from '@server/services/ToolService/ToolRegistry';
import {
  identifiersMatch,
  isToolVisible,
  toolOpEnum,
} from '@server/services/ToolService/lib/toolVisibility';
import { resolveAgentToolPolicy } from '@server/services/ToolService/lib/agentToolPolicy';
import {
  getErrorMessage,
  GUARDED_TOOL_KINDS,
  resolveToolId,
  TOOL_OP_PARAM,
  toolAliasIdsFor,
} from '@snaglet/shared/utils';

const NO_ACTIVE_BUILTINS: ReadonlySet<string> = new Set();

/**
 * Discovery tools that ride along with a strict advertisement (the opt-in
 * `toolAccessAdvertiseAllowedOnly` agent flag) even when not in the allow
 * list, so a trimmed agent can still find, read and call other tools —
 * progressive disclosure stays alive. `action` is how a fetched tool is
 * called (the advertised set never grows mid-run); it widens nothing, since
 * dispatch checks the tool it names exactly like a native call. A rider that
 * is access-gated for the agent does not ride along.
 */
const STRICT_ADVERTISEMENT_RIDER_TOOL_IDS: ReadonlySet<string> = new Set(['action', 'tool']);

/**
 * A tool resolved for a specific agent, with per-tool overrides applied.
 * A runtime construct only, never persisted.
 */
export interface ResolvedAgentTool {
  agentId: string;
  tool: ToolRow;
  /** Per-(agent, tool) settings, merged with tool.config_json by ToolExecutor. */
  settings: Record<string, unknown>;
  /**
   * Whether this tool requires explicit human confirmation before running.
   * For a merged `tool(op)` this is true when any op confirms; dispatch reads
   * the per-op answer from `opConfirmation` (see `confirmationForCall`).
   */
  requiresConfirmation: boolean;
  /** Merged tools only: the confirmation decision for each op in its enum. */
  opConfirmation?: Record<string, boolean>;
  /**
   * MCP tools only: the agent whose connection a per-agent server runs this
   * tool's calls on. A subagent helper's is its orchestrator's, so a helper
   * drives the orchestrator's server instance (its session, no extra
   * process) and can never reach a connection the orchestrator lacks.
   */
  mcpAgentId?: string;
}

/**
 * The confirmation decision for one call. Merged tools decide per op, so a
 * guarded agent's `file(op:read)` doesn't ask just because `file(op:create)`
 * does. A call without a recognized op falls back to the whole-tool flag (the
 * safe direction).
 */
export function confirmationForCall(
  agentTool: Pick<ResolvedAgentTool, 'requiresConfirmation' | 'opConfirmation'> & {
    tool?: Pick<ToolRow, 'id'>;
  },
  input: Record<string, unknown>
): boolean {
  const op = input[TOOL_OP_PARAM];
  // shell(op:write) with no chars only polls a running session's output: it
  // types nothing, so it never asks (or every long command would need a human
  // per poll). Typed chars follow the op's flag, which mirrors `run`.
  if (agentTool.tool?.id === 'shell' && op === 'write' && !hasStdinChars(input)) return false;
  if (typeof op === 'string' && agentTool.opConfirmation && op in agentTool.opConfirmation) {
    return agentTool.opConfirmation[op]!;
  }
  return agentTool.requiresConfirmation;
}

function hasStdinChars(input: Record<string, unknown>): boolean {
  const chars = input.chars;
  return typeof chars === 'string' ? chars.length > 0 : chars !== undefined && chars !== null;
}

export interface SelectAdvertisedAgentToolsOptions {
  /** Tools reachable without changing the effective access policy. */
  allowedTools: readonly ResolvedAgentTool[];
  /** Full runtime execution set. Wider only for allow-list escalation. */
  executionTools: readonly ResolvedAgentTool[];
  access: ToolAccessConfig;
  /**
   * Opt-in strict advertisement (`agents.tool_access_advertise_allowed_only`).
   * Only meaningful when `access.mode === 'allow_list'`: the advertised
   * catalog becomes exactly the allow list ∩ reachable tools, plus the
   * `tool` discovery rider (excluded when access-gated
   * for the agent). Inert in every other mode. Never widens: every id a strict
   * advertisement selects would also be selected by the default branch.
   * Execution/escalation semantics are untouched — this trims what is
   * advertised, not what is callable.
   */
  advertiseAllowedOnly?: boolean;
}

function readOverrides(
  toolOverrides: Record<string, unknown> | null | undefined
): Record<string, ToolOverride> {
  return toolOverrides && typeof toolOverrides === 'object'
    ? (toolOverrides as Record<string, ToolOverride>)
    : {};
}

/**
 * Advertisement pinning only, never access: a caller pins a schema only when
 * the tool is already allowed (`pinned && allowed`), so matching a
 * definition's own `aliases` here (e.g. an MCP tool's short name) cannot
 * widen what an agent may call.
 */
function explicitlyListed(
  tool: ToolRow,
  access: ToolAccessConfig,
  activeToolIds: ReadonlySet<string>
): boolean {
  return access.allowList.some((entry) => {
    const { toolId } = parseRule(entry);
    return (
      identifiersMatch(toolId, tool, activeToolIds, 'allow') ||
      (tool.aliases ?? []).some((alias: string) => alias.toLowerCase() === toolId.toLowerCase())
    );
  });
}

function readToolOverride(
  overrides: Record<string, ToolOverride>,
  toolId: string,
  activeToolIds: ReadonlySet<string> = NO_ACTIVE_BUILTINS
): ToolOverride {
  // Prefer the exact stored id while that row exists; otherwise fall back
  // through alias keys so overrides stored under an alias id still apply.
  const exact = overrides[toolId];
  if (exact) return exact;
  const canonical = resolveToolId(toolId).id;
  if (overrides[canonical]) return overrides[canonical]!;
  for (const aliasId of toolAliasIdsFor(canonical)) {
    if (!activeToolIds.has(aliasId) && overrides[aliasId]) return overrides[aliasId]!;
  }
  return {};
}

/**
 * Effective confirmation flag for one (agent, tool) pair. See the module
 * header for the precedence; `fallback` is the tool default (false) for
 * builtins and the server policy for MCP tools.
 */
function resolveRequiresConfirmation(
  threadOverride: ToolOverride,
  agentOverride: ToolOverride,
  trusted: boolean,
  fallback: boolean
): boolean {
  if (threadOverride.requiresConfirmation !== undefined) return threadOverride.requiresConfirmation;
  if (trusted) return false;
  return agentOverride.requiresConfirmation ?? fallback;
}

function buildResolved(
  agentId: string,
  tool: ToolRow,
  agentOverrides: Record<string, ToolOverride>,
  threadOverrides: Record<string, ToolOverride>,
  activeToolIds: ReadonlySet<string>,
  trusted: boolean
): ResolvedAgentTool {
  const agentOverride = readToolOverride(agentOverrides, tool.id, activeToolIds);
  const threadOverride = readToolOverride(threadOverrides, tool.id, activeToolIds);
  const base = {
    agentId,
    tool,
    settings: { ...(agentOverride.settings ?? {}), ...(threadOverride.settings ?? {}) },
  };
  const ops = toolOpEnum(tool);
  if (ops.length === 0) {
    return {
      ...base,
      requiresConfirmation: resolveRequiresConfirmation(
        threadOverride,
        agentOverride,
        trusted,
        false
      ),
    };
  }
  const opConfirmation: Record<string, boolean> = {};
  for (const op of ops) {
    opConfirmation[op] = resolveOpConfirmation(
      tool.id,
      op,
      agentOverrides,
      threadOverrides,
      activeToolIds,
      trusted
    );
  }
  return {
    ...base,
    requiresConfirmation: Object.values(opConfirmation).some(Boolean),
    opConfirmation,
  };
}

/** Alias ids that map to `canonicalId` with this op pinned (and aren't live rows). */
function opAliasIdsFor(
  canonicalId: string,
  op: string,
  activeToolIds: ReadonlySet<string>
): string[] {
  return toolAliasIdsFor(canonicalId).filter(
    (aliasId) => !activeToolIds.has(aliasId) && resolveToolId(aliasId).op === op
  );
}

function definitionDestructiveOps(toolId: string): readonly string[] | undefined {
  try {
    return toolRegistry.getDefinition(toolId)?.destructiveOps;
  } catch {
    return undefined; // registry unavailable → caller's safe default
  }
}

/**
 * Whether a guarded agent's creation-time canonical `requiresConfirmation`
 * covers this op of a merged tool: yes for `destructiveOps`; for a
 * GUARDED_TOOL_KINDS kind, yes unless the op is in UNGUARDED_OPS; for a tool
 * guarded only by `destructiveOps`, only those ops; otherwise (including an
 * unloaded definition) yes. It can only exempt ops, never widen.
 */
function opInheritsAgentFlag(canonicalId: string, op: string): boolean {
  const destructiveOps = definitionDestructiveOps(canonicalId);
  if (destructiveOps?.includes(op)) return true;
  if (canonicalId in GUARDED_TOOL_KINDS) return UNGUARDED_OPS[canonicalId]?.has(op) !== true;
  if (destructiveOps && destructiveOps.length > 0) return false;
  return true;
}

/**
 * Ops whose confirmation follows another op of the same tool unless an alias
 * id pinned to the op sets its own flag. shell(op:write) types commands, so a
 * guarded agent that confirms `run` confirms typed input too; an explicit
 * `write_stdin` override still opts typed input out (or in). Polls never ask
 * (see confirmationForCall).
 */
const CONFIRMATION_FOLLOWS_OP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  shell: { write: 'run' },
};

/**
 * The override flag for one op of a merged tool at one level (thread or
 * agent): the canonical id first (what the UI writes), then any alias id that
 * pins this op. An agent-level canonical flag is skipped for ops it doesn't
 * cover (opInheritsAgentFlag); an alias-id or thread-level flag applies to any op.
 */
function opOverrideFlag(
  overrides: Record<string, ToolOverride>,
  canonicalId: string,
  op: string,
  activeToolIds: ReadonlySet<string>,
  level: 'thread' | 'agent'
): boolean | undefined {
  const skipCanonical = level === 'agent' && !opInheritsAgentFlag(canonicalId, op);
  if (!skipCanonical) {
    const flag = overrides[canonicalId]?.requiresConfirmation;
    if (flag !== undefined) return flag;
  }
  for (const aliasId of opAliasIdsFor(canonicalId, op, activeToolIds)) {
    const flag = overrides[aliasId]?.requiresConfirmation;
    if (flag !== undefined) return flag;
  }
  return undefined;
}

function resolveOpConfirmation(
  canonicalId: string,
  op: string,
  agentOverrides: Record<string, ToolOverride>,
  threadOverrides: Record<string, ToolOverride>,
  activeToolIds: ReadonlySet<string>,
  trusted: boolean
): boolean {
  const followsOp = CONFIRMATION_FOLLOWS_OP[canonicalId]?.[op];
  if (followsOp !== undefined) {
    // Thread level first (own pin, then the followed op's flag), then agent
    // level the same way, so a thread override still wins over the agent.
    const pinned = (overrides: Record<string, ToolOverride>): boolean | undefined => {
      for (const aliasId of opAliasIdsFor(canonicalId, op, activeToolIds)) {
        const flag = overrides[aliasId]?.requiresConfirmation;
        if (flag !== undefined) return flag;
      }
      return undefined;
    };
    const threadFlag =
      pinned(threadOverrides) ??
      opOverrideFlag(threadOverrides, canonicalId, followsOp, activeToolIds, 'thread');
    if (threadFlag !== undefined) return threadFlag;
    if (trusted) return false;
    return (
      pinned(agentOverrides) ??
      opOverrideFlag(agentOverrides, canonicalId, followsOp, activeToolIds, 'agent') ??
      false
    );
  }
  const threadFlag = opOverrideFlag(threadOverrides, canonicalId, op, activeToolIds, 'thread');
  if (threadFlag !== undefined) return threadFlag;
  if (trusted) return false;
  return opOverrideFlag(agentOverrides, canonicalId, op, activeToolIds, 'agent') ?? false;
}

export interface ResolveAgentToolsOptions {
  /** Override the agent's own ToolAccessConfig (e.g. with a thread-resolved one). */
  access?: ToolAccessConfig;
  /** Per-tool overrides from a thread-agent override block. */
  threadOverrides?: Record<string, ToolOverride>;
  /** Per-thread add/remove delta over the agent's enabled MCP servers. */
  mcpServerOverride?: McpServerEnablementOverride;
  /**
   * Warm the agent's enabled MCP servers whose tools aren't cached yet (in the
   * background). Only paths where the agent is about to use its tools set
   * this — an agent turn. Listings (UI reads, the context
   * estimate, tool(op:search), the action gateway) leave it off, so reading an
   * agent's tools never starts a server.
   */
  warmMcpServers?: boolean;
}

function buildResolvedMcp(
  agentId: string,
  mcpAgentId: string,
  def: McpToolDef,
  serverConfirm: boolean,
  agentOverrides: Record<string, ToolOverride>,
  threadOverrides: Record<string, ToolOverride>,
  trusted: boolean
): ResolvedAgentTool {
  const agentOverride = readToolOverride(agentOverrides, def.namespacedId);
  const threadOverride = readToolOverride(threadOverrides, def.namespacedId);
  return {
    agentId,
    mcpAgentId,
    tool: mcpToolDefToToolRow(def),
    settings: { ...(agentOverride.settings ?? {}), ...(threadOverride.settings ?? {}) },
    // Default to the server's confirmation policy; a trusted agent skips
    // it, and an explicit thread override wins over both.
    requiresConfirmation: resolveRequiresConfirmation(
      threadOverride,
      agentOverride,
      trusted,
      serverConfirm
    ),
  };
}

/**
 * Resolve the effective tool list for an agent. `options.access` overrides the
 * agent's own access config; `options.threadOverrides` merges over the agent's
 * `toolOverrides` (thread wins). Every active tool in the `tools` table is
 * reachable unless filtered by access config.
 */
export async function resolveAgentTools(
  agentId: string,
  options: ResolveAgentToolsOptions = {}
): Promise<ResolvedAgentTool[]> {
  const agent = await Agents.findById(agentId);
  if (!agent) return [];
  // A subagent helper inherits its orchestrator's live policy: access,
  // per-tool confirmation overrides, trust, MCP servers and the per-agent MCP
  // connection all come from the orchestrator (in the parent thread), so a
  // helper can do exactly what it can, and never more.
  // The same policy judges the agent's calls on /api/tools/execute and the
  // executor-level action gateway (agentToolPolicy).
  const policy = await resolveAgentToolPolicy(agent);
  const { helperPolicy } = policy;
  const policyAgent = helperPolicy?.orchestrator ?? agent;

  const access: ToolAccessConfig = options.access ?? policy.access;
  const agentOverrides = readOverrides(policyAgent.toolOverrides);
  const threadOverrides = options.threadOverrides ?? helperPolicy?.threadToolOverrides ?? {};
  // Persisted trust flag — the only input that suppresses confirmation for
  // every tool type at once. Read from the row so every caller (dispatch,
  // the action gateway, tool(op:search)) resolves it identically.
  const trusted = policyAgent.trustedToolCalls === true;
  // Per-op confirmation reads definition metadata (destructiveOps). Memoized
  // after boot; a load failure degrades to "the agent flag covers every op"
  // (opInheritsAgentFlag's safe default), never to fewer confirmations.
  try {
    await toolRegistry.load();
  } catch {
    /* safe default above */
  }

  // Builtin tools: filter the tools table by access config + availability.
  // Persisted `type='mcp'` rows are excluded — MCP tools come from the live
  // gateway below.
  const allTools = await Tools.listResolvable();
  const builtinTools = allTools.filter((tool) => tool.type !== 'mcp');
  const activeBuiltinIds = new Set(builtinTools.map((tool) => tool.id));
  const availability = await Promise.all(builtinTools.map((tool) => getToolAvailability(tool)));
  // Visibility (toolVisibility): access policy, plus the helper-denied set a
  // subagent helper never gets whatever its mode.
  const builtinResolved = builtinTools
    .filter(
      (tool, index) =>
        isToolVisible(tool, access, activeBuiltinIds, { helper: policy.helper }) &&
        availability[index] === 'available'
    )
    .map((tool) =>
      buildResolved(agentId, tool, agentOverrides, threadOverrides, activeBuiltinIds, trusted)
    );

  // Live MCP tools for the agent's enabled servers (per-server enablement is the
  // access control — no per-tool allow/deny). Cache-only + background warm.
  // A helper's servers are its orchestrator's in the parent thread, with that
  // thread's delta (helperPolicy.mcpServerIds). A delta passed here belongs to
  // the thread being resolved, for a helper its hidden thread, so it never
  // applies; a helper whose policy no longer resolves gets none.
  const enabledServers = policy.helper
    ? (helperPolicy?.mcpServerIds ?? [])
    : resolveEnabledMcpServers(agent.mcpServers, options.mcpServerOverride);
  // A helper narrowed by op:start `tools` keeps only the MCP tools it lists,
  // wherever its builtins are filtered by that allow list; the execution set
  // (access All, allow-list escalation) keeps the rest, so using one asks a
  // person first, as an unlisted builtin does.
  const mcpLimit = access.mode === 'allow_list' ? (helperPolicy?.mcpLimit ?? null) : null;
  const mcpAgentId = helperPolicy?.orchestrator.id ?? agentId;
  let mcpResolved: ResolvedAgentTool[] = [];
  if (enabledServers.length > 0) {
    if (options.warmMcpServers) {
      const warm = mcpLimit
        ? enabledServers.filter((server) =>
            [...mcpLimit].some((id) => id.startsWith(`${MCP_PREFIX}${server}__`))
          )
        : enabledServers;
      mcpService.ensureServersConnected(warm, { agentId: mcpAgentId });
    }
    mcpResolved = mcpService
      .getToolDefsForServers(enabledServers)
      .filter((def) => mcpLimit === null || mcpLimit.has(def.namespacedId))
      .map((def) =>
        buildResolvedMcp(
          agentId,
          mcpAgentId,
          def,
          mcpService.getConfirmationPolicy(def.serverId),
          agentOverrides,
          threadOverrides,
          trusted
        )
      );
  }

  const resolved = [...builtinResolved, ...mcpResolved];
  return resolved;
}

/**
 * Resolve the runtime execution set without widening the advertised catalog.
 * Used only for allow-list escalation: a model that explicitly names a hidden
 * tool through the action gateway may ask the human for permission, while
 * resolveAgentTools remains the source of truth for what the model can see.
 */
export function resolveAgentToolsForExecution(
  agentId: string,
  options: Omit<ResolveAgentToolsOptions, 'access'> = {}
): Promise<ResolvedAgentTool[]> {
  return resolveAgentTools(agentId, {
    ...options,
    access: { mode: 'all', allowList: [], denyList: [] },
  });
}

/**
 * Select the schemas sent to the model for one run. Does not mutate access:
 * the stable core is advertised and explicit allow-list entries pin extras.
 * The set is fixed for the whole run (a tool fetched with tool(op:schema) goes
 * through the `action` gateway) so the cached prefix stays warm. In allow-list
 * mode the computer primitives stay hidden unless explicitly granted; other
 * core calls keep the call-time confirmation escalation.
 */
export function selectAdvertisedAgentTools({
  allowedTools,
  executionTools,
  access,
  advertiseAllowedOnly = false,
}: SelectAdvertisedAgentToolsOptions): ResolvedAgentTool[] {
  const allowedById = new Map(allowedTools.map((entry) => [entry.tool.id, entry]));
  const activeToolIds = new Set(executionTools.map((entry) => entry.tool.id));
  const strict = advertiseAllowedOnly && access.mode === 'allow_list';
  const selected: ResolvedAgentTool[] = [];

  for (const entry of executionTools) {
    const { tool } = entry;
    const allowed = allowedById.has(tool.id);
    const core = CORE_TOOL_IDS.has(tool.id);
    const accessGatedCore = ACCESS_GATED_CORE_TOOL_IDS.has(tool.id);
    const pinned = explicitlyListed(tool, access, activeToolIds);

    if (strict) {
      // Opt-in small-model trim: exactly the allow list ∩ reachable tools,
      // plus the discovery riders. Riders are core and never access-gated
      // when they ride, so a strict advertisement is always a subset of the
      // default branch below — it can only ever narrow.
      const rider = STRICT_ADVERTISEMENT_RIDER_TOOL_IDS.has(tool.id) && !accessGatedCore;
      if ((pinned && allowed) || rider) selected.push(entry);
      continue;
    }

    // A bare deny removes the row from both allowedTools and executionTools.
    // The only wider execution set is allow-list mode, where non-computer core
    // tools stay visible but preserve the existing call-time ask escalation.
    const advertiseCore = core && (allowed || (access.mode === 'allow_list' && !accessGatedCore));

    if (advertiseCore || (pinned && allowed)) selected.push(entry);
  }

  return orderAdvertisedTools(selected);
}

const CORE_POSITION = new Map(CORE_TOOL_ORDER.map((id, index) => [id, index]));

/**
 * Core tools first, in CORE_TOOL_ORDER; every other tool after them in the
 * order it arrived (catalog order). Stable, so the cached tools prefix is the
 * same for every agent with the same core set.
 */
export function orderAdvertisedTools(tools: ResolvedAgentTool[]): ResolvedAgentTool[] {
  return tools
    .map((entry, index) => ({ entry, index, core: CORE_POSITION.get(entry.tool.id) }))
    .sort((a, b) => {
      if (a.core !== undefined && b.core !== undefined) return a.core - b.core;
      if (a.core !== undefined) return -1;
      if (b.core !== undefined) return 1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** Tool id of the skill loader; advertised only to agents with skills. */
export const SKILL_TOOL_ID = 'skill';

/**
 * Agent-keyed: true when the agent has any skill assigned in any scope, or any
 * valid built-in skill exists (every agent gets those). Fails closed (hidden).
 */
async function agentHasAnySkill(agentId: string): Promise<boolean> {
  try {
    if (await SkillAssignments.agentHasAny(agentId)) return true;
    return (await SkillRegistry.listBuiltinValid()).length > 0;
  } catch (err) {
    logger.warn('[AgentToolResolver] skill assignment lookup failed; hiding `skill`', {
      agentId,
      error: getErrorMessage(err),
    });
    return false;
  }
}

export interface ResolveAdvertisedAgentToolSetsOptions extends Omit<
  ResolveAgentToolsOptions,
  'access'
> {
  /** Effective access config: thread override ?? agent base. */
  access: ToolAccessConfig;
  /**
   * False when the resolved model can't do native tool calling — the agent
   * then runs tool-less and every set is empty, so it is never handed (or
   * told about, or billed for) tools it cannot call.
   */
  modelSupportsTools?: boolean;
}

export interface AdvertisedAgentToolSets {
  /** Reachable without changing the access policy. */
  allowedTools: ResolvedAgentTool[];
  /** Runtime-routable set; wider than `allowedTools` only for allow-list escalation. */
  executionTools: ResolvedAgentTool[];
  /** The schemas actually put on the wire. */
  advertisedTools: ResolvedAgentTool[];
}

/**
 * One resolution of "what does this agent see this turn", shared by the turn
 * path and the context-usage estimator so they cannot drift on the advertised
 * catalog (part of the prompt budget). The strict-advertisement flag is read
 * from the agent row here, only when the effective mode is allow_list.
 */
export async function resolveAdvertisedAgentToolSets(
  agentId: string,
  { access, modelSupportsTools = true, ...options }: ResolveAdvertisedAgentToolSetsOptions
): Promise<AdvertisedAgentToolSets> {
  if (!modelSupportsTools) {
    return { allowedTools: [], executionTools: [], advertisedTools: [] };
  }
  // `skill` exists only for agents with a skill assigned somewhere.
  // Keyed on the agent alone — never thread state — so the advertised
  // catalog stays identical across threads. Whether a given skill
  // is usable in this thread is checked by the handler at call time.
  const hasSkills = await agentHasAnySkill(agentId);
  const withoutSkillTool = (tools: ResolvedAgentTool[]): ResolvedAgentTool[] =>
    hasSkills ? tools : tools.filter((at) => at.tool.id !== SKILL_TOOL_ID);
  const allowedTools = withoutSkillTool(await resolveAgentTools(agentId, { ...options, access }));
  const executionTools =
    access.mode === 'allow_list'
      ? withoutSkillTool(await resolveAgentToolsForExecution(agentId, options))
      : allowedTools;
  const advertiseAllowedOnly =
    access.mode === 'allow_list'
      ? (await Agents.findById(agentId))?.toolAccessAdvertiseAllowedOnly === true
      : false;
  return {
    allowedTools,
    executionTools,
    advertisedTools: selectAdvertisedAgentTools({
      allowedTools,
      executionTools,
      access,
      advertiseAllowedOnly,
    }),
  };
}
