import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { participantAgentId } from '@server/domains/threads/handlers/participantAgentId';
import { removeAgentParticipant } from '@server/domains/threads/removeAgentParticipant';
import { perThreadSetup } from './perThreadSetup';
import type { ToolHandler } from '@server/services/ToolService/types';
import {
  resolveTargetThreadId,
  threadNotFoundError,
} from '@server/services/ToolService/lib/targetThread';

const LABEL = 'thread op:leave';

/**
 * thread op `leave`: the calling agent takes itself out of a thread once its
 * part is done, so it stops being woken (and paid for) there. It goes through
 * the same removal as the app's Remove button, so the thread shows the usual
 * "[participant removed · <Name> left the thread]" line.
 *
 * Refused for a DM (it keeps both its parties), a subagent's thread (it
 * belongs to its helper), a caller that is not an agent participant, the
 * thread's only agent, and an agent a person set up for this thread
 * (perThreadSetup, the same check op `remove_agents` uses).
 */
const threadLeave: ToolHandler = async (input, _settings, context) => {
  const unknown = Object.keys(input).filter((key) => key !== 'thread_id');
  if (unknown.length > 0) {
    throw new Error(
      `${LABEL}: takes only an optional id; unknown field(s): ${unknown.join(', ')}.`
    );
  }
  const agentId = context?.agentId;
  if (!agentId) {
    throw new Error(`${LABEL}: only an agent can leave a thread, and this call has no agent.`);
  }
  const threadId = await resolveTargetThreadId(input, context, LABEL);
  const thread = await Threads.findById(threadId);
  if (!thread) throw await threadNotFoundError(LABEL, threadId, context);
  if (thread.kind === 'dm') {
    throw new Error(`${LABEL}: ${threadId} is a direct-message thread; it keeps both its parties.`);
  }
  if (thread.parentThreadId) {
    throw new Error(`${LABEL}: ${threadId} is a subagent's thread; it belongs to that helper.`);
  }

  const participants = await ThreadParticipants.listByThread(threadId);
  const agentIds = participants
    .map((participant) => participantAgentId(participant))
    .filter((id): id is string => id !== null);
  const ownRow = participants.find((participant) => participantAgentId(participant) === agentId);
  if (!ownRow) {
    throw new Error(`${LABEL}: you are not a participant of thread ${threadId}.`);
  }
  if (agentIds.length <= 1) {
    throw new Error(
      `${LABEL}: you are the only agent in thread ${threadId}, and a thread keeps at least one. Nothing was changed.`
    );
  }
  // Leaving deletes what a person set up for you here: that is theirs to undo.
  const setup = await perThreadSetup(threadId, agentId, ownRow);
  if (setup.length > 0) {
    throw new Error(
      `${LABEL}: You have per-thread settings here (${setup.join(', ')}); stay, a person removes you in the app. Nothing was changed.`
    );
  }

  // The tool call itself is already in the activity log, so no actor is passed.
  if (!(await removeAgentParticipant({ threadId, agentId }))) {
    throw new Error(`${LABEL}: you are not a participant of thread ${threadId}.`);
  }
  const title = thread.title?.trim() || threadId;
  // A removed agent's in-flight utterances are dropped (persistUtterance), so
  // leaving the thread it is running in ends its say there.
  const ownThread = context?.threadId === threadId;
  return {
    output:
      `You left thread '${title}' (id=${threadId}). You are not woken there again unless someone adds you back.` +
      (ownThread ? ' Nothing you write after this posts there: end your turn now.' : ''),
    rawContent: { thread_id: threadId, left: true, agent_id: agentId },
  };
};

export default threadLeave;
