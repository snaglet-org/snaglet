/**
 * hookRunAs — which agents a hook may run as.
 *
 * A hook whose event carries no agent runs as the ghost system actor, under
 * GHOST_TOOL_ACCESS. `hook_registrations.run_as_agent_id` names an agent it
 * acts as instead: the child's dispatch credential is bound to that agent, so
 * the agent's own tool access judges every call (never wider), and what the
 * hook posts or writes is attributed to it.
 *
 * The same rules hold when the setting is saved (the hook editor, the REST
 * route, `hook` op `run_as`) and again before every run, because an agent can
 * be archived or deleted after it was picked.
 */

import { Agents, type AgentRow } from '@snaglet/db/tables/agents';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';

export type HookRunAsResolution = { ok: true; agent: AgentRow } | { ok: false; problem: string };

/**
 * Why `agent` cannot be a hook's run-as agent, as a clause (`agent "<name>"
 * is archived`), or null when it can. `ref` names what was asked for when no
 * agent row was found.
 */
export function hookRunAsProblem(agent: AgentRow | null, ref: string): string | null {
  if (!agent) return `no agent "${ref}" exists`;
  if (agent.id === GHOST_AGENT_ID) {
    return 'ghost is the system actor every hook already runs as by default; clear run as instead';
  }
  if (agent.archived) return `agent "${agent.name}" is archived`;
  if (agent.parentAgentId) return `"${agent.name}" is a subagent helper, not a top-level agent`;
  return null;
}

/** Resolve an agent id or name for a hook's run as: the agent, or why it cannot be one. */
export async function resolveHookRunAsAgent(ref: string): Promise<HookRunAsResolution> {
  const wanted = ref.trim();
  const agent = (await Agents.findById(wanted)) ?? (await Agents.findByName(wanted));
  const problem = hookRunAsProblem(agent, wanted);
  if (problem !== null || !agent) return { ok: false, problem: problem ?? `no agent "${wanted}"` };
  return { ok: true, agent };
}

/**
 * The run-time check: null when a run may act as `agentId`, else the clause
 * saying why not (archived or deleted since it was set).
 */
export async function checkHookRunAsAgent(agentId: string): Promise<string | null> {
  return hookRunAsProblem(await Agents.findById(agentId), agentId);
}

/** The 400 a save naming an unusable agent gets ("Can't run this hook as …: …"). */
export function hookRunAsSaveError(ref: string, problem: string): AppError {
  return new AppError(
    `Can't run this hook as "${ref.trim()}": ${problem}.`,
    ErrorCode.VALIDATION_ERROR,
    HTTP_STATUS.BAD_REQUEST
  );
}

/** The 409 a hook with no ready build gets: run as covers a build, so build it first. */
export function hookRunAsNotBuiltError(hookName: string): AppError {
  return new AppError(
    `Hook "${hookName}" has no ready build, and Run as covers the code that is built. Save it so it builds, then set Run as.`,
    ErrorCode.CONFLICT,
    HTTP_STATUS.CONFLICT
  );
}
