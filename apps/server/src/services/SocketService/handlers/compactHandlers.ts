import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { wsService } from '@server/services/WebSocketService';
import { summaryService } from '@server/services/SummaryService';
import { haltOnSummaryFailure } from '@server/services/summary/summaryHalt';
import { scheduleCompactionMemoryExtraction } from '@server/services/summary/scheduleCompactionMemoryExtraction';
import { agentService } from '@server/services/AgentService';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { LogsService } from '@server/services/LogsService';
import { getSession } from '../store';
import { logger } from '@server/config/logger';
import { sleep, elapsedMs } from '@snaglet/shared/utils/dateTime';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  COMPACTION_DISABLED_MESSAGE,
  isConversationCompactionEnabled,
} from '@server/config/conversationCompactionPolicy';

const COMPACT_CONCURRENCY = 1;
const compactingThreads = new Set<string>();

/**
 * Threads with a compaction request that is waiting for the active agent run
 * to finish. Tracked so we (a) don't queue duplicates and (b) can surface a
 * 'deferred' status to the UI.
 */
const deferredCompacts = new Map<
  string,
  { sessionId: string; clientId: string; scheduledAt: number }
>();

/** How often we poll ActiveRunTracker while waiting for a thread to go idle. */
const DEFERRED_POLL_INTERVAL_MS = 500;
/** Safety ceiling so a stuck run can't block compaction forever. */
const DEFERRED_MAX_WAIT_MS = 5 * 60 * 1000;

export function isThreadCompacting(threadId: string): boolean {
  return compactingThreads.has(threadId);
}

function isThreadCompactDeferred(threadId: string): boolean {
  return deferredCompacts.has(threadId);
}

export function registerThreadCompactHandler(): void {
  wsService.registerHandler<{ sessionId: string }>(
    'socket:thread:compact',
    async (payload, meta) => {
      const sessionId = payload?.sessionId;
      if (!isConversationCompactionEnabled()) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: { sessionId, message: COMPACTION_DISABLED_MESSAGE },
        });
        return;
      }
      const session = await getSession(sessionId);
      if (!session) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: { sessionId, message: `Session not found: ${sessionId}` },
        });
        return;
      }

      const { threadId } = session;
      if (compactingThreads.has(threadId)) {
        wsService.sendToClient(meta.clientId, {
          type: 'socket:error',
          payload: { sessionId, message: 'Thread compaction already in progress' },
        });
        return;
      }

      // If an agent run is active for this thread, defer the compaction until
      // the thread is idle. Mid-run compaction mutates thread_summaries while
      // the in-flight loop is holding a stale summary ref + growing in-memory
      // transcript, which can stall the mention-driven loop. Deferring is the
      // safe fix — summaries are eventually-generated anyway.
      if (activeRunTracker.hasActiveThread(threadId)) {
        if (deferredCompacts.has(threadId)) {
          wsService.sendToClient(meta.clientId, {
            type: 'socket:error',
            payload: { sessionId, message: 'Compaction already queued for this thread.' },
          });
          return;
        }
        deferredCompacts.set(threadId, {
          sessionId,
          clientId: meta.clientId,
          scheduledAt: Date.now(),
        });
        wsService.sendToClient(meta.clientId, {
          type: 'socket:thread:compact:deferred',
          payload: {
            threadId,
            reason: 'Agent run in progress — compaction will start when the run finishes.',
          },
        });
        LogsService.socket.event('thread compact deferred (run active)', {
          threadId,
          sessionId,
        });
        // Kick off a watcher that fires compaction once the thread is idle.
        void waitForIdleThenCompact(threadId, sessionId, meta.clientId);
        return;
      }

      await performCompaction(threadId, sessionId, meta.clientId);
    }
  );
}

/**
 * Execute the compaction itself (broadcasts + per-agent summaries).
 * Shared by the immediate path and the deferred-after-idle watcher.
 */
async function performCompaction(
  threadId: string,
  sessionId: string,
  clientId: string
): Promise<void> {
  // Deferred requests must honor a policy change made while waiting.
  if (!isConversationCompactionEnabled()) {
    wsService.sendToClient(clientId, {
      type: 'socket:error',
      payload: { sessionId, message: COMPACTION_DISABLED_MESSAGE },
    });
    return;
  }
  const participants = await ThreadParticipants.listByThread(threadId);
  const agentIds = Array.from(
    new Set(participants.map((p) => p.agentId).filter((id): id is string => Boolean(id)))
  );

  if (agentIds.length === 0) {
    wsService.sendToClient(clientId, {
      type: 'socket:error',
      payload: { sessionId, message: 'Thread has no participants to compact' },
    });
    return;
  }

  const agentNameMap = new Map<string, string>();
  for (const id of agentIds) {
    const agent = await agentService.get(id).catch(() => null);
    if (agent) agentNameMap.set(agent.id, agent.name);
  }

  compactingThreads.add(threadId);
  const startedAt = Date.now();

  wsService.broadcastToChannel(threadId, {
    type: 'socket:thread:compact:started',
    payload: { threadId, totalAgents: agentIds.length },
  });

  try {
    let completed = 0;
    const queue = [...agentIds];
    const workerCount = Math.min(COMPACT_CONCURRENCY, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const agentId = queue.shift();
        if (!agentId) break;
        try {
          const outcome = await summaryService.generateSummary({
            threadId,
            agentId,
            agentNameMap,
            force: true,
          });
          // A user-triggered compact is the most explicit "summarize now" there
          // is — a broken summarizer here halts the thread exactly as it does on
          // the automatic run-end pass.
          await haltOnSummaryFailure(outcome, {
            threadId,
            agentId,
            agentName: agentNameMap.get(agentId) ?? null,
          });
          // Compaction-time memory extraction: mine the span this summary just
          // covered before it becomes unreachable. The shared helper decides
          // whether extraction is owed (generated summaries only, once per
          // summary id) and fires it detached — it never throws and never
          // slows compaction. When extraction wrote anything, broadcast the
          // deltas on the thread channel so the UI can surface "N memories
          // saved, M proposed".
          scheduleCompactionMemoryExtraction({
            threadId,
            agentId,
            outcome,
            agentNameMap,
            onResult: (result) => {
              wsService.broadcastToChannel(threadId, {
                type: 'socket:thread:memory-extraction',
                payload: { threadId, agentId, ...result },
              });
            },
          });
        } catch (err) {
          logger.error(`[compact] agent ${agentId} summary failed:`, getErrorMessage(err));
        }
        completed += 1;
        wsService.broadcastToChannel(threadId, {
          type: 'socket:thread:compact:progress',
          payload: { threadId, completed, total: agentIds.length, agentId },
        });
      }
    });
    await Promise.all(workers);

    wsService.broadcastToChannel(threadId, {
      type: 'socket:thread:compact:complete',
      payload: {
        threadId,
        totalAgents: agentIds.length,
        durationMs: elapsedMs(startedAt),
      },
    });
  } catch (err) {
    wsService.broadcastToChannel(threadId, {
      type: 'socket:thread:compact:error',
      payload: {
        threadId,
        message: getErrorMessage(err, 'Compaction failed'),
      },
    });
  } finally {
    compactingThreads.delete(threadId);
  }
}

/**
 * Poll ActiveRunTracker until the thread is idle, then run the deferred
 * compaction. Gives up after DEFERRED_MAX_WAIT_MS so a wedged run can't
 * permanently block compaction.
 */
async function waitForIdleThenCompact(
  threadId: string,
  sessionId: string,
  clientId: string
): Promise<void> {
  const startedAt = Date.now();
  try {
    while (activeRunTracker.hasActiveThread(threadId)) {
      if (elapsedMs(startedAt) > DEFERRED_MAX_WAIT_MS) {
        wsService.sendToClient(clientId, {
          type: 'socket:error',
          payload: {
            sessionId,
            message:
              'Compaction timed out waiting for the active run to finish. Try again once agents are idle.',
          },
        });
        LogsService.socket.event('thread compact deferred (timeout)', { threadId });
        return;
      }
      await sleep(DEFERRED_POLL_INTERVAL_MS);
    }
    LogsService.socket.event('thread compact deferred (fired)', {
      threadId,
      waitedMs: elapsedMs(startedAt),
    });
    await performCompaction(threadId, sessionId, clientId);
  } finally {
    deferredCompacts.delete(threadId);
  }
}
