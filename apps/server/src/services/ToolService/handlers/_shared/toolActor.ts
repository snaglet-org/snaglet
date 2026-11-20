import type { Actor } from '@snaglet/shared/types/workspace-events';
import { getCurrentActor } from '@server/realtime/actorContext';

/**
 * The actor a generic tool acts as: the ambient actor, or the handler
 * context's agent when no actor is bound (never a tool argument).
 */
export function toolActor(context: { agentId?: string } | undefined): Actor | undefined {
  const actor = getCurrentActor();
  if (actor) return actor;
  const agentId = context?.agentId?.trim();
  return agentId ? { actorKind: 'agent', actorId: agentId } : undefined;
}
