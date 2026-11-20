/**
 * Memories API routes
 *
 * GET    /api/memories?agentId=             — list memories
 * GET    /api/memories/stats?agentId=       — memory stats ({ total })
 * GET    /api/memories/proposed?threadId=   — proposals awaiting approval in a thread
 * POST   /api/memories/:id/approve         — approve a proposal (it becomes active)
 * GET    /api/memories/:id                  — get single memory (+ agentName, sourceThreadTitle)
 * POST   /api/memories                      — manually create
 * POST   /api/memories/search               — hybrid search
 * PATCH  /api/memories/:id                  — update
 * DELETE /api/memories/:id                  — hard delete
 */

import { Router } from 'express';
import { memoryService } from '@server/services/MemoryService';
import { asyncHandler } from '@server/middleware';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';
import { AppError, clampInt } from '@snaglet/shared/utils';
import { sendOk, sendCreated } from '@server/utils/http';

const router = Router();

/** Largest page the list returns; the per-thread memory panel asks for 200. */
const MAX_LIST_LIMIT = 500;

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const agentId = req.query.agentId as string;
    if (!agentId) {
      throw new AppError(
        'agentId is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    // Clamped so a malformed or negative value never reaches SQL as
    // `LIMIT NaN` / `LIMIT -1` (a 500); absent keeps the model default.
    const limit = req.query.limit ? clampInt(req.query.limit, 50, 1, MAX_LIST_LIMIT) : undefined;
    const offset = req.query.offset
      ? clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      : undefined;
    // Optional thread scoping. When set, list narrows to memories the
    // agent recorded inside this thread (source_thread_id). Drives the
    // per-thread memory panel in the thread settings → Agents tab.
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : undefined;

    const memories = await memoryService.list(agentId, { limit, offset, threadId });
    sendOk(res, memories);
  })
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const agentId = req.query.agentId as string;
    if (!agentId) {
      throw new AppError(
        'agentId is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const stats = await memoryService.getStats(agentId);
    sendOk(res, stats);
  })
);

router.get(
  '/proposed',
  asyncHandler(async (req, res) => {
    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : '';
    if (!threadId) {
      throw new AppError(
        'threadId is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    sendOk(res, await memoryService.listProposed(threadId));
  })
);

router.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const result = await memoryService.approveProposed(req.params.id);
    if (result.status === 'not_found') {
      throw new AppError('Memory not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (result.status === 'not_proposed') {
      throw new AppError(
        'Memory is not awaiting approval',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.CONFLICT
      );
    }
    sendOk(res, result.memory);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    // The detail row also carries the agent's name and the source thread's
    // title, so the memory preview's chips read as names, not "Agent".
    const memory = await memoryService.getDetailById(req.params.id);
    if (!memory) {
      throw new AppError('Memory not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, memory);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { agentId, key, content, threadId } = req.body as {
      agentId?: string;
      key?: string;
      content?: string;
      threadId?: string;
    };
    if (!agentId || !key || !content) {
      throw new AppError(
        'agentId, key, and content are required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const result = await memoryService.store({ agentId, key, content, threadId });
    sendCreated(res, result);
  })
);

router.post(
  '/search',
  asyncHandler(async (req, res) => {
    const { agentId, query, limit, threadId } = req.body as {
      agentId?: string;
      query?: string;
      limit?: number;
      threadId?: string;
    };
    if (!agentId || !query) {
      throw new AppError(
        'agentId and query are required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const results = await memoryService.recall({ agentId, query, limit, threadId });
    sendOk(res, results);
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { key, content } = req.body as {
      key?: string;
      content?: string;
    };
    const updated = await memoryService.update(req.params.id, {
      key,
      content,
    });
    if (!updated) {
      throw new AppError('Memory not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, updated);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const memory = await memoryService.getById(req.params.id);
    if (!memory) {
      throw new AppError('Memory not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    // memory.agentId/memberId are the row's owner (exactly one is set).
    // forget() deletes by id and ignores the owner; it is passed for typing.
    await memoryService.forget({
      agentId: memory.agentId ?? undefined,
      memberId: memory.memberId ?? undefined,
      memoryId: req.params.id,
    });
    sendOk(res, { id: req.params.id });
  })
);

export default router;
