/**
 * Add one tool to an agent's allow-list and announce it.
 *
 * The "Always allow" answer on a tool prompt and a subagent helper's grant
 * write the allow-list directly (an atomic append, so two prompts answered at
 * once both land) rather than through agentService.update. This wrapper keeps
 * them on the same realtime contract: `agent.updated` naming
 * `toolAccessAllowList` with the written revision, so an open agent pane shows
 * the new tool without a reload. Appending a tool that is already listed
 * changes nothing and announces nothing.
 */

import { Agents, type AgentRow } from '@snaglet/db';
import { emitAgentRowChanges } from '@server/realtime/surfaces/agents';

/** Returns the agent row after the write, or null when the agent does not exist. */
export async function appendAgentToolAllowList(
  agentId: string,
  toolId: string
): Promise<AgentRow | null> {
  const before = await Agents.findById(agentId);
  if (!before) return null;
  const appended = await Agents.appendToolAccessAllowList(agentId, toolId);
  if (!appended) return null;
  const after = await Agents.findById(agentId);
  if (!after) return null;
  // The append's own revision: the read-back may already show a later write.
  emitAgentRowChanges(agentId, before, { ...after, updatedAt: appended.updatedAt }, [
    'toolAccessAllowList',
  ]);
  return after;
}
