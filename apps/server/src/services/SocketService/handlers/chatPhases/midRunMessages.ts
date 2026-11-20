import { Messages } from '@snaglet/db/tables/messages';
import { Users } from '@snaglet/db/tables/users';
import type { SnagletAgent } from '@server/services/AgentService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { syncMessageEmbedding } from '@server/services/EmbeddingService';
import type { Message } from '@server/services/SocketService/types';
import { wsService } from '@server/services/WebSocketService';
import { getErrorMessage } from '@snaglet/shared/utils';
import { LogsService } from '@server/services/LogsService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { resolveAllModeTargets, routeMentions } from './mentionRouter';
import { handOverToRemainingAgent, replacementForLeaver } from './handOverToRemainingAgent';
import type { RunAgentTurnDeps, RunAgentTurnSharedState } from './types';

/**
 * Persist + broadcast any messages still parked in a session's mid-run
 * queue. Called from the dispatch finally right before the run lock is
 * released: the sending client was already ack'd with "queued", so the
 * queue must never die with the session (otherwise these messages would be
 * silently destroyed whenever the run ends without another drain seam —
 * zero-tool final iterations, non-all-mode groups). No routing happens
 * here — the run is over; the messages land in the thread so they're
 * visible and included in the next run's context instead of vanishing.
 *
 * Returns the drained leftovers (all durably in the DB by the time this
 * resolves — persist-first rows already were; memory-only stragglers whose
 * persist on receipt failed are written here) so the dispatch finally can re-dispatch the thread for
 * messages the run never delivered.
 */
export async function flushAbandonedSessionMessages({
  sessionId,
  threadId,
  threadName,
}: {
  sessionId: string;
  threadId: string;
  threadName: string;
}): Promise<Array<{ id: string; content: string; injection?: string; persisted?: boolean }>> {
  const leftovers = activeRunTracker.drainMessages(sessionId);
  await persistLeftoverQueuedMessages(leftovers, { threadId, threadName });
  return leftovers;
}

/**
 * Persist + broadcast a batch of already-drained queued messages. Split out of
 * flushAbandonedSessionMessages so the dispatch finally can re-run it on the
 * stragglers finishSession() hands back — closing the flush-vs-delete window
 * where a send acked "queued" could otherwise be dropped (drain-then-delete is
 * atomic in ActiveRunTracker, and these stragglers are persisted here).
 */
export async function persistLeftoverQueuedMessages(
  leftovers: ReadonlyArray<{
    id: string;
    content: string;
    injection?: string;
    persisted?: boolean;
  }>,
  { threadId, threadName }: { threadId: string; threadName: string }
): Promise<void> {
  // Rows already written by chatHandlers on receipt (persist-first) are
  // durable — re-creating them here would PK-collide. Only memory-only
  // stragglers (persist on receipt failed) still need a write at run end.
  const unpersisted = leftovers.filter((m) => !m.persisted);
  if (unpersisted.length === 0) return;
  const user = await Users.getOrCreateLocalUser();
  for (const { id, content, injection } of unpersisted) {
    try {
      await Messages.create({
        id,
        threadId,
        role: 'user',
        content,
        agentId: null,
        userId: user.id,
        injectedDuringRun: true,
        // Preserve a barge-in "heard up to" marker if this message reaches the
        // session-end safety net undrained: content stays clean, marker rides
        // metadata.persistedInjection (folded into context on the next replay).
        metadata: injection ? { persistedInjection: injection } : null,
      });
    } catch (err) {
      LogsService.warn('failed to persist leftover queued message', {
        threadName,
        threadId,
        messageId: id,
        error: getErrorMessage(err),
      });
      continue;
    }
    void syncMessageEmbedding(id, content).catch((err) => {
      LogsService.warn('message embedding sync failed', {
        threadName,
        threadId,
        messageId: id,
        error: getErrorMessage(err),
      });
    });
    wsService.broadcastToChannel(threadId, {
      type: 'socket:chat:message_created',
      payload: {
        id,
        threadId,
        role: 'user',
        content,
        injected_during_run: true,
      },
    });
    LogsService.socket.event('queued message persisted at run end', {
      threadName,
      threadId,
      messageId: id,
    });
  }
}

/**
 * Persist + broadcast a batch of messages `finishSession()` handed back
 * (already drained from the session's mid-run queue). Every finishSession()
 * call site — not just the main dispatch-loop finally — must route the
 * return value through here or a client acked "queued" can have its message
 * silently vanish once the queue is deleted with the session: `sessionId`
 * releasing the run lock and the queue dying with it are simultaneous, so
 * anything still (or newly) parked there at that instant only survives if
 * the caller does something with what finishSession() returns.
 */
export async function persistStragglers(
  sessionId: string,
  stragglers: ReadonlyArray<{
    id: string;
    content: string;
    injection?: string;
    persisted?: boolean;
  }>,
  { threadId, threadName }: { threadId: string; threadName: string }
): Promise<void> {
  if (stragglers.length === 0) return;
  try {
    await persistLeftoverQueuedMessages(stragglers, { threadId, threadName });
    LogsService.socket.event('persisted messages returned by finishSession', {
      threadName,
      threadId,
      sessionId,
      count: stragglers.length,
    });
  } catch (err) {
    LogsService.warn('failed to persist messages returned by finishSession', {
      threadName,
      threadId,
      sessionId,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Convenience wrapper for the common early-exit shape: end the session and
 * persist whatever finishSession() handed back, in one call. Use this at any
 * call site that just wants to release the run lock and be done — it cannot
 * forget the straggler-persist step by construction.
 */
export async function finishSessionAndPersistStragglers(
  sessionId: string,
  ctx: { threadId: string; threadName: string }
): Promise<void> {
  const stragglers = activeRunTracker.finishSession(sessionId);
  await persistStragglers(sessionId, stragglers, ctx);
}

export async function drainToolLoopMidRunMessages({
  deps,
  shared,
  replyAgentId,
  agent,
  runtimeAgent,
  agentMessages,
  fanOutAllModeMidRunMessage,
}: {
  deps: RunAgentTurnDeps;
  shared: RunAgentTurnSharedState;
  replyAgentId: string;
  agent: SnagletAgent;
  runtimeAgent: SnagletAgent;
  agentMessages: Message[];
  fanOutAllModeMidRunMessage: (
    midRunContent: string,
    targetAgentIds?: readonly string[],
    meta?: {
      senderAgentId?: string | null;
      senderUserId?: string | null;
      senderName?: string;
      sourceMessageId?: string;
    }
  ) => unknown;
}) {
  const { session, sessionId, threadName, previewMessage, dispatchMode } = deps;

  const pendingMidRunMessages = activeRunTracker.drainMessages(sessionId);
  // Route against the thread as it is now (an agent may have joined or left).
  if (pendingMidRunMessages.length > 0) await deps.refreshRoster?.();
  const { isGroup } = deps;
  const midRunUser = pendingMidRunMessages.length > 0 ? await Users.getOrCreateLocalUser() : null;
  // The person's own name labels what they say to a teammate, not a generic "User".
  const midRunUserName = midRunUser
    ? (await Users.findById(midRunUser.id).catch(() => null))?.name?.trim() || 'User'
    : 'User';
  for (const {
    id: midRunMsgId,
    content: midRunContent,
    injection: midRunInjection,
    persisted: midRunPersisted,
  } of pendingMidRunMessages) {
    LogsService.user.message({
      threadName,
      threadId: session.threadId,
      text: previewMessage(midRunContent, 300),
    });
    // Voice barge-in "heard up to" marker rides the persisted-injection channel:
    // the DB row keeps CLEAN content (marker in metadata.persistedInjection,
    // folded on replay by effectiveContent), while the live injection below uses
    // `injectedContent` — content + marker, byte-identical to effectiveContent's
    // fold — so this run's model context also gets it. No injection → both are
    // just the clean content, so non-voice mid-run messages are unchanged.
    const injectedContent = midRunInjection
      ? midRunContent.length > 0
        ? `${midRunContent}\n\n${midRunInjection}`
        : midRunInjection
      : midRunContent;
    // When chatHandlers already persisted this row on receipt
    // (persist-first), the create/embedding/broadcast were done there — repeating
    // them here would PK-collide on the id. Skip straight to routing; the message
    // is already in the DB and already broadcast to the thread.
    if (!midRunPersisted) {
      await Messages.create({
        id: midRunMsgId,
        threadId: session.threadId,
        role: 'user',
        content: midRunContent,
        agentId: null,
        userId: midRunUser!.id,
        injectedDuringRun: true,
        metadata: midRunInjection ? { persistedInjection: midRunInjection } : null,
      });
      void syncMessageEmbedding(midRunMsgId, midRunContent).catch((err) => {
        LogsService.warn('message embedding sync failed', {
          threadName,
          threadId: session.threadId,
          messageId: midRunMsgId,
          error: getErrorMessage(err),
        });
      });
      wsService.broadcastToChannel(session.threadId, {
        type: 'socket:chat:message_created',
        payload: {
          id: midRunMsgId,
          threadId: session.threadId,
          role: 'user',
          content: midRunContent,
          injected_during_run: true,
        },
      });
    }

    if (!isGroup) {
      // The running agent may have left the thread (its output is dropped):
      // then the message goes to the agent still there.
      const replacement = replacementForLeaver(deps, replyAgentId);
      if (replacement !== null) {
        if (replacement) {
          handOverToRemainingAgent({
            deps,
            shared,
            agentId: replacement,
            leaverId: replyAgentId,
            messages: [
              {
                id: midRunMsgId,
                content: injectedContent,
                senderUserId: midRunUser!.id,
                senderName: midRunUserName,
              },
            ],
          });
        }
        continue;
      }
      pendingAgentMessages.enqueue({
        id: midRunMsgId,
        threadId: session.threadId,
        targetAgentId: replyAgentId,
        senderUserId: midRunUser!.id,
        senderName: midRunUserName,
        content: injectedContent,
        reason: 'user-mid-run',
        sourceMessageId: midRunMsgId,
      });
      continue;
    }

    if (isGroup && dispatchMode === 'all') {
      // Mention parse is marker-agnostic (the marker carries no @mentions), so
      // routing off injectedContent resolves the same targets as clean content.
      const route = resolveAllModeTargets({
        deps,
        content: injectedContent,
        replyAgentId,
        sender: { userId: midRunUser!.id, name: midRunUserName },
      });
      fanOutAllModeMidRunMessage(injectedContent, route.targetAgentIds, {
        senderUserId: midRunUser!.id,
        senderName: midRunUserName,
        sourceMessageId: midRunMsgId,
      });
      if (route.targetsCurrentAgent) {
        pendingAgentMessages.enqueue({
          id: midRunMsgId,
          threadId: session.threadId,
          targetAgentId: replyAgentId,
          senderUserId: midRunUser!.id,
          senderName: midRunUserName,
          content: injectedContent,
          reason: 'all-mode-thread-message',
          sourceMessageId: midRunMsgId,
        });
      }
      continue;
    }

    const outcome = routeMentions({
      deps,
      shared,
      content: injectedContent,
      replyAgentId,
      sender: { userId: midRunUser!.id, name: midRunUserName },
      queueReason: 'mentioned',
      queueMessageId: midRunMsgId,
      sourceMessageId: midRunMsgId,
      logContext: 'mid-run user',
    });

    if (outcome.targetedSelf) {
      pendingAgentMessages.enqueue({
        id: midRunMsgId,
        threadId: session.threadId,
        targetAgentId: replyAgentId,
        senderUserId: midRunUser!.id,
        senderName: midRunUserName,
        content: injectedContent,
        reason: 'mentioned',
        sourceMessageId: midRunMsgId,
      });
    }
  }
}
