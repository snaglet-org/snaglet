/**
 * actorMember (server) — resolve the ambient actor to its members.id.
 *
 * The attribution columns (docs/containers created_by + last_edited_by) are FK
 * → members(id), but the ambient actor id is a USER id (`actorKind: 'user'`,
 * users.id) or an agent id (`actorKind: 'agent'`, agents.id) — not a members.id.
 * This maps it to the member id via the unique agent_id / user_id keys.
 *
 * Registered into @snaglet/db's resolver seam at boot (registerActorMemberResolver)
 * so the model create/update chokepoints can stamp a real member id without
 * packages/db reaching into the server-only actor context.
 */

import type { Actor } from '@snaglet/shared/types/workspace-events';
import { Members, setActorMemberResolver } from '@snaglet/db';
import { getCurrentActor } from './actorContext';

// Principal→member is a stable mapping (ensureForAgent/ensureForUser are
// idempotent and never reassign a member id; a deleted principal cannot act
// again), so a resolved id can be cached indefinitely. Keyed by kind:actorId.
const cache = new Map<string, string>();

/** Resolve a specific actor to its members.id, or null (system / unmapped). */
async function resolveActorMemberId(actor: Actor | undefined): Promise<string | null> {
  if (!actor) return null;
  const key = `${actor.actorKind}:${actor.actorId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let memberId: string | null = null;
  if (actor.actorKind === 'agent') {
    memberId = (await Members.findByAgent(actor.actorId))?.id ?? null;
  } else if (actor.actorKind === 'user') {
    memberId = (await Members.findByUser(actor.actorId))?.id ?? null;
  } else if (actor.actorKind === 'external') {
    // External MCP clients: actorId IS the members.id (kind='external' rows
    // have no agents/users principal to map through). Validate it resolves to
    // a real member so a bogus id degrades to unattributed, not a broken FK.
    memberId = (await Members.findById(actor.actorId))?.id ?? null;
  }
  // Only cache resolved ids: a null may be a not-yet-ensured member that a
  // later ensureForAgent/ensureForUser will create.
  if (memberId) cache.set(key, memberId);
  return memberId;
}

/** Resolve the ambient actor (getCurrentActor) to its members.id, or null. */
export function resolveCurrentActorMemberId(): Promise<string | null> {
  return resolveActorMemberId(getCurrentActor());
}

/** Wire the ambient resolver into @snaglet/db so model chokepoints can stamp. */
export function registerActorMemberResolver(): void {
  setActorMemberResolver(resolveCurrentActorMemberId);
}
