/**
 * Whose memories the `search` tool may return: the calling agent's own, plus
 * the kept facts about the calling thread's human (member-owned, active) —
 * the same rule as automatic recall. Never a proposal waiting for approval,
 * never another agent's memory. With no calling agent there is no scope, and
 * every memory branch matches nothing (the SQL params are null).
 */

import { resolveProposalMemberId } from '@server/services/summary/threadHuman';

export interface MemorySearchScope {
  agentId: string;
  /** The calling thread's single human, whose kept facts are searchable too. */
  memberId: string | null;
}

/**
 * The predicate a memory row (alias `alias`) must pass. `agentParam` and
 * `memberParam` are the positional params bound by {@link memoryScopeParams};
 * a null param matches nothing, so a missing scope admits no memory.
 */
export function memoryScopeSql(alias: string, agentParam: number, memberParam: number): string {
  return `(${alias}.status <> 'proposed' AND (${alias}.agent_id = $${agentParam}::text OR ${alias}.member_id = $${memberParam}::text))`;
}

/** The two params {@link memoryScopeSql} references, agent first. */
export function memoryScopeParams(
  scope: MemorySearchScope | null | undefined
): [string | null, string | null] {
  return [scope?.agentId ?? null, scope?.memberId ?? null];
}

/** The scope for a tool call, from its context; null without a calling agent. */
export async function resolveMemorySearchScope(
  context:
    | {
        agentId?: string | null;
        threadId?: string | null;
      }
    | null
    | undefined
): Promise<MemorySearchScope | null> {
  const agentId = context?.agentId;
  if (!agentId) return null;
  const memberId = context?.threadId
    ? await resolveProposalMemberId(context.threadId).catch(() => null)
    : null;
  return { agentId, memberId };
}
