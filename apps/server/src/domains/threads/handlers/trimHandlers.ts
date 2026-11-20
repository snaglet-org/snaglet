/**
 * Thread history trimming routes.
 *
 *   GET  /:id/trim/stats    canonical thread totals for the top-bar label
 *   POST /:id/trim/preview  resolve a proposed cut → counts, bytes, plan token
 *   POST /:id/trim/apply    transactional delete of the exact reviewed plan
 *
 * Every number the UI shows originates here; nothing numeric the client sends
 * is ever trusted. `apply` accepts only boundary message ids plus the signed
 * token from `preview`, and re-derives the deletion from live rows.
 *
 * There is no "mode" parameter. A plan is a retained interval, and which sides
 * it cuts follows from where that interval sits — so the response reports a
 * derived `sides`, and no request can declare an intent its own boundaries
 * contradict.
 */

import type { Router } from 'express';
import { AppError, isRecord } from '@snaglet/shared/utils';
import {
  ErrorCode,
  HTTP_STATUS,
  type ThreadTrimApplyRequest,
  type ThreadTrimmedBroadcast,
  type ThreadTrimPreviewRequest,
} from '@snaglet/shared/types';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { wsService } from '@server/services/WebSocketService';
import { applyThreadTrim, getThreadTrimStats, previewThreadTrim } from '../trim/threadTrimService';

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

/** Booleans arrive as real booleans; anything else is a client bug, not a default. */
function readBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw badRequest(`\`${key}\` must be a boolean.`);
  return value;
}

function readOptionalIndex(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest(`\`${key}\` must be a non-negative number.`);
  }
  return Math.trunc(value);
}

function readOptionalId(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`\`${key}\` must be a non-empty string.`);
  }
  return value;
}

function readRequiredId(body: Record<string, unknown>, key: string): string {
  const value = readOptionalId(body, key);
  if (value === undefined) throw badRequest(`\`${key}\` is required.`);
  return value;
}

function readBody(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw badRequest('A JSON object body is required.');
  return raw;
}

export function registerTrimRoutes(router: Router): void {
  router.get(
    '/:id/trim/stats',
    asyncHandler(async (req, res) => {
      sendOk(res, await getThreadTrimStats(req.params.id));
    })
  );

  router.post(
    '/:id/trim/preview',
    asyncHandler(async (req, res) => {
      const body = readBody(req.body);
      const request: ThreadTrimPreviewRequest = {
        removeSummaries: readBoolean(body, 'removeSummaries'),
      };
      const firstIndex = readOptionalIndex(body, 'firstRetainedIndex');
      const lastIndex = readOptionalIndex(body, 'lastRetainedIndex');
      const firstId = readOptionalId(body, 'firstRetainedMessageId');
      const lastId = readOptionalId(body, 'lastRetainedMessageId');
      if (firstIndex !== undefined) request.firstRetainedIndex = firstIndex;
      if (lastIndex !== undefined) request.lastRetainedIndex = lastIndex;
      if (firstId !== undefined) request.firstRetainedMessageId = firstId;
      if (lastId !== undefined) request.lastRetainedMessageId = lastId;

      sendOk(res, await previewThreadTrim(req.params.id, request));
    })
  );

  router.post(
    '/:id/trim/apply',
    asyncHandler(async (req, res) => {
      const body = readBody(req.body);
      const request: ThreadTrimApplyRequest = {
        firstRetainedMessageId: readRequiredId(body, 'firstRetainedMessageId'),
        lastRetainedMessageId: readRequiredId(body, 'lastRetainedMessageId'),
        removeSummaries: readBoolean(body, 'removeSummaries'),
        token: readRequiredId(body, 'token'),
      };

      const result = await applyThreadTrim(req.params.id, request);

      // Same per-thread channel the clear/compact broadcasts use, so every open
      // viewer drops the deleted rows instead of holding a stale transcript
      // that would reappear on reconnect. Typed as the shared broadcast
      // interface so the payload cannot drift away from what clients decode —
      // `anchorMessageId` in particular is what puts the user back at the cut.
      const broadcast: ThreadTrimmedBroadcast = {
        threadId: result.threadId,
        sides: result.sides,
        removedMessages: result.removed.messages,
        removedSummaries: result.removed.summaries,
        removedRuns: result.removed.runs,
        removedActivity: result.removed.activity,
        firstRetainedMessageId: result.firstRetainedMessageId,
        lastRetainedMessageId: result.lastRetainedMessageId,
        anchorMessageId: result.anchorMessageId,
      };
      wsService.broadcastToChannel(req.params.id, {
        type: 'socket:thread:trimmed',
        payload: broadcast,
      });

      sendOk(res, result);
    })
  );
}
