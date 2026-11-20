import type { ToolHandlerContext } from './types';
import type { OwnerRef } from '@snaglet/db';
import { getCurrentActor } from '@server/realtime/actorContext';
import { resolveCurrentActorMemberId } from '@server/realtime/actorMember';

export function requireAgentId(context: ToolHandlerContext | undefined, toolName: string): string {
  if (!context?.agentId) {
    throw new Error(`${toolName} requires agent context`);
  }
  return context.agentId;
}

/**
 * Resolve who owns a memory store/search/forget call — an agent XOR a member
 * (a human user; see @snaglet/db/ownerRef and the memories owner-XOR CHECK).
 *
 * Resolution order (agent ctx → user actor → error):
 *   1. `context.agentId` — the normal agent-run path (unchanged). A live
 *      agent turn always has this set (toolDispatch.ts wraps every tool
 *      execution in `runWithActor({ actorKind: 'agent', ... })` AND passes
 *      `agentId` on the context), so this branch is hit exactly as before.
 *   2. No agent context — check the ambient actor bound by
 *      actorContextMiddleware for the current HTTP request (or by whatever
 *      wrapped this call in `runWithActor`). If it resolves to a real human
 *      user (`actorKind === 'user'`), store/recall/forget under THAT USER's
 *      member id, resolved via `resolveCurrentActorMemberId()` — the same
 *      actor→member seam `edit_doc` already uses for attribution (see
 *      apps/server/src/realtime/actorMember.ts). This is what lets
 *      panel/user-run calls (no agent turn, so no ctx.agentId) succeed
 *      instead of throwing.
 *   3. Neither resolves — no agent context, no user actor, or a user actor
 *      whose member row can't be found (shouldn't happen in practice: every
 *      user gets one via Members.ensureForUser at creation, but a resolver
 *      miss degrades to the same safe error rather than a broken owner) —
 *      throw the exact same "requires agent context" error as before, so
 *      existing error-path callers/tests keep working unchanged.
 */
export async function resolveMemoryOwner(
  context: ToolHandlerContext | undefined,
  toolName: string
): Promise<OwnerRef> {
  if (context?.agentId) return { agentId: context.agentId };

  const actor = getCurrentActor();
  if (actor?.actorKind === 'user') {
    const memberId = await resolveCurrentActorMemberId();
    if (memberId) return { memberId };
  }

  throw new Error(`${toolName} requires agent context`);
}
