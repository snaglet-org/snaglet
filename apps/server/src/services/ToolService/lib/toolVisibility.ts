/**
 * toolVisibility — which tools an agent's access policy lets it use at all,
 * and the one gate for calls nobody can be asked about.
 *
 * Visibility is the tool-level half of tool access: an allow-list agent sees
 * only the tools its list names, a deny-list or All agent loses only the
 * tools a bare deny names (or whose every op is denied), a subagent helper
 * never gets SUBAGENT_DENIED_TOOL_IDS, and a live MCP tool follows its
 * server's enablement instead. Entries name a tool by id
 * or display name through ruleNamesTool, like every other access path.
 * AgentToolResolver filters every agent's tool set with `isToolVisible` (so
 * chat, schedules, tool(op:search) and the action gateway see the same set), and
 * the per-call engine (evaluateToolPermission) then judges each call's input.
 *
 * In chat, an allow-list agent may still name a hidden tool: dispatch asks a
 * person first (allow-list escalation). A call with nobody to ask —
 * `/api/tools/execute` (SDK scripts, hook and workspace-tool children) and the
 * executor-level action gateway — goes through `evaluateHeadlessToolCall`
 * instead, which refuses it.
 *
 * Pure (no DB, no I/O).
 */

import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import { SUBAGENT_DENIED_TOOL_IDS } from '@snaglet/shared/constants';
import {
  isPlainNameAlias,
  ruleNamesTool,
  scopeRule,
  TOOL_OP_PARAM,
  toolIdsEquivalent,
  type ToolRuleSide,
} from '@snaglet/shared/utils';
import { isAllowListExemptTool, isAlwaysAvailableTool } from './alwaysAvailableTools';
import { evaluateToolPermission, parseRule, type PermissionVerdict } from './toolPermission';

/** The tool fields visibility reads. */
export type VisibilityToolRow = Pick<
  ToolRow,
  'id' | 'name' | 'type' | 'aliases' | 'parametersSchema'
>;

export interface ToolVisibilityOptions {
  /** True for a subagent helper (agents.parent_agent_id set). */
  helper?: boolean;
}

/**
 * Whether a stored entry's tool id names `tool`: its id or display name, read
 * as every access path reads them (ruleNamesTool), or an alias id that
 * resolves to it when no active tool has that id.
 */
export function identifiersMatch(
  configuredId: string,
  tool: Pick<ToolRow, 'id' | 'name'>,
  activeToolIds: ReadonlySet<string>,
  side: ToolRuleSide
): boolean {
  if (ruleNamesTool(configuredId, tool, side, { activeToolIds })) return true;
  // An alias id and its canonical target may both be real, distinct active
  // tools; an exact active id keeps its own meaning. Alias equivalence applies
  // only when the alias id is not an active tool.
  return !activeToolIds.has(configuredId) && toolIdsEquivalent(configuredId, tool.id);
}

/** The `op` enum an op tool declares, or [] for single-op tools. */
export function toolOpEnum(tool: Pick<ToolRow, 'parametersSchema'>): string[] {
  const schema = tool.parametersSchema as
    | { properties?: Record<string, { enum?: unknown }> }
    | null
    | undefined;
  const values = schema?.properties?.[TOOL_OP_PARAM]?.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Whether an agent with this access may use `tool` at all. Availability
 * (enabled flag, credentials, connections) is separate; resolveAgentTools
 * applies both.
 */
export function isToolVisible(
  tool: VisibilityToolRow,
  access: ToolAccessConfig,
  activeToolIds: ReadonlySet<string>,
  options: ToolVisibilityOptions = {}
): boolean {
  // A subagent helper never gets the denied set, whatever its access mode: an
  // allow list alone would leave core tools reachable behind the ask.
  if (options.helper && SUBAGENT_DENIED_TOOL_IDS.has(tool.id)) return false;
  // Search and the clock are safe platform primitives. Every tool-capable
  // agent needs them advertised even when its policy is otherwise restrictive.
  if (isAlwaysAvailableTool(tool.id)) return true;
  // A live MCP tool is gated by its server's enablement for the agent, applied
  // when the agent's tool set is resolved (resolveAgentTools), not by the
  // allow list. A bare deny naming it still blocks it per call.
  if (tool.type === 'mcp') return true;
  // List entries may carry a Claude-Code-style specifier (e.g. `shell_exec(git:*)`);
  // tool VISIBILITY keys off the tool id only — the specifier is enforced per-call
  // in evaluateToolPermission at dispatch time.
  if (access.mode === 'allow_list') {
    if (isAllowListExemptTool(tool.id)) return true;
    if (access.allowList.length === 0) return false;
    return access.allowList.some((entry) => {
      const { toolId } = parseRule(entry);
      return identifiersMatch(toolId, tool, activeToolIds, 'allow');
    });
  }
  // All and deny-list mode: the deny list applies in every mode.
  if (access.denyList.length === 0) return true;
  // Only a bare deny entry removes the tool entirely. A specifier'd deny
  // (e.g. `shell_exec(rm:*)`) leaves the tool visible and is enforced per-call.
  // An op-scoped deny (an old id that maps to one op of a tool, e.g.
  // `memory_forget` → memory(op:delete)) hides the tool only when every op
  // is denied; otherwise it is enforced per-call by evaluateOpAccess.
  // A bare entry naming one of the tool's plain definition names (`bash` for
  // shell) denies the tool too, as chat dispatch and the permission engine do.
  // An old id that pins only a non-op param (git_push) denies the whole tool:
  // pins never narrow a deny.
  const deniedOps = new Set<string>();
  const wholeToolDenied = access.denyList.some((entry) => {
    const { toolId, specifier } = parseRule(entry);
    if (specifier !== null) return false;
    if (isPlainNameAlias(toolId, tool.aliases, { activeToolIds })) return true;
    if (!identifiersMatch(toolId, tool, activeToolIds, 'deny')) return false;
    const scoped = scopeRule(entry, { activeToolIds });
    if (scoped.ops) {
      scoped.ops.forEach((op) => deniedOps.add(op));
      return false;
    }
    if (scoped.op === null) return true;
    deniedOps.add(scoped.op);
    return false;
  });
  if (wholeToolDenied) return false;
  if (deniedOps.size === 0) return true;
  const ops = toolOpEnum(tool);
  return !(ops.length > 0 && ops.every((op) => deniedOps.has(op)));
}

/**
 * The bare deny entry chat dispatch refuses a call on, in every access mode,
 * All included: one with no rule naming the tool by its id or display name in
 * any case, or by any of its definition names (`aliases`; an old id listed
 * there denies the whole tool here). Search and the clock are never denied.
 * The headless gate applies the same check, so every bare deny chat honors
 * holds on `/api/tools/execute` and the action gateway too.
 */
export function bareDenyEntryFor(
  denyList: readonly string[],
  tool: Pick<ToolRow, 'id' | 'name' | 'aliases'>
): string | undefined {
  if (isAlwaysAvailableTool(tool.id)) return undefined;
  const names = new Set(
    [tool.id, tool.name, ...(tool.aliases ?? [])].map((name) => name.toLowerCase())
  );
  return denyList.find((entry) => {
    const rule = parseRule(entry);
    return rule.specifier === null && names.has(rule.toolId.toLowerCase());
  });
}

export interface HeadlessToolCallOptions extends ToolVisibilityOptions {
  /** Live catalog ids, for old-id resolution (the tool registry's ids). */
  activeToolIds: ReadonlySet<string>;
  cwd?: string;
}

/**
 * `action` routes a call to another tool; it is not a capability of its own.
 * Chat never gates it by visibility, and neither does the headless gate: the
 * executor-level gateway runs this same gate on its target.
 */
const ROUTER_TOOL_ID = 'action';

/**
 * The access gate for one call an agent makes with nobody to ask: chat's
 * bare-deny check first (it holds in every mode, All included), then the
 * per-call engine (so a deny reads as its rule), then visibility. A tool the
 * agent cannot see is refused, never escalated: an allow-list agent calling a
 * tool its list does not name gets `deny` here where chat would ask a person.
 * An `ask` verdict comes back as is; every caller treats anything but `allow`
 * as a refusal.
 */
export function evaluateHeadlessToolCall(
  access: ToolAccessConfig,
  tool: VisibilityToolRow,
  input: Record<string, unknown>,
  options: HeadlessToolCallOptions
): PermissionVerdict {
  const bareDeny = bareDenyEntryFor(access.denyList, tool);
  if (bareDeny !== undefined) {
    return {
      decision: 'deny',
      rule: bareDeny,
      reason: `\`${tool.id}\` is denied for this agent (rule \`${bareDeny}\`).`,
    };
  }
  const verdict = evaluateToolPermission(access, tool.id, input, {
    cwd: options.cwd,
    activeToolIds: options.activeToolIds,
    toolAliases: tool.aliases,
    toolName: tool.name,
  });
  if (verdict.decision === 'deny' || tool.id === ROUTER_TOOL_ID) return verdict;
  if (isToolVisible(tool, access, options.activeToolIds, options)) return verdict;
  const helperDenied = options.helper === true && SUBAGENT_DENIED_TOOL_IDS.has(tool.id);
  return {
    decision: 'deny',
    reason: helperDenied
      ? `\`${tool.id}\` is not available to a subagent helper.`
      : access.mode === 'allow_list'
        ? `\`${tool.id}\` is not in this agent's tool list.`
        : `\`${tool.id}\` is denied for this agent.`,
  };
}
