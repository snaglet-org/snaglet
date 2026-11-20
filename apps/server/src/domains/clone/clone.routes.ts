/**
 * Clone API route — copy/paste of workspace-tree nodes.
 *
 * POST /api/clone
 *   body: {
 *     sourceId: string,                      // node to copy (doc | container | thread)
 *     targetContainerId?: string | null,     // paste target; omit = source's parent, null = root
 *     sortOrder?: number,                    // position under the target (default: append)
 *     allowArchived?: boolean                // allow an archived copy source (default false)
 *   }
 *   201: { root: WorkspaceNodeSnapshot, count: number }
 *
 * The heavy lifting (recursive clone, ref remap, transaction, realtime + embed)
 * lives in NodeCloneService.cloneNode.
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendCreated } from '@server/utils/http';
import { AppError } from '@snaglet/shared/utils';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';
import { cloneNode } from './NodeCloneService';

const router = Router();

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : '';
    if (!sourceId) {
      throw new AppError(
        'sourceId is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    // targetContainerId tri-state: absent → default (source's parent); null →
    // root; non-empty string → that container. An empty string is treated as
    // root so the client can pass `""` for a root paste.
    let targetContainerId: string | null | undefined;
    if (!('targetContainerId' in body)) {
      targetContainerId = undefined;
    } else if (body.targetContainerId === null) {
      targetContainerId = null;
    } else if (typeof body.targetContainerId === 'string') {
      targetContainerId = body.targetContainerId.length > 0 ? body.targetContainerId : null;
    } else {
      throw new AppError(
        'targetContainerId must be a string or null',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const sortOrder =
      typeof body.sortOrder === 'number' && Number.isInteger(body.sortOrder) && body.sortOrder >= 0
        ? body.sortOrder
        : undefined;

    const allowArchived = body.allowArchived === true;

    const result = await cloneNode({ sourceId, targetContainerId, sortOrder, allowArchived });
    sendCreated(res, result);
  })
);

export default router;
