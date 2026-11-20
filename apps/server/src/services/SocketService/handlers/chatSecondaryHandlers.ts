/**
 * chatSecondaryHandlers.ts — Lightweight socket handlers for tool confirmation
 * and chat abort.
 */

import { wsService } from '@server/services/WebSocketService';
import { getSession } from '../store';
import { listAllPendingToolConfirmations, resolveToolConfirmation } from '../confirmation';
import {
  cancelClarificationsForThread,
  listAllPendingClarifications,
  resolveClarification,
} from '../clarification';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { logger } from '@server/config/logger';
import { ASK_SNAPSHOT, ASK_SYNC } from '@snaglet/shared/types';
import type {
  Actor,
  AskSnapshotPayload,
  ClarificationResponsePayload,
  ToolConfirmationResponsePayload,
} from '@snaglet/shared/types';
import { Users } from '@snaglet/db/tables/users';
import { AbortRunService } from '@server/services/AbortRunService';
import { getErrorMessage } from '@snaglet/shared/utils';

async function resolveAbortActor(meta: {
  externalCaller?: { memberId: string; name: string };
}): Promise<Actor> {
  if (meta.externalCaller) {
    return {
      actorKind: 'external',
      actorId: meta.externalCaller.memberId,
      actorName: meta.externalCaller.name,
    };
  }
  const activeUser = await Users.getActiveUser().catch(() => null);
  if (activeUser) {
    return { actorKind: 'user', actorId: activeUser.id, actorName: activeUser.name };
  }
  const local = await Users.getOrCreateLocalUser();
  const localUser = await Users.findById(local.id);
  return {
    actorKind: 'user',
    actorId: local.id,
    actorName: localUser?.name ?? 'User',
  };
}

export function registerToolConfirmHandler(): void {
  wsService.registerHandler<ToolConfirmationResponsePayload>(
    'socket:tool:confirm',
    async (payload, _meta) => {
      const { sessionId, threadId, callId, decision } = payload ?? {};
      // A popup answering with no chat open sends the thread; a chat pane sends its session.
      const resolvedThreadId = sessionId ? (await getSession(sessionId))?.threadId : threadId;
      if (!resolvedThreadId) return;

      await resolveToolConfirmation(resolvedThreadId, callId, decision ?? 'deny');
    }
  );
}

export function registerClarificationResponseHandler(): void {
  wsService.registerHandler<ClarificationResponsePayload>(
    'socket:clarification:response',
    async (payload, _meta) => {
      const { sessionId, threadId, callId, status, answers } = payload ?? {};
      if (!callId) return;
      const resolvedThreadId = sessionId ? (await getSession(sessionId))?.threadId : threadId;
      if (!resolvedThreadId) return;

      // Resolve by THREAD (not session) so an answer from a reloaded page —
      // which reconnected with a fresh sessionId — still reaches the parked run.
      resolveClarification(resolvedThreadId, callId, {
        status: status ?? 'answered',
        answers: answers ?? {},
      });
    }
  );
}

export function registerChatAbortHandler(): void {
  wsService.registerHandler<{ sessionId: string; agent_id?: string }>(
    'socket:chat:abort',
    async (payload, meta) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) return;

      let session;
      try {
        session = await getSession(sessionId);
      } catch (err) {
        logger.warn('[socket] abort session lookup failed', {
          sessionId,
          error: getErrorMessage(err),
        });
        return;
      }
      if (!session?.threadId) return;
      const abortedBy = await resolveAbortActor(meta);
      const targetAgentId = payload.agent_id?.trim();
      const abortedCount = targetAgentId
        ? Number(
            (
              await AbortRunService.abortAgentRun({
                threadId: session.threadId,
                agentId: targetAgentId,
                abortedBy,
              })
            ).aborted
          )
        : (
            await AbortRunService.abortAllAgentRuns({
              threadId: session.threadId,
              abortedBy,
            })
          ).abortedCount;

      // The turn's abort signal cancels a parked clarification it owns; this
      // also clears one whose run was already abandoned, so Stop never leaves a
      // question (and its reaper keep-alive) behind.
      cancelClarificationsForThread(session.threadId, targetAgentId || undefined);

      const snapshot = activeRunTracker.snapshot();
      logger.info(
        `[socket] abort requested [session=${sessionId}] [thread=${session.threadId}]` +
          `${targetAgentId ? ` [agent=${targetAgentId}]` : ''} — ` +
          `${abortedCount > 0 ? `aborted ${abortedCount} active run(s)` : 'no active run'}; ` +
          `active_threads=${snapshot.activeThreadCount} active_runs=${snapshot.activeRunCount}`
      );
    }
  );
}

/** Send a client the full set of asks still pending (the agent-popups feed's snapshot). */
export function registerAskSyncHandler(): void {
  wsService.registerHandler(ASK_SYNC, (_payload, meta) => {
    const snapshot: AskSnapshotPayload = {
      clarifications: listAllPendingClarifications(),
      confirmations: listAllPendingToolConfirmations(),
    };
    wsService.sendToClient(meta.clientId, { type: ASK_SNAPSHOT, payload: snapshot });
  });
}
