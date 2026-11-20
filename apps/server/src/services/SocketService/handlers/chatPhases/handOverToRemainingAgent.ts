/**
 * handOverToRemainingAgent — a person's mid-run message in a one-agent thread
 * goes to the agent that is running. When that agent has just left the thread
 * (thread op leave, or someone removed it), its output is dropped, so the
 * message must reach the agent that is still there instead: queued for its
 * next tool turn if it is running, otherwise woken into the wave, the same way
 * a mention reaches a teammate (mentionRouter).
 */

import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { LogsService } from '@server/services/LogsService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';

export interface HandOverMessage {
  id: string;
  content: string;
  senderUserId: string;
  senderName: string;
}

/**
 * The agent a person's message should reach instead of `replyAgentId`, when
 * `replyAgentId` is no longer in the thread; null while it still is.
 */
export function replacementForLeaver(
  deps: Pick<RunAgentTurnDeps, 'participantAgentIds'>,
  replyAgentId: string
): string | null | undefined {
  if (deps.participantAgentIds.includes(replyAgentId)) return null;
  // undefined: the leaver was the thread's last agent; nobody can take it.
  return deps.participantAgentIds.find((id) => id !== replyAgentId);
}

/**
 * Deliver `messages` (already persisted) to `agentId`: queued if it is running
 * now, else woken into the current or next wave. Returns false when a wake is
 * over the per-agent dispatch ceiling.
 */
export function handOverToRemainingAgent(input: {
  deps: RunAgentTurnDeps;
  shared: RunAgentTurnSharedState;
  agentId: string;
  leaverId: string;
  messages: readonly HandOverMessage[];
}): boolean {
  const { deps, shared, agentId, messages } = input;
  const threadId = deps.session.threadId;
  const logMeta = {
    threadName: deps.threadName,
    threadId,
    leaverId: input.leaverId,
    agentName: deps.agentNameMap.get(agentId) ?? agentId,
    count: messages.length,
  };

  if (shared.runningAgents.has(agentId)) {
    for (const message of messages) {
      pendingAgentMessages.enqueue({
        id: message.id,
        threadId,
        targetAgentId: agentId,
        senderUserId: message.senderUserId,
        senderName: message.senderName,
        content: message.content,
        reason: 'user-mid-run',
        sourceMessageId: message.id,
      });
    }
    LogsService.socket.event('mid-run message handed to the remaining agent (queued)', logMeta);
    return true;
  }

  if ((shared.agentDispatchCount.get(agentId) ?? 0) >= deps.HARD_DISPATCH_CEILING) {
    LogsService.socket.event('mid-run message hand-over skipped (dispatch limit)', logMeta);
    return false;
  }
  deps.dispatchSet.add(agentId);
  shared.passedAgents.delete(agentId);
  deps.wokenByMention.add(agentId);
  activeRunTracker.reserveHandoff(threadId, 'mention-handoff');
  if (deps.effectiveParallelDispatch) deps.startAgent(agentId);
  LogsService.socket.event('mid-run message handed to the remaining agent (woken)', logMeta);
  return true;
}
