/**
 * Thread-participant rows reach handlers in either casing depending on the
 * query path (camelCase from the model layer, snake_case from raw SQL), so
 * reading the agent id needs both. One helper for every thread handler that
 * does it.
 */
export function participantAgentId(participant: {
  agentId?: string | null;
  agent_id?: string | null;
}): string | null {
  return participant.agentId ?? participant.agent_id ?? null;
}
