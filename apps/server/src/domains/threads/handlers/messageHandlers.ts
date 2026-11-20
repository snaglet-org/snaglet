import type { Router } from 'express';
import { participantAgentId } from './participantAgentId';
import { Messages } from '@snaglet/db/tables/messages';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { asyncHandler } from '@server/middleware';
import { emitThreadMessageUpdated } from '@server/realtime/surfaces/threads';
import { sendOk } from '@server/utils/http';
import { AppError, clamp, isoNow } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { clampLimit } from '@server/utils/pagination';

const DEFAULT_MESSAGE_PAGE = 50;
const MAX_MESSAGE_PAGE = 200;

export function registerMessageRoutes(router: Router): void {
  router.get(
    '/summaries/:summaryId',
    asyncHandler(async (req, res) => {
      const row = await ThreadSummaries.findByIdWithNode(req.params.summaryId);
      if (!row) {
        throw new AppError('Thread summary not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      sendOk(res, row);
    })
  );

  router.get(
    '/messages/:messageId',
    asyncHandler(async (req, res) => {
      const message = await Messages.findById(req.params.messageId);
      if (!message) {
        throw new AppError('Message not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      sendOk(res, message);
    })
  );

  router.get(
    '/:id/messages',
    asyncHandler(async (req, res) => {
      const threadId = req.params.id;
      const thread = await Threads.findById(threadId);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const limit = clampLimit(req.query.limit, {
        defaultLimit: DEFAULT_MESSAGE_PAGE,
        max: MAX_MESSAGE_PAGE,
      });
      const around = typeof req.query.around === 'string' ? req.query.around : null;
      const before = typeof req.query.before === 'string' ? req.query.before : null;
      const after = typeof req.query.after === 'string' ? req.query.after : null;

      if (around) {
        const half = Math.floor(limit / 2);
        const window = await Messages.getContextWindow(around, {
          before: half,
          after: limit - half - 1,
          cap: limit,
        });
        if (!window || window.anchor.threadId !== threadId) {
          // Anchor message no longer exists — fall back to latest page so the
          // thread doesn't render empty on reload with a stale focusMessageId.
          const messages = await Messages.listForThreadRead(threadId, { limit });
          const first = messages[0];
          const hasMoreOlder = first
            ? await Messages.hasOlderThan(threadId, { createdAt: first.createdAt, id: first.id })
            : false;
          sendOk(res, { messages, hasMoreOlder, hasMoreNewer: false });
          return;
        }
        const first = window.messages[0];
        const last = window.messages[window.messages.length - 1];
        const [hasMoreOlder, hasMoreNewer] = await Promise.all([
          first
            ? Messages.hasOlderThan(threadId, { createdAt: first.createdAt, id: first.id })
            : Promise.resolve(false),
          last
            ? Messages.hasNewerThan(threadId, { createdAt: last.createdAt, id: last.id })
            : Promise.resolve(false),
        ]);
        sendOk(res, {
          messages: window.messages,
          hasMoreOlder,
          hasMoreNewer,
          anchorId: window.anchor.id,
        });
        return;
      }

      if (before) {
        const anchor = await Messages.findById(before);
        if (!anchor || anchor.threadId !== threadId) {
          throw new AppError(
            `Message not found: ${before}`,
            ErrorCode.NOT_FOUND,
            HTTP_STATUS.NOT_FOUND
          );
        }
        const messages = await Messages.listForThreadRead(threadId, {
          limit,
          beforeId: anchor.id,
        });
        const first = messages[0];
        const hasMoreOlder = first
          ? await Messages.hasOlderThan(threadId, { createdAt: first.createdAt, id: first.id })
          : false;
        sendOk(res, { messages, hasMoreOlder, hasMoreNewer: true });
        return;
      }

      if (after) {
        const anchor = await Messages.findById(after);
        if (!anchor || anchor.threadId !== threadId) {
          throw new AppError(
            `Message not found: ${after}`,
            ErrorCode.NOT_FOUND,
            HTTP_STATUS.NOT_FOUND
          );
        }
        const messages = await Messages.listAfter(threadId, {
          limit,
          afterCreatedAt: anchor.createdAt,
          afterId: anchor.id,
        });
        const last = messages[messages.length - 1];
        const hasMoreNewer = last
          ? await Messages.hasNewerThan(threadId, { createdAt: last.createdAt, id: last.id })
          : false;
        sendOk(res, { messages, hasMoreOlder: true, hasMoreNewer });
        return;
      }

      const messages = await Messages.listForThreadRead(threadId, { limit });
      const first = messages[0];
      const hasMoreOlder = first
        ? await Messages.hasOlderThan(threadId, { createdAt: first.createdAt, id: first.id })
        : false;
      sendOk(res, { messages, hasMoreOlder, hasMoreNewer: false });
    })
  );

  router.patch(
    '/:threadId/messages/:messageId',
    asyncHandler(async (req, res) => {
      const { threadId, messageId } = req.params;
      const thread = await Threads.findById(threadId);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const { content } = req.body as { content?: string };
      if (typeof content !== 'string') {
        throw new AppError(
          'content is required and must be a string',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      // The URL names the thread: a message from another thread is reported
      // as missing, the same as the `before`/`after` anchors above.
      const existing = await Messages.findById(messageId);
      if (!existing || existing.threadId !== threadId) {
        throw new AppError('Message not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      const updated = await Messages.update(messageId, { content });
      if (!updated) {
        throw new AppError('Message not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      // Other open views of the thread hold the old content until told. The
      // messages table has no updated_at column, so the stamp is the moment
      // this save returned.
      emitThreadMessageUpdated({
        threadId,
        id: updated.id,
        content: updated.content,
        updatedAt: isoNow(),
      });
      sendOk(res, updated);
    })
  );

  router.get(
    '/:id/activity-log',
    asyncHandler(async (req, res) => {
      const thread = await Threads.findById(req.params.id);
      if (!thread) {
        throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }

      const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isFinite(rawLimit) ? clamp(rawLimit, 1, 300) : 300;

      const participants = await ThreadParticipants.listByThread(req.params.id);
      const activeAgentIds = participants
        .map((p) => participantAgentId(p))
        .filter((id): id is string => Boolean(id));

      const logs = await AgentActivityLog.listThreadActivity({
        threadId: req.params.id,
        agentIds: activeAgentIds,
        limit,
      });

      sendOk(res, logs);
    })
  );
}
