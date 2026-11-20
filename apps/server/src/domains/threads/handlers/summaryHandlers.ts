import type { Router } from 'express';
import { participantAgentId } from './participantAgentId';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { AppError, asNonEmptyString, elapsedMs, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { wsService } from '@server/services/WebSocketService';
import {
  COMPACTION_DISABLED_MESSAGE,
  isConversationCompactionEnabled,
} from '@server/config/conversationCompactionPolicy';
import {
  clearAgentCompacting,
  getAgentCompactingSince,
  isAgentCompacting,
  markAgentCompacting,
} from '@server/services/SocketService/handlers/compactState';
import { haltOnSummaryFailure, summaryHaltRefusal } from '@server/services/summary/summaryHalt';

export function registerSummaryRoutes(router: Router): void {
  router.get(
    '/:id/agents/:agentId/summaries',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const rows = await ThreadSummaries.getHistoryByThreadAndAgent(
        req.params.id,
        req.params.agentId
      );
      sendOk(res, rows);
    })
  );

  router.get(
    '/:id/model',
    asyncHandler(async (req, res) => {
      const agentId = req.query.agentId as string | undefined;
      if (!agentId) {
        throw new AppError(
          'agentId query param is required to resolve effective model',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      const effective = await Threads.getEffectiveModel(req.params.id, agentId);
      if (!effective) {
        throw new AppError(
          'Thread not found or no model configured',
          ErrorCode.NOT_FOUND,
          HTTP_STATUS.NOT_FOUND
        );
      }
      sendOk(res, effective);
    })
  );

  router.get(
    '/:id/context-usage',
    asyncHandler(async (req, res) => {
      const agentId = asNonEmptyString(req.query.agentId);
      if (!agentId) {
        throw new AppError(
          'agentId query parameter is required',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }

      const applySummaryUnconditionally = req.query.applySummary === 'force';
      const { estimateThreadUsage } = await import('@server/services/ContextWindowService');
      const result = await estimateThreadUsage(req.params.id, agentId, {
        applySummaryUnconditionally,
      });
      if (!result.ok) {
        const message =
          result.reason === 'thread_not_found' ? 'Thread not found' : 'Agent not found';
        throw new AppError(message, ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }

      sendOk(res, result.usage);
    })
  );

  router.post(
    '/:id/compact',
    asyncHandler(async (req, res) => {
      if (!isConversationCompactionEnabled()) {
        throw new AppError(
          COMPACTION_DISABLED_MESSAGE,
          ErrorCode.SERVICE_UNAVAILABLE,
          HTTP_STATUS.SERVICE_UNAVAILABLE
        );
      }
      const threadId = req.params.id;
      const raw = (req.body ?? {}) as { agentId?: unknown };
      const agentId = asNonEmptyString(raw.agentId);
      if (!agentId) {
        throw new AppError(
          'agentId is required',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }

      const thread = await Threads.findById(threadId);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }

      if (isAgentCompacting(threadId, agentId)) {
        throw new AppError(
          'Compaction already in progress for this agent',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.CONFLICT
        );
      }

      const participants = await ThreadParticipants.listByThread(threadId);
      const agentNameMap = new Map<string, string>();
      const { agentService } = await import('@server/services/AgentService');
      for (const p of participants) {
        const participantAgent = participantAgentId(p);
        if (!participantAgent) continue;
        const agent = await agentService.get(participantAgent).catch(() => null);
        if (agent) agentNameMap.set(agent.id, agent.name);
      }

      markAgentCompacting(threadId, agentId);
      wsService.broadcastToChannel(threadId, {
        type: 'socket:thread:compact:started',
        payload: { threadId, totalAgents: 1, agentId },
      });

      const startedAt = Date.now();
      try {
        const { summaryService } = await import('@server/services/SummaryService');
        const outcome = await summaryService.generateSummary({
          threadId,
          agentId,
          agentNameMap,
          force: true,
        });
        // Compaction-time memory extraction, same as the socket compact
        // path: the shared helper fires only for a summary that was actually
        // written, mines just the span it newly covered, and runs detached so
        // this route answers as fast as it did before.
        const { scheduleCompactionMemoryExtraction } =
          await import('@server/services/summary/scheduleCompactionMemoryExtraction');
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

        // A user-triggered compact is the most explicit "summarize now" there
        // is — a broken summarizer halts the thread here exactly as it does on
        // the run-end pass, and this route must not answer compact:complete
        // for a pass that wrote nothing. Benign cadence outcomes (not-due,
        // no-new-messages, …) fall through and still complete.
        const halt = await haltOnSummaryFailure(outcome, {
          threadId,
          agentId,
          agentName: agentNameMap.get(agentId) ?? null,
        });
        if (halt) {
          throw new AppError(
            summaryHaltRefusal(halt),
            ErrorCode.SERVICE_UNAVAILABLE,
            HTTP_STATUS.SERVICE_UNAVAILABLE
          );
        }
        const durationMs = elapsedMs(startedAt);
        wsService.broadcastToChannel(threadId, {
          type: 'socket:thread:compact:complete',
          payload: { threadId, totalAgents: 1, durationMs, agentId },
        });
        sendOk(res, { agentId, durationMs });
      } catch (err) {
        const message = getErrorMessage(err, 'Compaction failed');
        wsService.broadcastToChannel(threadId, {
          type: 'socket:thread:compact:error',
          payload: { threadId, message, agentId },
        });
        throw err;
      } finally {
        clearAgentCompacting(threadId, agentId);
      }
    })
  );

  router.get(
    '/:id/compact-status',
    asyncHandler(async (req, res) => {
      const agentId = asNonEmptyString(req.query.agentId);
      if (!agentId) {
        throw new AppError(
          'agentId query parameter is required',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      const since: string | null = getAgentCompactingSince(req.params.id, agentId);
      sendOk(res, { compacting: since !== null, since });
    })
  );
}
