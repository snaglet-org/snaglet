/**
 * actorMember — actor→member resolution seam for attribution stamps.
 *
 * `created_by` / `last_edited_by` (docs, containers) are FKs to members(id),
 * but the ambient actor id (getCurrentActor().actorId) is a user or agent id,
 * so model writes resolve it to a members.id here at write time.
 *
 * packages/db cannot read the server-only actor context, so this is an
 * injection slot: apps/server registers the resolver at boot
 * (registerActorMemberResolver). With no resolver (CLI, migrations, tests)
 * the stamp is null, an honest "system" stamp.
 */

export type ActorMemberResolver = () => Promise<string | null>;

let resolver: ActorMemberResolver | null = null;

/** Register (or clear, with null) the ambient actor→member resolver. */
export function setActorMemberResolver(fn: ActorMemberResolver | null): void {
  resolver = fn;
}

/**
 * Resolve the current actor's members.id, or null when there is no resolver /
 * no bound actor / the actor maps to no member. Never throws — a failed lookup
 * degrades to a null (unattributed) stamp rather than failing the write.
 */
export async function currentActorMemberId(): Promise<string | null> {
  if (!resolver) return null;
  try {
    return await resolver();
  } catch {
    return null;
  }
}
