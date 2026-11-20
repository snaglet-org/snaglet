/**
 * Agent realtime surface.
 *
 * Agents are actors, not workspace nodes, so they do not travel on the
 * `workspace.updated` node patch. They get their own event on the same
 * `workspace` channel, which is what makes a second window update without
 * subscribing to anything new.
 *
 * `agent.updated` is an invalidation signal and carries no agent fields. See
 * the type's docblock for why: shipping values here would create a second
 * source of truth that can disagree with the row the receiver already holds,
 * and every future agent field would have to be added to the event too.
 *
 * It does carry the row's revision (`updatedAt` after the write) when the
 * emitter has the written row, so an open agent pane can tell its own save's
 * echo (a revision it already holds) from a change made somewhere else.
 *
 * Every write that changes an agent announces it here: agentService
 * create/update/archive/restore/purge, the update_identity tool, the tool
 * assignment routes, an "Always allow" grant (services/agentToolAllowList.ts),
 * credential repoints, MCP server delete and restore, and the agent's general
 * skills (SkillAssignmentService.replaceGeneral).
 */

import { emitWorkspaceEvent } from '@server/realtime/emit';

/**
 * Announce that an agent changed.
 *
 * `changed` must name the fields that actually differed, not every field the
 * request mentioned — a PATCH that re-sends an identical role is a no-op and
 * has nothing to invalidate. Callers that cannot tell should not call this.
 * `updatedAt` is the agent row's revision after the write; leave it out when
 * the write did not touch the row or the row is not at hand.
 *
 * No-ops are dropped here rather than at each call site, so a caller cannot
 * accidentally emit an empty invalidation that makes every receiver refetch
 * for nothing.
 */
export function emitAgentUpdated(agentId: string, changed: string[], updatedAt?: string): void {
  if (!agentId || changed.length === 0) return;
  emitWorkspaceEvent({
    type: 'agent.updated',
    agentId,
    changed,
    ...(updatedAt ? { updatedAt } : {}),
  });
}

/**
 * Announce the fields that differ between two snapshots of one agent row.
 *
 * Values are compared structurally, so re-writing an identical list or
 * override map is not a change and emits nothing. A missing `before` (the
 * caller could not read the prior row) counts every named field as changed.
 * `after` must be the row read back after the write: its `updatedAt` is the
 * revision the event carries. A hand-built copy of the old row would announce
 * a revision receivers already hold, and they would skip the change.
 */
export function emitAgentRowChanges<Row extends { updatedAt?: string | null }>(
  agentId: string,
  before: Row | null | undefined,
  after: Row,
  fields: ReadonlyArray<keyof Row & string>
): void {
  const changed = fields.filter(
    (field) => !before || JSON.stringify(before[field]) !== JSON.stringify(after[field])
  );
  emitAgentUpdated(agentId, changed, after.updatedAt ?? undefined);
}

/**
 * Announce that an agent was created.
 *
 * Reuses `agent.updated` with the `'created'` lifecycle marker rather than a
 * new event type: every receiver reacts to agent changes the same way (refetch
 * the roster), so a distinct event would just force each of them to subscribe
 * twice for one behavior.
 */
export function emitAgentCreated(agentId: string): void {
  if (!agentId) return;
  emitWorkspaceEvent({ type: 'agent.updated', agentId, changed: ['created'] });
}

/** Announce that an agent was deleted (ghost purge). Same reuse rationale as create. */
export function emitAgentDeleted(agentId: string): void {
  if (!agentId) return;
  emitWorkspaceEvent({ type: 'agent.updated', agentId, changed: ['deleted'] });
}
