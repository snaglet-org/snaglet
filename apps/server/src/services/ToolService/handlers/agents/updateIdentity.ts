import { Agents } from '@snaglet/db';
import { invalidateAll as invalidateCache } from '@server/services/ConfigResolverService';
import { emitAgentRowChanges } from '@server/realtime/surfaces/agents';
import type { ToolHandler } from '@server/services/ToolService/types';
import { HELPER_ROW_EDIT_REFUSAL } from '@server/services/subagents/subagentText';

const tool: ToolHandler = async (input, _settings, context) => {
  const contextAgentId = String(context?.agentId ?? '');
  const requestedAgentId = input.agent_id !== undefined ? String(input.agent_id) : null;
  const agentId = requestedAgentId ?? contextAgentId;
  if (!agentId) throw new Error('agent_id is required');
  // Self-only guard scope (deliberate): the guard needs a contextAgentId to
  // compare against, so it only fires on agent-driven runs (the socket
  // dispatch loop always sets ctx.agentId). Without context (a user on the
  // panel's /api/tools/execute without act_as_agent_id), an explicit
  // input.agent_id can target any agent: user-mode admin capability,
  // attributed to the user by the actor-context middleware. Pinned by
  // tests/unit/apps/server/services/tools/update-identity-tool.test.ts.
  if (contextAgentId && requestedAgentId && requestedAgentId !== contextAgentId) {
    throw new Error('update_identity may only update the current agent');
  }

  const agent = await Agents.findById(agentId);
  if (!agent) throw new Error(`agent not found: ${agentId}`);
  // A subagent helper does not rewrite its own Snaglet helper prompt or role; its
  // orchestrator changes its instructions (subagent op:update).
  if (agent.parentAgentId && contextAgentId && !context?.bypassToolAccess) {
    throw new Error(HELPER_ROW_EDIT_REFUSAL);
  }

  const updatedFields: string[] = [];
  const patch: Parameters<typeof Agents.update>[1] = {};
  const written: Array<'role' | 'identity' | 'systemPrompt'> = [];

  if (input.role !== undefined) {
    patch.role = String(input.role);
    updatedFields.push('role');
    written.push('role');
  }
  if (input.identity !== undefined) {
    patch.identity = String(input.identity);
    updatedFields.push('identity');
    written.push('identity');
  }
  if (input.system_prompt !== undefined) {
    patch.systemPrompt = String(input.system_prompt);
    updatedFields.push('system_prompt');
    written.push('systemPrompt');
  }

  if (written.length > 0) {
    // One write, read back: the announced revision must be the written row's
    // updated_at, or an open agent pane would take the change for one it holds.
    const after = await Agents.update(agentId, patch);
    if (!after) throw new Error(`agent not found: ${agentId}`);
    invalidateCache();
    emitAgentRowChanges(agentId, agent, after, written);
  }

  return `Successfully updated [${updatedFields.join(', ')}] for agent "${agent.name}" (${agent.id}).`;
};

export default tool;
