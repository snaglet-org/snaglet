import { randomUUID } from 'crypto';
import { transaction } from '@snaglet/db/db';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { wsService } from '@server/services/WebSocketService';
import { emitThreadCreate } from '@server/services/customHooks/threadCreateEvent';
import { agentService } from '@server/services/AgentService';
import { setSession } from '../store';
import { listPendingClarifications } from '../clarification';
import { listPendingToolConfirmations } from '../confirmation';
import { isThreadCompacting } from './compactHandlers';
import { liveRunStatuses } from './chatHelpers/agentStatusEvents';
import { logger } from '@server/config/logger';
import type { SocketSessionCreateMsg } from '@snaglet/shared/types';
import { visionThreadService } from '@server/services/vision/VisionThreadService';

export function registerSessionHandlers(): void {
  wsService.registerHandler<SocketSessionCreateMsg['payload']>(
    'socket:session:create',
    async (payload, meta) => {
      const { agentId, threadId: requestedThreadId, sessionId: requestedSessionId } = payload ?? {};
      const agent = agentId ? await agentService.get(agentId) : undefined;
      if (!agentId || !agent) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          // Echo the ids the client sent so a multi-pane client can route the
          // error to the pane that asked (same contract as session:resume).
          payload: {
            message: `Unknown agent: ${agentId}`,
            ...(agentId ? { agentId } : {}),
            ...(requestedThreadId ? { threadId: requestedThreadId } : {}),
            ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
          },
        });
        return;
      }

      const sessionId = randomUUID();
      // The thread and its participant commit together: a failed participant
      // write rolls the thread back instead of leaving an orphan.
      const thread = await transaction(async (tx) => {
        const created = await Threads.create(
          {
            id: randomUUID(),
            title: `Chat with ${agent.name}`,
          },
          tx
        );
        // Add the agent as a participant so they appear in the thread
        // config UI and can be dispatched on incoming messages. No "default
        // agent" relationship — all participants are equal.
        await ThreadParticipants.addParticipant({ threadId: created.id, agentId: agent.id }, tx);
        return created;
      });
      // After the participant write — the shared builder reads the roster.
      // A session chat is always user-initiated.
      emitThreadCreate(thread.id, { kind: 'user' });

      await setSession({
        id: sessionId,
        agentId,
        threadId: thread.id,
        participantAgentIds: [agent.id],
        createdAt: Date.now(),
      });

      logger.info(`[socket] Session created: ${sessionId} → ${agentId}`);
      wsService.sendToClient(meta.clientId, {
        type: 'socket:session:created',
        payload: {
          sessionId,
          agentId,
          threadId: thread.id,
          title: thread.title,
          participantAgentIds: [agent.id],
        },
      });
    }
  );

  wsService.registerHandler<{ threadId: string }>(
    'socket:session:resume',
    async (payload, meta) => {
      const { threadId } = payload ?? {};
      const thread = threadId ? await Threads.findById(threadId) : null;
      if (!thread) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: { threadId, message: `Thread not found: ${threadId}` },
        });
        return;
      }

      const threadTitle = (thread as unknown as { title?: string | null }).title ?? null;
      const threadAgentId = (thread as unknown as { agentId?: string | null }).agentId ?? null;

      const participants = await ThreadParticipants.listByThread(threadId);
      const participantAgentIds = Array.from(
        new Set(participants.map((p) => p.agentId).filter((id): id is string => Boolean(id)))
      );
      // Threads have no per-participant owner; the first-added participant is the
      // de-facto session anchor when thread.agentId isn't set.
      const ownerParticipantId = participantAgentIds[0] ?? null;

      const candidateAgentIds = Array.from(
        new Set([threadAgentId, ownerParticipantId, ...participantAgentIds].filter(Boolean))
      ) as string[];

      if (candidateAgentIds.length === 0) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: { threadId, message: `Thread has no active participants: ${threadId}` },
        });
        return;
      }

      let agent = null;
      for (const candidateAgentId of candidateAgentIds) {
        const candidateAgent = await agentService.get(candidateAgentId);
        if (candidateAgent) {
          agent = candidateAgent;
          break;
        }
      }
      if (!agent) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: { threadId, message: `No valid agent found for thread: ${threadId}` },
        });
        return;
      }

      const resolvedParticipantAgentIds =
        participantAgentIds.length > 0 ? participantAgentIds : [agent.id];

      const sessionId = randomUUID();
      await setSession({
        id: sessionId,
        agentId: agent.id,
        threadId,
        participantAgentIds: resolvedParticipantAgentIds,
        createdAt: Date.now(),
      });

      // The agents running in the thread right now and each one's latest
      // status, so a view that opens or reconnects mid-run shows a run whose
      // status frames it missed. Read synchronously from in-memory run state
      // just before the send: frames broadcast after it reach this client after
      // it, in order.
      const liveStatuses = liveRunStatuses(threadId);
      const activeAgentIds = Array.from(liveStatuses.keys());

      logger.info(
        `[socket] Session resumed: ${sessionId} → thread ${threadId}` +
          (activeAgentIds.length > 0 ? ` (active agents: ${activeAgentIds.join(', ')})` : '')
      );
      wsService.sendToClient(meta.clientId, {
        type: 'socket:session:created',
        payload: {
          sessionId,
          agentId: agent.id,
          threadId,
          title: threadTitle,
          participantAgentIds: resolvedParticipantAgentIds,
          activeAgentIds: activeAgentIds.length > 0 ? activeAgentIds : undefined,
          activeAgentStatuses: liveStatuses.size > 0 ? Object.fromEntries(liveStatuses) : undefined,
          compacting: isThreadCompacting(threadId) || undefined,
        },
      });

      // The thread subscription is restored immediately before resume. Push
      // server-owned vision state too so a reload/reconnect never invents a
      // second client-side lifecycle.
      visionThreadService.emitCurrentState(threadId);

      // Re-emit any clarification the thread is still blocked on, so a reloaded
      // page gets its question form back (the parked run is keyed by thread).
      for (const pending of listPendingClarifications(threadId)) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:clarification:request',
          payload: pending,
        });
      }
      for (const pending of listPendingToolConfirmations(threadId)) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:tool:confirmation_request',
          payload: pending,
        });
      }
    }
  );
}
