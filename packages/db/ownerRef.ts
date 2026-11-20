/**
 * ownerRef — the memories owner discriminant.
 *
 * A memory is owned by an agent or a member (a human user), exactly one of
 * the two; the DB enforces this with the `memories_owner_xor_chk` CHECK.
 * This is the TS-side mirror, so query methods can be scoped by whichever
 * owner applies without forking their SQL per owner kind.
 *
 * `OwnerArg` also accepts a bare agent-id string (normalized to
 * `{ agentId }`); member-owned callers pass `{ memberId }`.
 */

export type OwnerRef =
  | { agentId: string; memberId?: undefined }
  | { agentId?: undefined; memberId: string };

/** Accepted shape for an owner-scoped query argument. */
export type OwnerArg = string | OwnerRef;

/** Normalize a bare agent-id string into an OwnerRef. */
export function normalizeOwner(owner: OwnerArg): OwnerRef {
  return typeof owner === 'string' ? { agentId: owner } : owner;
}

/**
 * The column that scopes a query to this owner. Only ever returns one of
 * these two literals (never derived from external input), so interpolating
 * it directly into SQL text is safe — the id itself is still always a bound
 * parameter, never interpolated.
 */
export function ownerColumn(owner: OwnerRef): 'agent_id' | 'member_id' {
  return owner.agentId !== undefined ? 'agent_id' : 'member_id';
}

/** The id value to bind alongside `ownerColumn(owner)`. */
export function ownerId(owner: OwnerRef): string {
  return (owner.agentId ?? owner.memberId) as string;
}
