/**
 * agent(op: archive | restore) — soft-archive an agent or bring it back.
 *
 * Same service calls as the app (agentService.archive / restore): archive
 * hides the agent from rosters and pickers but keeps its history, memories
 * and threads; restore undoes it. There is no hard delete here — the ghost
 * purge stays a user action in the app.
 */
import { GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { getErrorMessage } from '@snaglet/shared/utils';
import { agentService } from '@server/services/AgentService';
import { invalidateAll as invalidateCache } from '@server/services/ConfigResolverService';
import type { ToolHandler } from '@server/services/ToolService/types';

function targetId(input: Record<string, unknown>): string {
  return typeof input.agent_id === 'string' ? input.agent_id.trim() : '';
}

export const archiveAgent: ToolHandler = async (input, _settings, context) => {
  const agentId = targetId(input);
  if (!agentId) return JSON.stringify({ success: false, error: 'agent_id is required' });
  if (agentId === GHOST_AGENT_ID) {
    return JSON.stringify({ success: false, error: 'The ghost system agent cannot be archived.' });
  }
  if (context?.agentId && context.agentId === agentId) {
    return JSON.stringify({ success: false, error: 'An agent cannot archive itself.' });
  }
  try {
    const agent = await agentService.archive(agentId);
    if (!agent)
      return JSON.stringify({ success: false, error: `No agent found with id '${agentId}'` });
    await invalidateCache();
    return JSON.stringify({
      success: true,
      agent_id: agent.id,
      name: agent.name,
      archived: true,
      message: `Agent "${agent.name}" archived. Its history is kept; op restore brings it back.`,
    });
  } catch (err) {
    return JSON.stringify({ success: false, error: getErrorMessage(err) });
  }
};

export const restoreAgent: ToolHandler = async (input) => {
  const agentId = targetId(input);
  if (!agentId) return JSON.stringify({ success: false, error: 'agent_id is required' });
  try {
    const agent = await agentService.restore(agentId);
    if (!agent)
      return JSON.stringify({ success: false, error: `No agent found with id '${agentId}'` });
    await invalidateCache();
    return JSON.stringify({
      success: true,
      agent_id: agent.id,
      name: agent.name,
      archived: false,
      message: `Agent "${agent.name}" restored.`,
    });
  } catch (err) {
    return JSON.stringify({ success: false, error: getErrorMessage(err) });
  }
};
