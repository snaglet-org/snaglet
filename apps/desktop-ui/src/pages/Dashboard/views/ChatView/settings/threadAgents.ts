import type { SnagletAgent } from '@snaglet/shared/types';
import { agentsApi, threadsApi } from '@desktop/utils/api';
import type { ThreadParticipant } from '@desktop/utils/api';
import { helperOwnerLabel } from '../Subagents/subagentText';
import type { AgentEntry } from './settings-types';

export interface ThreadAgents {
  participants: ThreadParticipant[];
  agentById: Map<string, SnagletAgent>;
}

/**
 * A thread's participants and the agent records they name. `GET /api/agents`
 * leaves subagent helpers (and archived agents) out, so a participant missing
 * from it is read by id. A tombstone, or a read that fails, stays missing.
 */
export async function loadThreadAgents(threadId: string): Promise<ThreadAgents> {
  const [participants, agents] = await Promise.all([
    threadsApi.listParticipants(threadId),
    agentsApi.list(),
  ]);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const missing = new Set(
    participants
      .filter((p) => p.kind === 'agent' && p.agentId && !agentById.has(p.agentId))
      .map((p) => p.agentId)
  );
  const resolved = await Promise.all(
    [...missing].map((id) => agentsApi.get(id).catch((): SnagletAgent | null => null))
  );
  for (const agent of resolved) {
    if (agent && !agent.deletedAt) agentById.set(agent.id, agent);
  }
  return { participants, agentById };
}

/** The agent participants of a thread, each with its record (null when it is gone). */
export function agentEntries({ participants, agentById }: ThreadAgents): AgentEntry[] {
  return participants
    .filter((p) => p.kind === 'agent')
    .map((p) => {
      const agent = agentById.get(p.agentId) ?? null;
      const orchestratorId = agent?.parentAgentId ?? null;
      return {
        participant: p,
        agent,
        orchestratorName: orchestratorId ? (agentById.get(orchestratorId)?.name ?? null) : null,
      };
    });
}

/** The line under an agent's name: "Patty's subagent" for a helper, else its role. */
export function agentEntryRole(entry: AgentEntry): string | null {
  if (entry.agent?.parentAgentId) return helperOwnerLabel(entry.orchestratorName ?? null);
  return entry.agent?.role ?? null;
}
