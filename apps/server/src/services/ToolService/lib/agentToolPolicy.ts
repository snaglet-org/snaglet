/**
 * agentToolPolicy — the tool-access policy an agent's calls are judged by, in
 * one place for every path that runs a tool as an agent: chat (through
 * AgentToolResolver), the executor-level action gateway, and
 * `/api/tools/execute`.
 *
 * A subagent helper is judged by its orchestrator's live access,
 * narrowed by its own row (resolveHelperToolPolicy), and never gets
 * SUBAGENT_DENIED_TOOL_IDS. A helper whose orchestrator or subagents row is
 * gone has nothing to inherit, so it gets an empty allow list (only the
 * always-available tools), never its own row's access. The ghost system actor
 * is judged by GHOST_TOOL_ACCESS, never its row. Every other agent is judged by
 * its own row.
 */

import { Agents, type AgentRow } from '@snaglet/db/tables/agents';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import type { ToolAccessConfig } from '@snaglet/shared/types';
import {
  resolveHelperToolPolicy,
  type HelperToolPolicy,
} from '@server/services/subagents/helperInheritance';
import { evaluateHeadlessToolCall, type VisibilityToolRow } from './toolVisibility';
import type { PermissionVerdict } from './toolPermission';

export interface AgentToolPolicy {
  /** The access the agent's calls are judged by. */
  access: ToolAccessConfig;
  /** True for a subagent helper. */
  helper: boolean;
  /** A helper's inherited policy (orchestrator, overrides), when it resolves. */
  helperPolicy: HelperToolPolicy | null;
}

/** What a helper with no orchestrator policy to inherit may use: nothing listed. */
export function orphanedHelperAccess(): ToolAccessConfig {
  return { mode: 'allow_list', allowList: [], denyList: [] };
}

/**
 * What the ghost system actor may call. A hook whose event carries
 * no agent (schedules, table-entry changes, signals) runs as
 * ghost, and ghost's row has no access mode, which would read as `all`: every
 * such hook could run shell, raw SQL writes or agent admin. Ghost's row cannot
 * be edited (AgentService refuses), so its policy lives here, in code.
 *
 * Exactly what the installed agentless hooks call: table read/query/write,
 * thread send/read and database_query
 * (read-only by construction). `thread_send`/`thread_read` pin
 * those ops, so a hook cannot create, update or delete threads. A run:end hook
 * runs as the agent whose run ended, not ghost, so `agent` is not needed.
 * Search and the clock stay available, as for every allow list.
 *
 * A new hook that needs another tool adds it here as part of its review.
 */
export const GHOST_TOOL_ACCESS: Readonly<ToolAccessConfig> = Object.freeze({
  mode: 'allow_list',
  allowList: ['table', 'thread_send', 'thread_read', 'database_query'],
  denyList: [],
});

/** The agent row's own access, as stored. */
function ownAccess(agent: AgentRow): ToolAccessConfig {
  return {
    mode: (agent.toolAccessMode as ToolAccessConfig['mode']) ?? 'all',
    allowList: Array.isArray(agent.toolAccessAllowList) ? agent.toolAccessAllowList : [],
    denyList: Array.isArray(agent.toolAccessDenyList) ? agent.toolAccessDenyList : [],
  };
}

export async function resolveAgentToolPolicy(agent: AgentRow): Promise<AgentToolPolicy> {
  const helper = Boolean(agent.parentAgentId);
  const helperPolicy = helper ? await resolveHelperToolPolicy(agent.id, agent) : null;
  const access =
    agent.id === GHOST_AGENT_ID
      ? { ...GHOST_TOOL_ACCESS, allowList: [...GHOST_TOOL_ACCESS.allowList] }
      : (helperPolicy?.access ?? (helper ? orphanedHelperAccess() : ownAccess(agent)));
  return { access, helper, helperPolicy };
}

/**
 * Judge one call agent `agentId` makes with nobody to ask (see
 * evaluateHeadlessToolCall): its policy's visibility plus the per-call engine.
 * An id with no agent row behind it (deleted after a child-dispatch token
 * was minted for it, or never created) has no policy to judge by, so the
 * call is denied, never run ungated.
 */
export async function evaluateAgentHeadlessToolCall(
  agentId: string,
  tool: VisibilityToolRow,
  input: Record<string, unknown>,
  options: { activeToolIds: ReadonlySet<string>; cwd?: string }
): Promise<PermissionVerdict> {
  const agent = await Agents.findById(agentId);
  if (!agent) {
    return {
      decision: 'deny',
      reason: `no agent \`${agentId}\` exists (deleted, or never created), so \`${tool.id}\` cannot run as it.`,
    };
  }
  const policy = await resolveAgentToolPolicy(agent);
  return evaluateHeadlessToolCall(policy.access, tool, input, {
    ...options,
    helper: policy.helper,
  });
}
