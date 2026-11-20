import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitParticipantRemovedEvent } from '@server/services/SocketService/threadEvents';
import { markThreadRosterChanged } from '@server/services/SocketService/dispatch/rosterVersion';
import { participantAgentId } from './handlers/participantAgentId';

export interface RemoveAgentParticipantInput {
  threadId: string;
  agentId: string;
  /** The agent that asked for the removal, for the activity log. */
  actorAgentId?: string | null;
  actorUserId?: string | null;
}

/**
 * Take one agent out of a thread. The one path behind the app's Remove button
 * (DELETE /threads/:id/participants/:agentId) and the `thread` tool's `leave`
 * and `remove_agents` ops, so all three leave the same trace:
 *
 * - the participant row goes, by its own primary key, with the agent's skill
 *   picks for this thread (a later re-add starts clean);
 * - an activity-log entry, when an acting agent is known;
 * - the "[participant removed · <Name> left the thread]" roster line, which
 *   also tells the open chat to reload its participant list;
 * - a roster bump, so a run going on in the thread stops routing mentions to
 *   them (SocketService/dispatch/liveRoster.ts).
 *
 * Returns false when the agent is not a participant. Thread-level rules (DM,
 * subagent thread, who may remove whom) stay with each caller.
 */
export async function removeAgentParticipant(input: RemoveAgentParticipantInput): Promise<boolean> {
  const { threadId, agentId } = input;
  const participants = await ThreadParticipants.listByThread(threadId);
  const participant = participants.find((candidate) => participantAgentId(candidate) === agentId);
  if (!participant) return false;

  // Remove by the participant row's own primary key, not the agent id: the row
  // is already resolved, so a listed participant is always removable.
  const removed = await ThreadParticipants.removeById(participant.id);
  if (!removed) return false;
  // A run in this thread re-reads its roster, so a mention no longer wakes them.
  markThreadRosterChanged(threadId);
  // Participant overrides live on the thread_participants row itself, so they
  // go with it (FK cascade).

  const actorAgentId = input.actorAgentId ?? null;
  if (actorAgentId) {
    void AgentActivityLog.logActivity({
      agentId: actorAgentId,
      actionType: 'tool_call',
      triggerType: 'manual',
      reason: `Removed participant ${agentId} from thread ${threadId}`,
      tool: 'threads.remove_participant',
      toolInput: {
        threadId,
        removedAgentId: agentId,
        actorAgentId,
        actorUserId: input.actorUserId ?? null,
      },
      toolOutput: { removed: true },
    }).catch((err) => {
      logger.warn(`[threads] failed to log participant removal: ${getErrorMessage(err)}`);
    });
  }

  // Narrate the roster change as an append-only thread_event.
  void emitParticipantRemovedEvent(threadId, agentId);
  return true;
}
