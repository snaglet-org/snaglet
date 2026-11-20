/**
 * partitionArchivedParticipants — split a participant-id list into live vs
 * archived agents.
 *
 * Archived agents stay in `thread_participants` for history ("who was in
 * this thread"), and their messages/runs keep their attribution — but they must
 * never dispatch, be a mention target, or be woken. Both dispatch roster
 * builders funnel their raw participant ids through here so the
 * archived-exclusion rule lives in exactly one place:
 *   - the socket chat path  (handlers/chatHandlers.ts)
 *   - the non-socket tool path (dispatch/buildDispatchDeps.ts)
 *
 * Relies on `Agents.findByIds`, whose per-id contract surfaces `archived` on
 * every row (listings filter archived out; per-id lookups do not — AgentModel).
 * An id that resolves to no agent row at all (deleted mid-thread) is treated as
 * live here and simply drops out downstream when its config fails to load — the
 * archived filter is intentionally narrow: it excludes agents that exist but are
 * archived, nothing else.
 */

import { Agents } from '@snaglet/db/tables/agents';

export interface PartitionedParticipants {
  /** Ids safe to dispatch/mention/wake (order preserved from the input). */
  liveIds: string[];
  /** Ids dropped because their agent row is archived. */
  archivedIds: string[];
}

export async function partitionArchivedParticipants(
  rawParticipantIds: string[]
): Promise<PartitionedParticipants> {
  if (rawParticipantIds.length === 0) return { liveIds: [], archivedIds: [] };
  const rows = await Agents.findByIds(rawParticipantIds);
  const archived = new Set(rows.filter((r) => r.archived).map((r) => r.id));
  if (archived.size === 0) {
    return { liveIds: rawParticipantIds, archivedIds: [] };
  }
  return {
    liveIds: rawParticipantIds.filter((id) => !archived.has(id)),
    archivedIds: rawParticipantIds.filter((id) => archived.has(id)),
  };
}
